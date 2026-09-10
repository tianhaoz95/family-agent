#!/usr/bin/env node
// Generates the README promo image — the macOS app + iPhone showing the same
// conversation (the landing-page hero composition), with the headline and a few
// value props set in Inter, on the warm-paper card. Screenshots are recompressed
// and embedded, so assets/promo.svg is self-contained. A .png fallback too.
//
//   node scripts/build-readme-promo.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");
mkdirSync(OUT, { recursive: true });

const sharp = (await import("sharp")).default;

const fontPath = [
  join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  join(ROOT, "desktop/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
].find(existsSync);
if (!fontPath) {
  console.error("Inter woff2 not found — run `npm i` at the repo root first.");
  process.exit(1);
}
const woff2 = readFileSync(fontPath).toString("base64");

// Recompress the two landing-page screenshots down to what the composite needs,
// so the embedded payload stays reasonable (~200 KB total instead of ~1 MB).
async function jpg(path, width, quality = 72) {
  const buf = await sharp(join(ROOT, path)).resize({ width }).jpeg({ quality, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
const shotDesktop = await jpg("site/img/desktop-chat.jpg", 1180);
const shotPhone = await jpg("site/img/chat-reply.jpg", 560);

const PAPER = "#f6f5f4";
const INK = "#1b1a18";
const MUTED = "#6f6a65";
const ACCENT = "#0075de";
const ACCENT_SOFT = "#e9f3fd";

const W = 1240;
const H = 660;

// ---- macOS window: rounded frame + titlebar + traffic lights. Bleeds a little
// off the right edge on purpose, hero-shot style. ----
const win = { x: 470, y: 66, w: 830 };
const winTitle = 26;
const winImgH = Math.round((win.w - 2) * (836 / 1300)); // screenshot aspect
const winH = winTitle + winImgH;

// ---- iPhone: bezel + screen, overlapping the window's lower-right ----
const ph = { x: 1000, y: 224, w: 206 };
const phBezel = 9;
const phScreenW = ph.w - phBezel * 2;
const phScreenH = Math.round(phScreenW * (1913 / 880));
const phH = phScreenH + phBezel * 2;

const chip = (x, y, text) => `
  <g transform="translate(${x} ${y})">
    <rect x="0" y="-15" width="${text.length * 7.2 + 22}" height="24" rx="12" fill="${ACCENT_SOFT}"/>
    <text x="11" y="1" class="chip" font-size="12">${text}</text>
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Family Agent on macOS and iPhone — the same conversation, served by a model on your own laptop">
  <title>Family Agent — local-first family assistant</title>
  <defs>
    <style>
      @font-face{font-family:'InterEmbedded';src:url(data:font/woff2;base64,${woff2}) format('woff2');font-weight:100 900;font-display:block}
      text{font-family:'InterEmbedded','Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
      .eyebrow{fill:${MUTED};font-weight:600;letter-spacing:2px}
      .head{fill:${INK};font-weight:640;letter-spacing:-1.1px}
      .sub{fill:${MUTED};font-weight:420}
      .chip{fill:${ACCENT};font-weight:600}
      .rise{animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
      .d1{animation-delay:.05s}.d2{animation-delay:.14s}.d3{animation-delay:.22s}
      @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion:reduce){.rise{animation:none!important;opacity:1!important;transform:none!important}}
    </style>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="26" flood-color="#2a2420" flood-opacity="0.20"/>
    </filter>
    <filter id="shadowSm" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#2a2420" flood-opacity="0.28"/>
    </filter>
    <clipPath id="winClip"><rect x="${win.x + 1}" y="${win.y + winTitle}" width="${win.w - 2}" height="${winImgH}"/></clipPath>
    <clipPath id="phClip"><rect x="${ph.x + phBezel}" y="${ph.y + phBezel}" width="${phScreenW}" height="${phScreenH}" rx="20"/></clipPath>
  </defs>

  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="24" fill="${PAPER}" stroke="#000" stroke-opacity="0.055"/>

  <!-- copy -->
  <g class="rise d1">
    <text x="56" y="118" class="eyebrow" font-size="12">LOCAL-FIRST &#183; OPEN SOURCE</text>
    <text x="54" y="166" class="head" font-size="35">The family assistant</text>
    <text x="54" y="208" class="head" font-size="35">that never leaves</text>
    <text x="54" y="250" class="head" font-size="35">the house.</text>
    <text x="56" y="300" class="sub" font-size="15.5">Documents, calendar, tasks and passwords &#8212;</text>
    <text x="56" y="322" class="sub" font-size="15.5">kept on a laptop in your home, organized by</text>
    <text x="56" y="344" class="sub" font-size="15.5">a model on that same laptop. No cloud API.</text>
  </g>
  <g class="rise d2">
    ${chip(58, 400, "Runs on your hardware")}
    ${chip(58, 438, "One account per person")}
    ${chip(58, 476, "Encrypted password vault")}
    ${chip(58, 514, "Desktop · Android · iOS")}
  </g>

  <!-- iPhone (drawn first so the mac window overlaps its top-left corner? no —
       phone sits in front, bottom-right) -->
  <g class="rise d3">
    <rect x="${win.x}" y="${win.y}" width="${win.w}" height="${winH}" rx="12" fill="#fff" filter="url(#shadow)"/>
    <path d="M${win.x} ${win.y + 12} a12 12 0 0 1 12 -12 h${win.w - 24} a12 12 0 0 1 12 12 v${winTitle - 12} h-${win.w} z" fill="#ecebe9"/>
    <circle cx="${win.x + 16}" cy="${win.y + 13}" r="4" fill="#ff5f57"/>
    <circle cx="${win.x + 30}" cy="${win.y + 13}" r="4" fill="#febc2e"/>
    <circle cx="${win.x + 44}" cy="${win.y + 13}" r="4" fill="#28c840"/>
    <image xlink:href="${shotDesktop}" x="${win.x + 1}" y="${win.y + winTitle}" width="${win.w - 2}" height="${winImgH}"
           clip-path="url(#winClip)" preserveAspectRatio="xMidYMin slice"/>
    <rect x="${win.x}" y="${win.y}" width="${win.w}" height="${winH}" rx="12" fill="none" stroke="#000" stroke-opacity="0.09"/>
  </g>

  <g class="rise d3">
    <rect x="${ph.x}" y="${ph.y}" width="${ph.w}" height="${phH}" rx="30" fill="#1b1b1d" filter="url(#shadowSm)"/>
    <image xlink:href="${shotPhone}" x="${ph.x + phBezel}" y="${ph.y + phBezel}" width="${phScreenW}" height="${phScreenH}"
           clip-path="url(#phClip)" preserveAspectRatio="xMidYMin slice"/>
    <rect x="${ph.x}" y="${ph.y}" width="${ph.w}" height="${phH}" rx="30" fill="none" stroke="#000" stroke-opacity="0.2"/>
  </g>
</svg>
`;

writeFileSync(join(OUT, "promo.svg"), svg);
console.log("wrote assets/promo.svg", (svg.length / 1024).toFixed(0) + " KB");

await sharp(Buffer.from(svg), { density: 160 })
  .resize(W * 2)
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(join(OUT, "promo.jpg"));
console.log("wrote assets/promo.jpg");
