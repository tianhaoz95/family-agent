// A lightweight "the agent looked this up" signal. The subagent tools call
// `onReference` with each task / document they retrieve; the /chat route
// collects them for one turn and returns them alongside the reply so the UI
// can render clickable references that open the item in a side panel.
// `link` is a web page the research agent opened — `id` is the URL and
// `label` (resolved server-side) is the page title.
export type ReferenceHint =
  | { type: "document" | "task" | "tool"; id: string }
  | { type: "link"; id: string; label: string };
export type OnReference = (ref: ReferenceHint) => void;
