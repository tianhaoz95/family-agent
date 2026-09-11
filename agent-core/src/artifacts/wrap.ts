import { ARTIFACT_RUNTIME } from "./runtime.js";
import type { ArtifactRecord, ArtifactCommentRecord } from "../db.js";

export type { ArtifactRecord };

/** The comment shape the in-page runtime needs to anchor a highlight. */
export interface ArtifactCommentAnchor {
  id: string;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  status: "open" | "resolved";
}

export function toAnchor(c: ArtifactCommentRecord): ArtifactCommentAnchor {
  return { id: c.id, quote: c.quote, prefix: c.prefix, suffix: c.suffix, status: c.status };
}

// Turns the model's `<body>` fragment into a full, self-contained, sandboxed
// HTML page. We store only the fragment (on the `artifacts` row) and wrap it at
// read time so this shell can evolve without re-storing old artifacts. The
// security model is identical to a card (see cards/wrap.ts + docs/DECISIONS.md
// → "AI-generated full-page artifacts"): opaque-origin sandbox, a CSP that
// kills every network primitive. The only differences from a card are cosmetic
// — a full-page look instead of a transparent inline fragment.

export const MAX_ARTIFACT_FRAGMENT = 128_000;
export const MAX_ARTIFACT_TITLE = 120;

// Same sealed CSP as a card: sandbox="allow-scripts" (NO allow-same-origin) →
// unique opaque origin; no `connect-src` → default-src 'none' → fetch / XHR /
// WebSocket / sendBeacon all fail; `img-src` has no remote scheme.
const ARTIFACT_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "base-uri 'none'; " +
  "form-action 'none'";

// The full "warm paper notebook" page look (builder.ts's HOUSE_STYLE, as real
// CSS). Unlike CARD_STYLE this paints a real page: opaque canvas, generous
// padding, a readable measure, proper heading scale.
const ARTIFACT_STYLE = `
:root{
  --bg:#f6f5f4;--surface:#fff;--border:rgba(0,0,0,.08);--border-strong:rgba(0,0,0,.16);
  --text:#000;--text-muted:rgba(0,0,0,.6);--text-body:#33302d;
  --accent:#0075de;--accent-hover:#0068c4;--accent-soft:#e6f3fe;--danger:#e32d14;
  --r-sm:6px;--r-md:11px;--r-lg:16px;--r-pill:9999px;
  --shadow-sm:0 1px 2px rgba(38,32,26,.04),0 10px 30px -14px rgba(38,32,26,.16);
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-serif:"Source Serif 4","Iowan Old Style",Georgia,serif;
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{
  margin:0;padding:32px clamp(20px,5vw,56px);background:var(--bg);color:var(--text-body);
  font:16px/1.6 var(--font-sans);-webkit-font-smoothing:antialiased;
}
.wrap,main,article{max-width:820px;margin:0 auto}
h1,h2,h3,h4{color:var(--text);letter-spacing:-.015em;line-height:1.25;margin:1.6em 0 .5em}
h1{font-size:1.7rem;font-weight:650;margin-top:0}
h2{font-size:1.3rem;font-weight:600}
h3{font-size:1.06rem;font-weight:600}
p{margin:0 0 .9em}
a{color:var(--accent)}
small,.muted{color:var(--text-muted)}
hr{border:none;border-top:1px solid var(--border);margin:1.8em 0}
ul,ol{margin:0 0 1em;padding-left:1.4em}
li{margin:.25em 0}
blockquote{margin:1em 0;padding:.4em 0 .4em 1em;border-left:3px solid var(--accent-soft);color:var(--text-muted)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:14px 16px;overflow:auto}
code{background:var(--accent-soft);border-radius:var(--r-sm);padding:.1em .35em}
pre code{background:none;padding:0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:20px 22px;margin:1.2em 0}
button{font:inherit;font-weight:500;cursor:pointer;border-radius:var(--r-md);padding:9px 15px;border:1px solid transparent;background:var(--accent);color:#fff;transition:background .2s ease}
button:hover{background:var(--accent-hover)}
button.secondary{background:var(--accent-soft);color:var(--accent)}
button.ghost{background:transparent;color:var(--text-muted);border-color:var(--border)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:8px 11px;max-width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,117,222,.22)}
label{display:block;font-size:.85rem;color:var(--text-muted);margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin:1.1em 0;font-size:.95rem}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--border)}
th{font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);font-weight:600}
figure{margin:1.2em 0}
figcaption{font-weight:600;color:var(--text);margin-bottom:6px}
img,svg{max-width:100%}
@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

/** An artifact as a client needs it: metadata + the wrapped, ready-to-render
 *  document under `document`. `html` stays the raw fragment (for "view source"). */
export interface RenderedArtifact extends ArtifactRecord {
  /** The full sandboxed HTML document. */
  document: string;
}

export function wrapArtifact(a: ArtifactRecord, comments: ArtifactCommentAnchor[] = []): RenderedArtifact {
  const seed = JSON.stringify(comments).replace(/</g, "\\u003c");
  const document = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">
<title>${escapeHtml(a.title)}</title>
<style>${ARTIFACT_STYLE}</style>
<script>window.__ARTIFACT_COMMENTS=${seed};</script>
<script>${ARTIFACT_RUNTIME}</script>
</head><body>
${a.html}
</body></html>`;
  return { ...a, document };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export interface ArtifactValidation {
  ok: boolean;
  reason?: string;
}

/** Cheap structural checks so an obviously-broken fragment bounces back to the
 *  model instead of rendering a blank page. Not a security check — the sandbox
 *  is. Mirrors validateCardFragment. */
export function validateArtifactFragment(fragment: string): ArtifactValidation {
  const f = (fragment ?? "").trim();
  if (!f) return { ok: false, reason: "the html is empty" };
  if (f.length > MAX_ARTIFACT_FRAGMENT)
    return { ok: false, reason: `the html is ${f.length} chars; keep it under ${MAX_ARTIFACT_FRAGMENT}` };
  if (/<\s*(!doctype|html|head|body)[\s>]/i.test(f))
    return {
      ok: false,
      reason: "send only the page's body content — no <html>, <head>, <body> or <!doctype>; those are added for you",
    };
  const scripts = f.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of scripts) {
    const code = block.replace(/<script\b[^>]*>/i, "").replace(/<\/script>/i, "");
    try {
      // eslint-disable-next-line no-new-func
      new Function(code);
    } catch (err) {
      return { ok: false, reason: `a <script> has a syntax error: ${(err as Error).message}` };
    }
  }
  const withoutScripts = f.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  if (/\bCard\.\w+\s*\(/.test(withoutScripts)) {
    return {
      ok: false,
      reason:
        "you wrote a `Card.…()` call in the markup — that renders as text. Put it inside a <script>: <div id=\"c\"></div><script>document.getElementById('c').innerHTML = Card.barChart({…})</script>",
    };
  }
  return { ok: true };
}
