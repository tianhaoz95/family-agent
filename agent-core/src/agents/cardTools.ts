import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { validateCardFragment, MAX_CARD_FRAGMENT, MAX_CARD_TITLE, type CardRecord } from "../cards/wrap.js";

// `render_card` — the assistant answers with a small self-contained HTML/JS
// snippet the UI embeds inline (a chart, a checklist, a diagram). A leaf tool,
// like `run_code`; only wired when config.cardsEnabled. The snippet runs in a
// sealed sandbox (see cards/wrap.ts + the clients) — it can't reach the app or
// the network. See docs/DECISIONS.md → "AI-generated HTML cards".

export interface CardToolDeps {
  /** Called with each card the model renders this turn — collected per user,
   *  attached to the reply and persisted on the message. */
  onCard: (card: CardRecord) => void;
  logActivity?: (actor: string, action: string, detail: string) => void;
}

const CARD_TOOL_DESCRIPTION = `Answer with a visual CARD instead of (or alongside) plain text when the
answer is a trend, a breakdown, a comparison, a chart, a checklist, a table,
a diagram, or a small interactive widget — anything that reads better shown
than described.

The "html" argument is LITERAL HTML for the card's body (it is inserted
verbatim — it is NOT JavaScript). You may include <style> and one <script>.
It runs sandboxed: no network, no access to the app, no alert/confirm. Keep it
compact — it renders inline in a chat bubble.

A helper library is preloaded (optional — write raw SVG/canvas/DOM if you
prefer). The chart helpers RETURN an SVG string; you must put it into the page
from a <script>:
  Card.lineChart({ title, labels:["Mon",..], series:[{name:"Close", data:[1,2,3]}], unit:"$" }) -> "<svg…>"
  Card.barChart({ … })   Card.areaChart({ … })
  Card.palette           // array of on-brand colours
  Card.money(1234.5)     // "$1,234.50"

Example — "how did the water bill change this year":
  render_card({
    title: "Water bill — 2024 vs 2023",
    html: "<div class=\\"card\\"><div id=\\"chart\\"></div></div>\\n<script>\\n  document.getElementById('chart').innerHTML = Card.barChart({\\n    labels:['Jan','Feb','Mar','Apr'], unit:'$',\\n    series:[{name:'2024',data:[41,44,39,47]},{name:'2023',data:[38,40,41,43]}]\\n  });\\n</script>"
  })

Example — a checklist (plain HTML, no helper):
  render_card({ title:"Camping list", html:"<div class=\\"card\\"><label><input type=checkbox> Tent</label><br><label><input type=checkbox> Sleeping bags</label></div>" })

After calling render_card, reply with ONE short sentence summarising what the
card shows. Do not repeat the card's contents as a text table.`;

export function makeCardTools(deps: CardToolDeps) {
  const renderCard = tool(
    async ({ title, html }) => {
      const check = validateCardFragment(html);
      if (!check.ok) {
        return `The card wasn't shown — ${check.reason}. Fix the html and call render_card again, or just answer in text.`;
      }
      const card: CardRecord = {
        id: randomUUID(),
        title: title.trim().slice(0, MAX_CARD_TITLE),
        fragment: html,
      };
      deps.onCard(card);
      deps.logActivity?.("card-agent", "card.rendered", `Rendered a card: "${card.title}"`);
      return `The card "${card.title}" is now displayed to the user. Reply with one short sentence summarising what it shows.`;
    },
    {
      name: "render_card",
      description: CARD_TOOL_DESCRIPTION,
      schema: z.object({
        title: z.string().min(1).max(MAX_CARD_TITLE).describe("A short heading shown above the card"),
        html: z
          .string()
          .min(1)
          .max(MAX_CARD_FRAGMENT)
          .describe("The card body — an HTML fragment, may contain <style> and <script>. No <html>/<head>/<body> tags."),
      }),
    }
  );
  return [renderCard];
}
