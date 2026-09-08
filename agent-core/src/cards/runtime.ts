// The JS injected into every card document (see wrap.ts). Three jobs:
//  1. measure the content and report its height to the host (iframe postMessage
//     on desktop, an AndroidCard bridge on Android) so the frame can size itself;
//  2. trap runtime errors so a broken snippet degrades to a small notice instead
//     of a blank frame, and tell the host;
//  3. offer a tiny optional `Card` helper (palette, money formatting, a compact
//     SVG line/bar chart) that lifts a weak model's floor without caging a
//     capable one — a snippet is free to ignore it and write raw canvas/SVG.
//
// Kept as one hand-written string (no build step, like tts/asr/wasm glue
// elsewhere). Runs before the model's own <script>.

export const CARD_RUNTIME = String.raw`
(function () {
  "use strict";

  // ---- optional helper API ----
  var PALETTE = ["#0075de", "#e8833a", "#3aa675", "#8c6fd6", "#d6486f", "#c9a227", "#4b9fd6"];
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

  function svgChart(kind, opts) {
    opts = opts || {};
    var labels = opts.labels || [];
    var series = opts.series || [];
    if (series.length && typeof series[0] === "number") series = [{ name: "", data: series }];
    var W = 560, H = 220, PL = 44, PR = 14, PT = 16, PB = 28;
    var all = [];
    series.forEach(function (s) { (s.data || []).forEach(function (v) { all.push(num(v)); }); });
    var max = all.length ? Math.max.apply(null, all) : 1;
    var min = Math.min(0, all.length ? Math.min.apply(null, all) : 0);
    if (max === min) max = min + 1;
    var n = labels.length || (series[0] && series[0].data.length) || 1;
    var x = function (i) { return PL + (i / Math.max(1, n - 1)) * (W - PL - PR); };
    var xBand = function (i) { return PL + (i + 0.5) / n * (W - PL - PR); };
    var y = function (v) { return PT + (1 - (num(v) - min) / (max - min)) * (H - PT - PB); };
    var parts = ['<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="' + esc(opts.title || kind + " chart") + '" style="max-width:100%;font:11px var(--font-sans)">'];
    // gridlines + y labels
    for (var g = 0; g <= 4; g++) {
      var gv = min + (g / 4) * (max - min), gy = y(gv);
      parts.push('<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="rgba(0,0,0,.08)"/>');
      parts.push('<text x="' + (PL - 6) + '" y="' + (gy + 3) + '" text-anchor="end" fill="rgba(0,0,0,.45)">' + esc(fmtNum(gv, opts.unit)) + "</text>");
    }
    series.forEach(function (s, si) {
      var color = s.color || PALETTE[si % PALETTE.length];
      var data = s.data || [];
      if (kind === "bar") {
        var bw = (W - PL - PR) / n * 0.6 / series.length;
        data.forEach(function (v, i) {
          var bx = xBand(i) - (series.length * bw) / 2 + si * bw;
          var by = y(Math.max(0, v)), bh = Math.abs(y(v) - y(0));
          parts.push('<rect x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="' + color + '"/>');
        });
      } else {
        var d = data.map(function (v, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join(" ");
        if (kind === "area") {
          parts.push('<path d="' + d + " L" + x(data.length - 1).toFixed(1) + " " + y(0).toFixed(1) + " L" + x(0).toFixed(1) + " " + y(0).toFixed(1) + ' Z" fill="' + color + '" fill-opacity=".12"/>');
        }
        parts.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
        data.forEach(function (v, i) { parts.push('<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.5" fill="' + color + '"/>'); });
      }
    });
    // x labels
    labels.forEach(function (l, i) {
      var lx = (kind === "bar" ? xBand(i) : x(i));
      parts.push('<text x="' + lx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" fill="rgba(0,0,0,.55)">' + esc(l) + "</text>");
    });
    parts.push("</svg>");
    var wrap = '<figure style="margin:0">';
    if (opts.title) wrap += '<figcaption style="font-weight:600;color:var(--text);margin-bottom:6px">' + esc(opts.title) + "</figcaption>";
    wrap += parts.join("") + "</figure>";
    return wrap;
  }
  function fmtNum(v, unit) {
    var s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toString();
    return unit === "$" ? "$" + s : unit ? s + unit : s;
  }

  var Card = {
    palette: PALETTE,
    money: function (n) { return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
    lineChart: function (opts) { return svgChart("line", opts); },
    areaChart: function (opts) { return svgChart("area", opts); },
    barChart: function (opts) { return svgChart("bar", opts); },
    /** Render an HTML string into the given selector (or document.body). */
    mount: function (html, sel) { var el = sel ? document.querySelector(sel) : document.body; if (el) el.innerHTML = html; report(); },
  };
  window.Card = Card;

  // ---- host communication ----
  function report() {
    var h = Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.body ? document.body.getBoundingClientRect().height : 0
    )) + 2;
    try { parent.postMessage({ type: "card-height", h: h }, "*"); } catch (e) {}
    try { if (window.AndroidCard && window.AndroidCard.postHeight) window.AndroidCard.postHeight(h); } catch (e) {}
  }
  var reportSoon = (function () { var t; return function () { clearTimeout(t); t = setTimeout(report, 40); }; })();

  window.addEventListener("error", function (e) {
    var msg = (e && (e.message || (e.error && e.error.message))) || "script error";
    try {
      var b = document.body || document.documentElement;
      if (b && !b.querySelector(".__card_err")) {
        var d = document.createElement("div");
        d.className = "__card_err";
        d.style.cssText = "margin-top:10px;font:12px var(--font-sans);color:var(--danger,#e32d14)";
        d.textContent = "This card couldn't finish rendering.";
        b.appendChild(d);
      }
    } catch (_) {}
    try { parent.postMessage({ type: "card-error", message: String(msg) }, "*"); } catch (_) {}
    reportSoon();
  });

  function start() {
    report();
    if (window.ResizeObserver) { try { new ResizeObserver(reportSoon).observe(document.body); } catch (e) {} }
    window.addEventListener("load", report);
    [80, 250, 600, 1200].forEach(function (ms) { setTimeout(report, ms); });
    // Answer the host's liveness ping.
    window.addEventListener("message", function (e) {
      if (e && e.data && e.data.type === "card-ping") {
        try { parent.postMessage({ type: "card-pong" }, "*"); } catch (_) {}
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;
