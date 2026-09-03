// A lightweight "the agent looked this up" signal. The subagent tools call
// `onReference` with each task / document they retrieve; the /chat route
// collects them for one turn and returns them alongside the reply so the UI
// can render clickable references that open the item in a side panel.
export type ReferenceHint = { type: "document" | "task" | "tool"; id: string };
export type OnReference = (ref: ReferenceHint) => void;
