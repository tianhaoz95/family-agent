import { CARD_RUNTIME } from "../cards/runtime.js";

// The JS injected into every artifact document, on top of CARD_RUNTIME (the
// error trap + the optional `Card` chart helper — height reporting is harmless
// in a full-page view). This layer adds highlight-and-comment:
//
//  • text selection → a floating "Comment" button → posts the quoted text +
//    a little context to the host (parent iframe on desktop, a WKScriptMessage
//    on iOS, a @JavascriptInterface on Android — same three-transport shape as
//    CARD_RUNTIME's height report);
//  • the host pushes the comment list in (inline `window.__ARTIFACT_COMMENTS`
//    on first paint, then `window.__artifactApi.setComments(...)` after an
//    edit) and this re-marks the anchored ranges;
//  • clicking a highlight tells the host which comment it belongs to.
//
// It runs in the sealed opaque-origin sandbox — no app access, no network. The
// only new surface is the postMessage/bridge, which carries plain strings.

const ANNOTATION_RUNTIME = String.raw`
(function () {
  "use strict";
  var CTX = 48;

  function toHost(msg) {
    try { parent.postMessage(msg, "*"); } catch (e) {}
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.artifact)
        window.webkit.messageHandlers.artifact.postMessage(JSON.stringify(msg));
    } catch (e) {}
    try { if (window.AndroidArtifact && window.AndroidArtifact.post) window.AndroidArtifact.post(JSON.stringify(msg)); } catch (e) {}
  }

  // ---- flatten the body's text so a quote can be located across elements ----
  function textNodes() {
    var out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n; while ((n = w.nextNode())) {
      if (n.nodeValue && n.parentElement && n.parentElement.closest("script,style")) continue;
      out.push(n);
    }
    return out;
  }
  function fullText(nodes) { return nodes.map(function (n) { return n.nodeValue; }).join(""); }

  // Find [start,end) offsets in the flattened text for a comment's anchor.
  function locate(text, c) {
    var q = (c.quote || "").trim();
    if (!q) return null;
    var idx = -1, from = 0;
    var best = -1;
    while ((idx = text.indexOf(q, from)) !== -1) {
      var pre = text.slice(Math.max(0, idx - CTX), idx);
      var suf = text.slice(idx + q.length, idx + q.length + CTX);
      var score = 0;
      if (c.prefix && pre.slice(-c.prefix.length) === c.prefix) score += 2;
      if (c.suffix && suf.slice(0, c.suffix.length) === c.suffix) score += 2;
      if (best === -1 || score > best.score) best = { start: idx, end: idx + q.length, score: score };
      if (score >= 4) break;
      from = idx + 1;
    }
    return best && best.start !== undefined ? best : null;
  }

  // Wrap the flattened [start,end) span in <mark>s, one per text node it covers.
  function mark(nodes, span, id, resolved) {
    var pos = 0;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.nodeValue.length, a = pos, b = pos + len;
      pos = b;
      if (b <= span.start || a >= span.end) continue;
      var s = Math.max(span.start, a) - a, e = Math.min(span.end, b) - a;
      var range = document.createRange();
      range.setStart(node, s); range.setEnd(node, e);
      var m = document.createElement("mark");
      m.className = "artifact-annotation" + (resolved ? " is-resolved" : "");
      m.setAttribute("data-ac", id);
      try { range.surroundContents(m); } catch (err) { continue; }
      // surroundContents split the node list; rebuild for the next comment.
      return true;
    }
    return false;
  }

  function clearMarks() {
    var ms = document.querySelectorAll("mark.artifact-annotation");
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i], p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      p.normalize();
    }
  }

  var current = [];
  function render(comments) {
    current = comments || [];
    clearMarks();
    var missed = 0;
    for (var i = 0; i < current.length; i++) {
      var c = current[i];
      if (!c.quote) continue;
      var nodes = textNodes();
      var span = locate(fullText(nodes), c);
      if (!span) { missed++; continue; }
      mark(nodes, span, c.id, c.status === "resolved");
    }
    toHost({ type: "artifact:anchored", total: current.length, missed: missed });
  }

  document.addEventListener("click", function (e) {
    var m = e.target && e.target.closest && e.target.closest("mark.artifact-annotation");
    if (m) toHost({ type: "artifact:commentClick", id: m.getAttribute("data-ac") });
  });

  // ---- selection → floating "Comment" button ----
  var btn = null;
  function hideBtn() { if (btn) { btn.remove(); btn = null; } }
  function onSelect() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideBtn(); return; }
    var text = sel.toString().trim();
    if (text.length < 2 || text.length > 800) { hideBtn(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideBtn(); return; }
    hideBtn();
    btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "💬 Comment";
    btn.setAttribute("style",
      "position:fixed;z-index:2147483647;font:600 12px/1 var(--font-sans,sans-serif);" +
      "padding:6px 10px;border:0;border-radius:8px;background:#0075de;color:#fff;" +
      "cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)");
    btn.style.left = Math.max(8, Math.min(window.innerWidth - 110, rect.left + rect.width / 2 - 50)) + "px";
    btn.style.top = Math.max(8, rect.top - 38) + "px";
    btn.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    btn.addEventListener("click", function () {
      var full = fullText(textNodes());
      var i = full.indexOf(text);
      var prefix = i >= 0 ? full.slice(Math.max(0, i - CTX), i) : "";
      var suffix = i >= 0 ? full.slice(i + text.length, i + text.length + CTX) : "";
      toHost({ type: "artifact:selection", quote: text, prefix: prefix, suffix: suffix });
      hideBtn();
      try { window.getSelection().removeAllRanges(); } catch (e) {}
    });
    document.body.appendChild(btn);
  }
  document.addEventListener("selectionchange", function () { setTimeout(onSelect, 0); });
  document.addEventListener("scroll", hideBtn, true);
  window.addEventListener("resize", hideBtn);

  // ---- host → page ----
  window.__artifactApi = { setComments: render, rerender: function () { render(current); } };
  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === "artifact:comments") render(d.comments);
    if (d.type === "artifact:scrollTo" && d.id) {
      var m = document.querySelector('mark.artifact-annotation[data-ac="' + d.id + '"]');
      if (m) {
        m.scrollIntoView({ block: "center", behavior: "smooth" });
        m.style.transition = "background .2s"; var b = m.style.background;
        m.style.background = "rgba(255,193,7,.7)";
        setTimeout(function () { m.style.background = b; }, 900);
      }
    }
  });

  function boot() {
    var css = document.createElement("style");
    css.textContent =
      "mark.artifact-annotation{background:rgba(255,193,7,.32);border-bottom:2px solid rgba(230,150,0,.8);" +
      "border-radius:2px;padding:.02em 0;cursor:pointer;color:inherit}" +
      "mark.artifact-annotation.is-resolved{background:rgba(0,117,222,.13);border-bottom-color:rgba(0,117,222,.4)}" +
      "mark.artifact-annotation:hover{background:rgba(255,193,7,.5)}";
    document.head.appendChild(css);
    render(window.__ARTIFACT_COMMENTS || []);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;

export const ARTIFACT_RUNTIME = CARD_RUNTIME + "\n" + ANNOTATION_RUNTIME;
