import { describe, it, expect, beforeEach } from "vitest";
import { Store, AGENT_SENDER_ID } from "../src/db.js";
import { mentionsAgent } from "../src/agents/index.js";

describe("Store — family chat (cross-account, membership-checked)", () => {
  let store: Store;
  let alice: string;
  let bob: string;
  let carol: string;

  beforeEach(() => {
    store = new Store(":memory:");
    alice = store.createUser({ username: "alice", displayName: "Alice", password: "sekret123" }).id;
    bob = store.createUser({ username: "bob", displayName: "Bob", password: "sekret123" }).id;
    carol = store.createUser({ username: "carol", displayName: "Carol", password: "sekret123" }).id;
  });

  it("findOrCreateDm is idempotent regardless of argument order", () => {
    const a = store.findOrCreateDm(alice, bob);
    const b = store.findOrCreateDm(bob, alice);
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("dm");
    expect(a.members.map((m) => m.id).sort()).toEqual([alice, bob].sort());
  });

  it("a non-member cannot read a channel or its messages", () => {
    const dm = store.findOrCreateDm(alice, bob);
    store.postMessage(dm.id, alice, "hey bob");

    expect(store.getChannelForUser(dm.id, carol)).toBeUndefined();
    expect(store.listMessages(dm.id, carol)).toEqual([]);
    expect(store.isChannelMember(dm.id, carol)).toBe(false);

    // …but a member sees it.
    expect(store.listMessages(dm.id, bob).map((m) => m.body)).toEqual(["hey bob"]);
  });

  it("createGroupChannel always includes the creator", () => {
    const g = store.createGroupChannel(alice, "Trip planning", [bob]);
    expect(g.kind).toBe("group");
    expect(g.name).toBe("Trip planning");
    expect(g.members.map((m) => m.id).sort()).toEqual([alice, bob].sort());
    expect(store.isChannelMember(g.id, carol)).toBe(false);
  });

  it("addChannelMembers only works for a member of a group", () => {
    const g = store.createGroupChannel(alice, "Trip", [bob]);
    expect(store.addChannelMembers(g.id, carol, [carol])).toBeUndefined(); // carol isn't in it
    const updated = store.addChannelMembers(g.id, alice, [carol]);
    expect(updated?.members.map((m) => m.id).sort()).toEqual([alice, bob, carol].sort());
  });

  it("listChannelsForUser reports unread count and a last-message preview", () => {
    const dm = store.findOrCreateDm(alice, bob);
    store.postMessage(dm.id, alice, "one");
    store.postMessage(dm.id, alice, "two");

    const forBob = store.listChannelsForUser(bob);
    expect(forBob).toHaveLength(1);
    expect(forBob[0].unreadCount).toBe(2);
    expect(forBob[0].lastMessage?.body).toBe("two");
    expect(forBob[0].title).toBe("Alice");

    // Bob's own messages never count as unread for him.
    store.markChannelRead(dm.id, bob, new Date().toISOString());
    store.postMessage(dm.id, bob, "three");
    expect(store.listChannelsForUser(bob)[0].unreadCount).toBe(0);
    // Alice sent "one"/"two" herself and never read; only Bob's "three" is unread.
    expect(store.listChannelsForUser(alice)[0].unreadCount).toBe(1);
  });

  it("listMessages(after) returns only newer messages, oldest-first", async () => {
    const dm = store.findOrCreateDm(alice, bob);
    store.postMessage(dm.id, alice, "first");
    await new Promise((r) => setTimeout(r, 5));
    const mid = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    store.postMessage(dm.id, bob, "second");

    const after = store.listMessages(dm.id, alice, { afterTs: mid });
    expect(after.map((m) => m.body)).toEqual(["second"]);
  });

  it("a pending agent message is inserted empty and later resolved", () => {
    const dm = store.findOrCreateDm(alice, bob);
    const pending = store.insertPendingAgentMessage(dm.id);
    expect(pending.senderId).toBe(AGENT_SENDER_ID);
    expect(pending.pending).toBe(true);

    let msgs = store.listMessages(dm.id, alice);
    expect(msgs.at(-1)?.pending).toBe(true);

    store.resolvePendingAgentMessage(pending.id, "Here's what I found.");
    msgs = store.listMessages(dm.id, alice);
    expect(msgs.at(-1)?.pending).toBe(false);
    expect(msgs.at(-1)?.body).toBe("Here's what I found.");
  });

  it("failStalePendingMessages clears an interrupted reply", () => {
    const dm = store.findOrCreateDm(alice, bob);
    store.insertPendingAgentMessage(dm.id);
    expect(store.failStalePendingMessages()).toBe(1);
    expect(store.listMessages(dm.id, alice).at(-1)?.pending).toBe(false);
  });

  it("deleting a user tears down a DM that would be left with one member", () => {
    const dm = store.findOrCreateDm(alice, bob);
    store.postMessage(dm.id, alice, "hi");
    store.deleteUser(bob);
    expect(store.getChannelForUser(dm.id, alice)).toBeUndefined();
  });
});

describe("mentionsAgent", () => {
  it("matches @agent / @ai / @assistant at a word boundary", () => {
    expect(mentionsAgent("hey @agent what's the water bill")).toBe(true);
    expect(mentionsAgent("@ai remind me")).toBe(true);
    expect(mentionsAgent("ask the @assistant")).toBe(true);
  });
  it("does not match an email address or a trailing sentence word", () => {
    expect(mentionsAgent("mail me at bob@agentcorp.com")).toBe(false);
    expect(mentionsAgent("I talked to the agent yesterday")).toBe(false);
  });
});
