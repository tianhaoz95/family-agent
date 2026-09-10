#!/usr/bin/env node
// Generates the README "How it's put together" diagram — the four apps + Ollama
// around agent-core, in the same warm-paper / Inter visual language as the
// header (scripts/build-readme-header.mjs). Boxes fade in, the wires draw
// themselves, and a dot flows along each connection to show the direction of
// traffic. Output: assets/architecture.svg (self-contained) + a .png fallback.
//
//   node scripts/build-readme-diagram.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");
mkdirSync(OUT, { recursive: true });

const fontPath = [
  join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  join(ROOT, "desktop/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
].find(existsSync);
if (!fontPath) {
  console.error("Inter woff2 not found — run `npm i` at the repo root first.");
  process.exit(1);
}
const woff2 = readFileSync(fontPath).toString("base64");

const PAPER = "#f6f5f4";
const CARD = "#ffffff";
const INK = "#1b1a18";
const MUTED = "#726c66";
const LINE = "#a49c94";
const ACCENT = "#0075de";
const ACCENT_SOFT = "#eef5fd";

const W = 900;
const H = 300;

/** A labelled box. `n` drives the entrance stagger. */
function box({ x, y, w, h, title, tag, sub, hub = false, n = 0 }) {
  const cx = x + w / 2;
  return `
  <g class="box" style="animation-delay:${(0.06 + n * 0.09).toFixed(2)}s">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"
          fill="${hub ? ACCENT_SOFT : CARD}"
          stroke="${hub ? ACCENT : "#000"}" stroke-opacity="${hub ? 1 : 0.12}"
          stroke-width="${hub ? 1.5 : 1}" filter="url(#soft)"/>
    <text x="${cx}" y="${y + (sub ? (hub ? 34 : 30) : h / 2 + 5)}" text-anchor="middle"
          class="t-title" font-size="${hub ? 17 : 15}">${title}${
    tag ? `<tspan class="t-tag" font-size="12" dx="3">${tag}</tspan>` : ""
  }</text>
    ${sub ? `<text x="${cx}" y="${y + (hub ? 58 : 52)}" text-anchor="middle" class="t-sub" font-size="12.5">${sub}</text>` : ""}
  </g>`;
}

/** A directed wire: the drawn line + arrowhead + a dot that flows along it to
 *  show the direction of traffic. The line "draws itself" via a dash trick with
 *  a constant dash longer than any wire here (no pathLength needed → rasterises
 *  solid). */
function wire({ id, d, label, labelXY, labelAnchor = "middle", delay = 0.55, dur = 2.4 }) {
  return `
  <path id="${id}" class="wire" d="${d}" fill="none" stroke="${LINE}" stroke-width="1.6"
        marker-end="url(#arrow)" style="animation-delay:${delay}s"/>
  <circle r="2.6" fill="${ACCENT}" class="flow">
    <animateMotion dur="${dur}s" repeatCount="indefinite" begin="${(delay + 0.4).toFixed(2)}s" calcMode="linear">
      <mpath xlink:href="#${id}"/>
    </animateMotion>
  </circle>
  ${
    label
      ? `<text x="${labelXY[0]}" y="${labelXY[1]}" text-anchor="${labelAnchor}" class="t-label" font-size="11.5">${label}</text>`
      : ""
  }`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Architecture: desktop, android and ios talk over HTTP to agent-core, which talks to a local Ollama">
  <title>How Family Agent is put together</title>
  <defs>
    <style>
      @font-face{font-family:'InterEmbedded';src:url(data:font/woff2;base64,${woff2}) format('woff2');font-weight:100 900;font-display:block}
      text{font-family:'InterEmbedded','Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
      .t-title{fill:${INK};font-weight:600;letter-spacing:-.2px}
      .t-tag{fill:${MUTED};font-weight:500}
      .t-sub{fill:${MUTED};font-weight:400}
      .t-label{fill:${MUTED};font-weight:500}

      /* Resting state = the finished diagram, so a renderer that ignores CSS
         animation (the .png rasteriser) still shows it complete. The flow dots
         are the exception — a stationary dot mid-wire is just noise, so they
         rest hidden and only a live browser reveals + moves them. */
      .box{animation:boxin .5s cubic-bezier(.2,.8,.3,1) both;transform-box:fill-box;transform-origin:center}
      .wire{stroke-dasharray:400;stroke-dashoffset:0;animation:draw .6s ease both}
      .t-label{animation:fade .5s ease .9s both}
      .flow{opacity:0;animation:fade .6s ease 1s forwards}

      @keyframes boxin{from{opacity:0;transform:translateY(9px) scale(.97)}to{opacity:1;transform:none}}
      @keyframes draw{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}
      @keyframes fade{to{opacity:1}}

      @media (prefers-reduced-motion:reduce){
        .box,.wire,.t-label{animation:none!important;opacity:1!important;transform:none!important}
        .flow{display:none}
      }
    </style>
    <filter id="soft" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="#2a2420" flood-opacity="0.12"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1 L9 5 L1 9" fill="none" stroke="${LINE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>

  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22" fill="${PAPER}" stroke="#000" stroke-opacity="0.055"/>

  <!-- wires first, so the boxes sit on top of the arrowheads -->
  ${wire({
    id: "w-desktop",
    d: "M 204 96 H 334",
    label: "spawns + HTTP",
    labelXY: [269, 84],
    delay: 0.5,
    dur: 2.0,
  })}
  ${wire({
    id: "w-ollama",
    d: "M 628 96 H 714",
    label: "HTTP",
    labelXY: [671, 84],
    delay: 0.62,
    dur: 1.8,
  })}
  ${wire({ id: "w-android", d: "M 366 214 L 481 146", delay: 0.72, dur: 2.6 })}
  ${wire({ id: "w-ios", d: "M 558 214 L 481 146", delay: 0.8, dur: 2.6 })}
  <text x="481" y="200" text-anchor="middle" class="t-label" font-size="11.5"
        style="animation:fade .5s ease .9s both">HTTP &#183; LAN</text>

  ${box({ x: 48, y: 58, w: 156, h: 76, title: "desktop", sub: "Tauri", n: 0 })}
  ${box({
    x: 334,
    y: 48,
    w: 294,
    h: 96,
    title: "agent-core",
    tag: ":4173",
    sub: "Fastify &#183; SQLite &#183; watched folders",
    hub: true,
    n: 1,
  })}
  ${box({ x: 714, y: 58, w: 138, h: 76, title: "Ollama", sub: ":11434 &#183; local model", n: 2 })}
  ${box({ x: 300, y: 214, w: 132, h: 62, title: "android", sub: "Compose", n: 3 })}
  ${box({ x: 494, y: 214, w: 132, h: 62, title: "ios", sub: "SwiftUI", n: 4 })}
</svg>
`;

writeFileSync(join(OUT, "architecture.svg"), svg);
console.log("wrote assets/architecture.svg", (svg.length / 1024).toFixed(0) + " KB");

const sharp = (await import("sharp")).default;
await sharp(Buffer.from(svg), { density: 200 })
  .resize(W * 2)
  .png()
  .toFile(join(OUT, "architecture.png"));
console.log("wrote assets/architecture.png");
