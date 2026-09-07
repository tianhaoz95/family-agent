import { config } from "../config.js";
import { guardedFetch, WebFetchError } from "./fetch.js";

// Web search behind one small provider abstraction. Off unless an admin sets
// FAMILY_AGENT_WEB_SEARCH_PROVIDER — see docs/DECISIONS.md → "Web access".
//
//   searxng  — the family runs their own metasearch instance (queries don't
//              go straight to a big engine).  FAMILY_AGENT_WEB_SEARCH_URL
//   tavily   — an LLM-oriented search API, one key, queries leave the box.
//   brave    — Brave's independent index, one key.
//   ddg      — DuckDuckGo's lite HTML, no key, fragile (best-effort fallback).
//   none     — the whole web capability is off.

export type SearchProvider = "searxng" | "tavily" | "brave" | "ddg" | "none";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function webEnabled(): boolean {
  return config.webSearchProvider !== "none";
}

export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const n = Math.min(Math.max(limit, 1), 10);
  switch (config.webSearchProvider) {
    case "searxng":
      return searxng(q, n);
    case "tavily":
      return tavily(q, n);
    case "brave":
      return brave(q, n);
    case "ddg":
      return ddg(q, n);
    default:
      throw new WebFetchError("No web search provider is configured on this server.");
  }
}

async function readJson(res: Response): Promise<any> {
  if (!res.ok) throw new WebFetchError(`Search request failed (HTTP ${res.status}).`);
  return res.json();
}

async function searxng(q: string, n: number): Promise<SearchResult[]> {
  if (!config.webSearchUrl) throw new WebFetchError("FAMILY_AGENT_WEB_SEARCH_URL is not set for the searxng provider.");
  const base = config.webSearchUrl.replace(/\/$/, "");
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=json&safesearch=1`;
  const data = await readJson(await guardedFetch(url, { headers: { accept: "application/json" } }));
  return (data.results ?? [])
    .slice(0, n)
    .map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.content ?? "") }))
    .filter((r: SearchResult) => r.url);
}

async function tavily(q: string, n: number): Promise<SearchResult[]> {
  if (!config.webSearchApiKey) throw new WebFetchError("FAMILY_AGENT_WEB_SEARCH_API_KEY is not set for the tavily provider.");
  const data = await readJson(
    await guardedFetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: config.webSearchApiKey, query: q, max_results: n, search_depth: "basic" }),
    })
  );
  return (data.results ?? [])
    .slice(0, n)
    .map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.content ?? "") }))
    .filter((r: SearchResult) => r.url);
}

async function brave(q: string, n: number): Promise<SearchResult[]> {
  if (!config.webSearchApiKey) throw new WebFetchError("FAMILY_AGENT_WEB_SEARCH_API_KEY is not set for the brave provider.");
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`;
  const data = await readJson(
    await guardedFetch(url, { headers: { accept: "application/json", "x-subscription-token": config.webSearchApiKey } })
  );
  return (data.web?.results ?? [])
    .slice(0, n)
    .map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.description ?? "") }))
    .filter((r: SearchResult) => r.url);
}

// DuckDuckGo has no official API. The lite HTML endpoint is key-free but
// expects a form POST and does light bot-detection — it's the zero-setup
// fallback, deliberately best-effort. For anything load-bearing, run a
// SearXNG instance or use a search API (see docs/DECISIONS.md).
async function ddg(q: string, n: number): Promise<SearchResult[]> {
  const res = await guardedFetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      referer: "https://lite.duckduckgo.com/",
    },
    body: `q=${encodeURIComponent(q)}&kl=us-en`,
  });
  if (!res.ok) throw new WebFetchError(`DuckDuckGo request failed (HTTP ${res.status}).`);
  const html = await res.text();
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(strip(sm[1]));
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && out.length < n) {
    let href = lm[1];
    const dd = /uddg=([^&]+)/.exec(href);
    if (dd) href = decodeURIComponent(dd[1]);
    if (!/^https?:\/\//i.test(href)) continue;
    out.push({ title: strip(lm[2]), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
