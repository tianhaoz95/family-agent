import { describe, it, expect, beforeEach } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";

describe("ScopedStore — sticky notes", () => {
  let raw: Store;
  let alice: ScopedStore;
  let bob: ScopedStore;

  beforeEach(() => {
    raw = new Store(":memory:");
    alice = raw.scoped(raw.createUser({ username: "alice", displayName: "Alice", password: "sekret123" }).id);
    bob = raw.scoped(raw.createUser({ username: "bob", displayName: "Bob", password: "sekret123" }).id);
  });

  it("a private note is visible only to its owner", () => {
    const n = alice.createStickyNote({ scope: "private", text: "dentist Tuesday" });
    expect(alice.listStickyNotes("private").map((x) => x.id)).toEqual([n.id]);
    expect(bob.listStickyNotes("private")).toEqual([]);
    expect(bob.getStickyNote(n.id)).toBeUndefined();
  });

  it("the shared board is visible to and editable by every member", () => {
    const n = alice.createStickyNote({ scope: "shared", text: "buy stamps", color: "mint" });
    expect(bob.listStickyNotes("shared").map((x) => x.id)).toEqual([n.id]);

    const edited = bob.updateStickyNote(n.id, { text: "buy stamps and envelopes" });
    expect(edited?.text).toBe("buy stamps and envelopes");

    expect(bob.deleteStickyNote(n.id)).toBeDefined();
    expect(alice.listStickyNotes("shared")).toEqual([]);
  });

  it("cannot edit or delete another member's private note", () => {
    const n = alice.createStickyNote({ scope: "private", text: "secret" });
    expect(bob.updateStickyNote(n.id, { text: "hacked" })).toBeUndefined();
    expect(bob.deleteStickyNote(n.id)).toBeUndefined();
    expect(alice.getStickyNote(n.id)?.text).toBe("secret");
  });

  it("defaults the colour and records activity", () => {
    const n = alice.createStickyNote({ scope: "shared", text: "no colour given" });
    expect(n.color).toBe("butter");
    expect(alice.listActivity().some((a) => a.action === "note.created")).toBe(true);
  });
});
