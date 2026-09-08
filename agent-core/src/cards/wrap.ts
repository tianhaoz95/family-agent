import { CARD_RUNTIME } from "./runtime.js";

// Turns the model's `<body>` fragment into a full, self-contained, sandboxed
// card document. We store only the fragment (small, on the message row) and
// wrap at read time so this shell can evolve without re-storing old cards.
// See docs/DECISIONS.md → "AI-generated HTML cards".

export const MAX_CARD_FRAGMENT = 32_000;
export const MAX_CARD_TITLE = 80;

// The card iframe runs with a unique opaque origin (sandbox="allow-scripts",
// NO allow-same-origin). This CSP additionally kills every network primitive:
// no `connect-src` -> falls back to default-src 'none' -> fetch/XHR/WS/beacon
// all fail; `img-src` has no remote scheme so there's no <img> beacon either.
const CARD_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "base-uri 'none'; " +
  "form-action 'none'";

// A trimmed variant of builder.ts's HOUSE_STYLE — same tokens, but the card is
// small and floats inside the app's own card chrome, so: transparent
// background, tight default padding, no h1 sizing assumptions.
const CARD_STYLE = `
:root{
  --bg:#f6f5f4;--surface:#fff;--border:rgba(0,0,0,.08);--border-strong:rgba(0,0,0,.16);
  --text:#000;--text-muted:rgba(0,0,0,.6);--text-body:#615d59;
  --accent:#0075de;--accent-hover:#0068c4;--accent-soft:#e6f3fe;--danger:#e32d14;
  --r-sm:6px;--r-md:11px;--r-lg:16px;--r-pill:9999px;
  --shadow-sm:0 1px 2px rgba(38,32,26,.04),0 10px 30px -14px rgba(38,32,26,.16);
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{padding:14px 16px;color:var(--text-body);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
h1,h2,h3{color:var(--text);letter-spacing:-.014em;margin:0 0 .4em;line-height:1.25}
h1{font-size:1.1rem;font-weight:600}h2{font-size:1rem;font-weight:600}h3{font-size:.9rem;font-weight:600}
p{margin:0 0 .6em}
a{color:var(--accent)}
button{font:inherit;font-weight:500;cursor:pointer;border-radius:var(--r-md);padding:7px 13px;border:1px solid transparent;background:var(--accent);color:#fff;transition:background .2s ease}
button:hover{background:var(--accent-hover)}
button.secondary{background:var(--accent-soft);color:var(--accent)}
button.ghost{background:transparent;color:var(--text-muted);border-color:var(--border)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-md);padding:7px 10px;max-width:100%}
label{display:block;font-size:.8rem;color:var(--text-muted);margin-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--border)}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);font-weight:600}
ul,ol{margin:0 0 .6em;padding-left:1.3em}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-sm);padding:14px}
`;

export interface CardRecord {
  id: string;
  title: string;
  /** The raw <body> fragment the model wrote — kept for "view code". */
  fragment: string;
}

/** The card as the client needs it: metadata + the fragment + the wrapped,
 *  ready-to-render document. */
export interface RenderedCard extends CardRecord {
  html: string;
}

export function wrapCard(card: CardRecord): RenderedCard {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">
<style>${CARD_STYLE}</style>
<script>${CARD_RUNTIME}</script>
</head><body>
${card.fragment}
</body></html>`;
  return { ...card, html };
}

export interface CardValidation {
  ok: boolean;
  reason?: string;
}

/** Cheap structural checks so an obviously-broken fragment bounces back to the
 *  model for a fix instead of rendering a blank frame. Not a security check —
 *  the sandbox is. */
export function validateCardFragment(fragment: string): CardValidation {
  const f = (fragment ?? "").trim();
  if (!f) return { ok: false, reason: "the html is empty" };
  if (f.length > MAX_CARD_FRAGMENT)
    return { ok: false, reason: `the html is ${f.length} chars; keep it under ${MAX_CARD_FRAGMENT}` };
  if (/<\s*(!doctype|html|head|body)[\s>]/i.test(f))
    return {
      ok: false,
      reason: "send only the inner content — no <html>, <head>, <body> or <!doctype>; those are added for you",
    };
  // Syntax-check any inline <script> so a typo doesn't render a dead card.
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
  // A common mistake: writing `Card.barChart({…})` as text in the markup
  // instead of inside a <script>. It renders as literal text, not a chart.
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
