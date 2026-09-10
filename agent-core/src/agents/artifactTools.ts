import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  validateArtifactFragment,
  MAX_ARTIFACT_FRAGMENT,
  MAX_ARTIFACT_TITLE,
} from "../artifacts/wrap.js";
import type { OnReference } from "./references.js";

// `render_artifact` — the assistant writes a WHOLE HTML PAGE to explain
// something (a walkthrough, an interactive explainer, a dashboard, a rendered
// document). It's persisted per-user, browsable in the Artifacts tab, and the
// reply links to it via an `artifact` reference chip. A leaf tool like
// `render_card`; only wired when config.artifactsEnabled. The page runs in the
// same sealed opaque-origin sandbox as a card — no network, no app access.
// See docs/DECISIONS.md → "AI-generated full-page artifacts".

export interface ArtifactToolDeps {
  /** Persist the fragment and return its id + title. */
  saveArtifact: (a: { title: string; html: string }) => { id: string; title: string };
  /** Push an `artifact` reference so the reply carries a chip that opens it. */
  onReference?: OnReference;
  logActivity?: (actor: string, action: string, detail: string) => void;
}

const ARTIFACT_TOOL_DESCRIPTION = `Generate a full-page ARTIFACT — a standalone web page — when a plain-text
answer would be cramped: a multi-section explainer, a walkthrough with
diagrams, an interactive demo (a slider that recomputes, a step-through), a
data dashboard, or a nicely formatted rendering of a document. The user opens
it full-screen and it stays in their Artifacts tab.

Use a CARD (render_card) instead when the visual is small and glanceable and
belongs right in the chat bubble — a single chart, a short checklist, one
stat. Use an ARTIFACT when it's a page worth navigating to.

The "html" argument is LITERAL HTML for the page body (inserted verbatim — it
is NOT JavaScript). You may include <style> and <script>. It runs sandboxed:
no network, no access to the app, no alert/confirm. Do NOT include <html>,
<head>, <body> or <!doctype> — a full-page shell with the app's "warm paper
notebook" styling (Inter, white cards on a warm canvas, one blue accent,
readable 820px measure) is added for you. Just write the content; wrap it in
a <div class="wrap"> if you want the centred column.

A helper library is preloaded (optional): Card.lineChart / Card.barChart /
Card.areaChart return an SVG string you inject from a <script>; Card.palette,
Card.money(n). Write raw SVG/canvas/DOM if you prefer.

Example — "explain how our mortgage amortises":
  render_artifact({
    title: "Mortgage amortisation",
    html: "<div class=\\"wrap\\"><h1>How your mortgage pays down</h1><p>...</p><div class=\\"card\\"><div id=\\"chart\\"></div></div><script>document.getElementById('chart').innerHTML = Card.areaChart({ labels:['Y1','Y5','Y10','Y20','Y30'], series:[{name:'Balance', data:[420,380,330,190,0]}], unit:'k' });</script></div>"
  })

After calling render_artifact, reply with ONE short sentence telling the user
you've put it in their Artifacts tab and what it covers. Do not paste the
page's contents back as text.`;

export function makeArtifactTools(deps: ArtifactToolDeps) {
  const renderArtifact = tool(
    async ({ title, html }) => {
      const check = validateArtifactFragment(html);
      if (!check.ok) {
        return `The artifact wasn't created — ${check.reason}. Fix the html and call render_artifact again, or just answer in text.`;
      }
      const saved = deps.saveArtifact({
        title: title.trim().slice(0, MAX_ARTIFACT_TITLE) || "Untitled",
        html,
      });
      deps.onReference?.({ type: "artifact", id: saved.id });
      deps.logActivity?.("artifact-agent", "artifact.created", `Generated an artifact: "${saved.title}"`);
      return `The artifact "${saved.title}" is saved to the user's Artifacts tab and linked below your reply. Reply with one short sentence pointing them to it and saying what it covers.`;
    },
    {
      name: "render_artifact",
      description: ARTIFACT_TOOL_DESCRIPTION,
      schema: z.object({
        title: z.string().min(1).max(MAX_ARTIFACT_TITLE).describe("A short title for the page"),
        html: z
          .string()
          .min(1)
          .max(MAX_ARTIFACT_FRAGMENT)
          .describe("The page body — an HTML fragment, may contain <style> and <script>. No <html>/<head>/<body>."),
      }),
    }
  );
  return [renderArtifact];
}
