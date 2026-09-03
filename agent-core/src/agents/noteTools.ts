import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ScopedStore } from "../db.js";

// Bound to one user's ScopedStore — the planner builds a fresh agent per
// authenticated user (see agents/index.ts), so "private" notes here are always
// that user's own, and "shared" is the one family board everyone sees.
export function makeNoteTools(store: ScopedStore) {
  const listStickyNotes = tool(
    async ({ scope }) => {
      const want = scope ?? "all";
      const notes = [
        ...(want === "shared" || want === "all" ? store.listStickyNotes("shared") : []),
        ...(want === "private" || want === "all" ? store.listStickyNotes("private") : []),
      ];
      store.logActivity(
        "notes-agent",
        "note.searched",
        `Read the ${want} sticky note board${want === "all" ? "s" : ""} — ${notes.length} note(s)`
      );
      if (notes.length === 0) return `No sticky notes on the ${want} board.`;
      return notes
        .map((n) => `- [${n.scope}] ${n.text} (id: ${n.id})`)
        .join("\n");
    },
    {
      name: "list_sticky_notes",
      description:
        "Read the family's sticky notes. 'shared' is the whole-family board, 'private' is the current person's own board, 'all' (default) is both. Use this to answer 'what's on the board / the fridge / our notes'.",
      schema: z.object({
        scope: z.enum(["shared", "private", "all"]).optional(),
      }),
    }
  );

  const addStickyNote = tool(
    async ({ scope, text }) => {
      const rec = store.createStickyNote({ scope: scope ?? "shared", text });
      return `Pinned a ${rec.scope} sticky note: "${rec.text}".`;
    },
    {
      name: "add_sticky_note",
      description:
        "Pin a new sticky note. Use 'shared' (default) for something the whole family should see, 'private' for a personal reminder ('note that down for me', 'add to my notes').",
      schema: z.object({
        scope: z.enum(["shared", "private"]).optional(),
        text: z.string().min(1).describe("The note text, e.g. 'Plumber comes Friday 9am'"),
      }),
    }
  );

  return [listStickyNotes, addStickyNote];
}
