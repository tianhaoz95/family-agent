import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";

// The ONLY module in agent-core that makes an outbound request to a
// non-localhost host. Everything else (Ollama, the tools server) talks to
// 127.0.0.1. Enforced by test/web.egress.test.ts — if you need to fetch
// something off-box, it goes through here or a sibling in src/web/.
//
// This is the deliberate, bounded exception to "nothing leaves the machine"
// (docs/DECISIONS.md → "Web access"): opt-in (an admin sets a search
// provider), logged (every call writes an activity line at the tool layer),
// and guarded — a model-chosen URL can't be turned into an SSRF into the
// family's private network.

const USER_AGENT =
  "FamilyAgent/1.0 (+local-first home assistant; https://github.com/)";

/** A fetched, readability-reduced web page handed back to the research agent. */
export interface FetchedPage {
  url: string;
  status: number;
  title: string;
  /** Tag-stripped, whitespace-collapsed, truncated page text. */
  text: string;
  truncated: boolean;
}

export class WebFetchError extends Error {}

// ---- SSRF guard ----------------------------------------------------------

const BLOCKED_HOST_SUFFIX = [".local", ".internal", ".lan", ".home", ".localdomain"];

function hostnameIsBlocked(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (BLOCKED_HOST_SUFFIX.some((s) => h.endsWith(s))) return true;
  return false;
}

/** True for loopback / private / link-local / CGNAT / metadata addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p;
    if (a === 0 || a === 127) return true; // this-host, loopback
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet
    if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const h = ip.toLowerCase();
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe80:") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not a recognisable IP → refuse
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new WebFetchError(`"${rawUrl}" is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new WebFetchError("Only http and https URLs can be opened.");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (![80, 443, 8080, 8443].includes(port)) {
    throw new WebFetchError(`Port ${port} is not allowed — only 80, 443, 8080, 8443.`);
  }
  if (hostnameIsBlocked(u.hostname)) {
    throw new WebFetchError(`"${u.hostname}" looks like a private/internal host and can't be opened.`);
  }
  // If the host is a literal IP, check it directly; otherwise resolve every
  // address it points at and refuse if any is private (defeats DNS rebinding,
  // since we also disable redirects).
  const literals = isIP(u.hostname) ? [u.hostname] : [];
  const resolved = literals.length
    ? literals
    : (await lookup(u.hostname, { all: true }).catch(() => {
        throw new WebFetchError(`Could not resolve "${u.hostname}".`);
      })).map((r) => r.address);
  if (resolved.length === 0) throw new WebFetchError(`Could not resolve "${u.hostname}".`);
  for (const addr of resolved) {
    if (isPrivateAddress(addr)) {
      throw new WebFetchError(`"${u.hostname}" resolves to a private address (${addr}) and can't be opened.`);
    }
  }
  return u;
}

// ---- HTML → text (dependency-free) --------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"', hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

const BLOCK_TAGS = /<\/?(p|div|section|article|header|footer|main|br|hr|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure)\b[^>]*>/gi;

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

  let body = html;
  // Drop the stuff that's never readable content.
  body = body.replace(/<!--[\s\S]*?-->/g, " ");
  body = body.replace(/<(script|style|noscript|template|svg|head|nav|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Prefer <main> or <article> if the page has one.
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main) body = main[2];
  // Block-level tags become line breaks; everything else is dropped.
  body = body.replace(BLOCK_TAGS, "\n");
  body = body.replace(/<[^>]+>/g, "");
  body = decodeEntities(body);
  body = body
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, text: body };
}

// ---- the fetch ---------------------------------------------------------

/** Low-level guarded fetch — for a search provider talking to a KNOWN host
 *  (the SSRF guard still runs, so an operator's SearXNG URL can't point at
 *  something private). Returns the raw Response; caller reads the body. */
export async function guardedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await assertPublicUrl(url);
  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(config.webFetchTimeoutMs),
    headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
  });
}

/** Fetch a model-chosen URL and return its readable text. Redirects are NOT
 *  followed — the caller (open_page) is told to call again on the Location. */
export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  const u = await assertPublicUrl(rawUrl);

  if (config.webDenyDomains.some((d) => hostMatches(u.hostname, d))) {
    throw new WebFetchError(`"${u.hostname}" is on this server's web block-list.`);
  }
  if (config.webAllowDomains.length && !config.webAllowDomains.some((d) => hostMatches(u.hostname, d))) {
    throw new WebFetchError(`"${u.hostname}" is not on this server's web allow-list.`);
  }

  let res: Response;
  try {
    res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(config.webFetchTimeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new WebFetchError("The page took too long to load.");
    throw new WebFetchError(`Could not load the page (${(err as Error).message}).`);
  }

  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    const abs = loc ? new URL(loc, u).toString() : "";
    return {
      url: u.toString(),
      status: res.status,
      title: "",
      text: abs
        ? `This page redirects to ${abs}\nCall open_page again with that URL to follow it.`
        : `This page returned a ${res.status} redirect with no destination.`,
      truncated: false,
    };
  }

  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const isText = type.includes("html") || type.includes("xml") || type.includes("text/plain") || type.includes("json");
  if (!isText) {
    throw new WebFetchError(`That URL is a ${type || "non-text"} file, not a web page.`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > 8 * 1024 * 1024) {
    throw new WebFetchError("That page is too large to read.");
  }

  const raw = await res.text();
  const capped = raw.slice(0, config.webFetchMaxBytes);
  const truncatedBody = raw.length > capped.length;

  let title = "";
  let text: string;
  if (type.includes("html") || type.includes("xml")) {
    const extracted = htmlToText(capped);
    title = extracted.title;
    text = extracted.text;
  } else {
    text = capped.replace(/[ \t ]+/g, " ");
  }
  const truncatedText = text.length > config.webFetchMaxChars;
  return {
    url: u.toString(),
    status: res.status,
    title,
    text: truncatedText ? text.slice(0, config.webFetchMaxChars) + "\n…(truncated)" : text,
    truncated: truncatedBody || truncatedText,
  };
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*?\.?/, "");
  return h === p || h.endsWith("." + p);
}
