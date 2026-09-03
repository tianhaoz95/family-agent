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

  it("scatters a note with no position, keeps an explicit one", () => {
    const scattered = alice.createStickyNote({ scope: "shared", text: "a" });
    expect(scattered.x).toBeGreaterThanOrEqual(16);
    expect(scattered.y).toBeGreaterThanOrEqual(16);

    const placed = alice.createStickyNote({ scope: "shared", text: "b", x: 240, y: 120 });
    expect({ x: placed.x, y: placed.y }).toEqual({ x: 240, y: 120 });
    expect(alice.getStickyNote(placed.id)).toMatchObject({ x: 240, y: 120 });
  });

  it("a drag (position only) persists but doesn't spam the activity log", () => {
    const n = alice.createStickyNote({ scope: "shared", text: "movable", x: 0, y: 0 });
    const before = alice.listActivity().length;

    const moved = alice.updateStickyNote(n.id, { x: 333, y: 210 });
    expect({ x: moved?.x, y: moved?.y }).toEqual({ x: 333, y: 210 });
    expect(alice.listActivity().length).toBe(before); // no note.updated line

    alice.updateStickyNote(n.id, { text: "moved and renamed" });
    expect(alice.listActivity().some((a) => a.action === "note.updated")).toBe(true);
  });

  it("accepts a blank note and lets it be filled in later", () => {
    const blank = alice.createStickyNote({ scope: "shared", text: "" });
    expect(blank.text).toBe("");
    expect(alice.listActivity().some((a) => a.detail.includes("blank"))).toBe(true);
    expect(alice.updateStickyNote(blank.id, { text: "now it says something" })?.text).toBe(
      "now it says something"
    );
  });
});
