import { describe, it, expect, beforeEach } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";
import { makeNoteTools } from "../src/agents/noteTools.js";

// Direct unit coverage of the tools bound to the notes-agent subagent (see
// docs/DECISIONS.md, "Cross-account chat & shared boards").
describe("note tools", () => {
  let store: ScopedStore;
  let tools: ReturnType<typeof makeNoteTools>;

  beforeEach(() => {
    const raw = new Store(":memory:");
    store = raw.scoped(raw.createUser({ username: "u", displayName: "U", password: "sekret123" }).id);
    tools = makeNoteTools(store);
  });

  function find(name: string) {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it("add_sticky_note then list_sticky_notes round-trips per scope", async () => {
    await find("add_sticky_note").invoke({ scope: "shared", text: "Plumber Friday 9am" });
    await find("add_sticky_note").invoke({ scope: "private", text: "Call the school" });

    const shared = (await find("list_sticky_notes").invoke({ scope: "shared" })) as string;
    expect(shared).toContain("Plumber Friday 9am");
    expect(shared).not.toContain("Call the school");

    const all = (await find("list_sticky_notes").invoke({})) as string;
    expect(all).toContain("Plumber Friday 9am");
    expect(all).toContain("Call the school");
  });

  it("defaults add_sticky_note to the shared board", async () => {
    await find("add_sticky_note").invoke({ text: "no scope given" });
    expect(store.listStickyNotes("shared").map((n) => n.text)).toEqual(["no scope given"]);
  });

  it("reports an empty board plainly", async () => {
    const out = (await find("list_sticky_notes").invoke({ scope: "shared" })) as string;
    expect(out.toLowerCase()).toContain("no sticky notes");
  });
});
