#!/usr/bin/env node
// Generates the README header lockup: the app mark + "Family Agent" wordmark,
// on the warm-paper card from DESIGN.md, with a light spring entrance.
// Output: assets/header.svg (self-contained — the Inter latin subset is
// embedded) and a rasterized assets/header.png fallback.
//
//   node scripts/build-readme-header.mjs
//
// Re-run if the palette / wordmark / font changes. Nothing else depends on it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");
mkdirSync(OUT, { recursive: true });

// Inter, latin subset (~48 KB) — the same file the desktop bundles
// (@fontsource-variable/inter). Embedded into the SVG so the header renders as
// real Inter on GitHub with no external request. Run `npm i` first if missing.
const fontCandidates = [
  join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  join(ROOT, "desktop/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
];
const fontPath = fontCandidates.find(existsSync);
if (!fontPath) {
  console.error("Inter woff2 not found — run `npm i` at the repo root first.");
  process.exit(1);
}
const woff2 = readFileSync(fontPath).toString("base64");

// Palette — sampled from logo.png, matches DESIGN.md's accent cast.
const PAPER = "#f6f5f4";
const INK = "#1b1a18";
const MUTED = "#6f6a65";
const DARK = "#33302d";
const CORAL = "#f64932";
const AMBER = "#e89d01";
const BLUE = "#0075de";

const W = 820;
const H = 208;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Family Agent">
  <title>Family Agent</title>
  <defs>
    <style>
      @font-face{
        font-family:'InterEmbedded';
        src:url(data:font/woff2;base64,${woff2}) format('woff2');
        font-weight:100 900;font-display:block;
      }
      /* Resting state is the FINAL state, so a renderer that doesn't run CSS
         animations (resvg, when this is rasterized) still shows the finished
         lockup. The entrance lives entirely in the keyframes + fill-mode:both. */
      .word,.tag{font-family:'InterEmbedded','Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
      .word{font-weight:620;letter-spacing:-2.3px;fill:${INK}}
      .tag{font-weight:440;letter-spacing:.1px;fill:${MUTED}}

      .tile{transform-box:fill-box;transform-origin:center;
        animation:pop .55s cubic-bezier(.2,.85,.25,1.1) .06s both}
      .c{transform-box:fill-box;transform-origin:center;
        animation:popc .5s cubic-bezier(.34,1.56,.64,1) both}
      .c1{animation-delay:.24s}.c2{animation-delay:.35s}.c3{animation-delay:.46s}.c4{animation-delay:.57s}
      .mark{animation:float 7s ease-in-out 1.6s infinite}
      .word{animation:rise .62s cubic-bezier(.2,.7,.2,1) .72s both}
      .tag{animation:rise .6s cubic-bezier(.2,.7,.2,1) .92s both}
      .rule{transform-box:fill-box;transform-origin:left;
        animation:grow .7s cubic-bezier(.2,.7,.2,1) .8s both}

      @keyframes pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
      @keyframes popc{from{opacity:0;transform:scale(0)}60%{opacity:1}to{opacity:1;transform:scale(1)}}
      @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:translateY(0)}}
      @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
      @keyframes float{50%{transform:translateY(-2.5px)}}

      @media (prefers-reduced-motion:reduce){
        .tile,.c,.word,.tag,.rule,.mark{animation:none!important;opacity:1!important;transform:none!important}
      }
    </style>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#2a2420" flood-opacity="0.14"/>
    </filter>
    <clipPath id="tileClip"><rect x="34" y="38" width="132" height="132" rx="34"/></clipPath>
  </defs>

  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="${PAPER}"
        stroke="#000" stroke-opacity="0.055"/>

  <g class="mark">
    <g class="tile">
      <rect x="34" y="38" width="132" height="132" rx="34" fill="#fff" filter="url(#soft)"
            stroke="#000" stroke-opacity="0.06"/>
    </g>
    <g clip-path="url(#tileClip)">
      <g transform="translate(16.6,16.5) scale(0.678)">
        <circle class="c c1" cx="96"  cy="150" r="56" fill="${DARK}"/>
        <circle class="c c2" cx="165" cy="100" r="41" fill="${CORAL}"/>
        <circle class="c c3" cx="172" cy="166" r="38" fill="${AMBER}"/>
        <circle class="c c4" cx="137" cy="135" r="23" fill="${BLUE}"/>
      </g>
    </g>
  </g>

  <text class="word" x="204" y="111" font-size="57">Family Agent</text>
  <rect class="rule" x="206" y="129" width="146" height="2.5" rx="1.25" fill="${BLUE}"/>
  <text class="tag" x="206" y="159" font-size="15.5">Local-first family organizer &#183; runs on hardware you own</text>
</svg>
`;

writeFileSync(join(OUT, "header.svg"), svg);
console.log("wrote assets/header.svg", (svg.length / 1024).toFixed(0) + " KB");

// Rasterize a PNG fallback (2x). sharp renders the SVG via resvg, which reads
// the embedded @font-face, so the wordmark is real Inter here too.
const sharp = (await import("sharp")).default;
await sharp(Buffer.from(svg), { density: 200 })
  .resize(W * 2)
  .png()
  .toFile(join(OUT, "header.png"));
console.log("wrote assets/header.png");
