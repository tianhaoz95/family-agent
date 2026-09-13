import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ChatOllama } from "@langchain/ollama";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { runThreadAgentTurn } from "../src/agents/threadReply.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

/** A model whose bound `.invoke()` returns a fixed reply, optionally with tool calls. */
function fakeModel(content: string, calls: { name: string; args: Record<string, unknown> }[] = []): ChatOllama {
  return {
    bindTools() {
      return { async invoke() { return { content, tool_calls: calls }; } };
    },
  } as unknown as ChatOllama;
}

describe("runThreadAgentTurn", () => {
  it("returns the model's reply text with no edit when it doesn't call edit_content", async () => {
    const res = await runThreadAgentTurn(fakeModel("Looks right to me."), {
      kind: "wiki page",
      title: "Chores",
      content: "# Chores\n- Take out trash",
      maxContentChars: 10_000,
      quote: "Take out trash",
      history: [{ author: "Ann", body: "Take out trash" }],
      message: "@agent is this enough detail?",
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.reply).toBe("Looks right to me.");
    expect(res.editedContent).toBeNull();
  });

  it("captures an edit_content tool call as editedContent", async () => {
    const res = await runThreadAgentTurn(
      fakeModel("Added a second chore.", [{ name: "edit_content", args: { content: "# Chores\n- Take out trash\n- Feed the dog" } }]),
      {
        kind: "wiki page",
        title: "Chores",
        content: "# Chores\n- Take out trash",
        maxContentChars: 10_000,
        quote: null,
        history: [],
        message: "@agent add feeding the dog too",
      }
    );
    if ("error" in res) throw new Error(res.error);
    expect(res.editedContent).toContain("Feed the dog");
    expect(res.reply).toBe("Added a second chore.");
  });
});

describe("artifact comment threads — store", () => {
  let store: Store;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-tc-"));
    store = new Store(":memory:");
  });
  afterEach(() => {
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("a thread accumulates replies in order, from any author", () => {
    const u = seedUser(store, { username: "u" });
    const s = store.scoped(u.user.id);
    const art = s.createArtifact({ title: "Plan", html: "<p>step one</p>" });
    const c = s.addArtifactComment({ artifactId: art.id, body: "why only one step?", quote: "step one" })!;

    s.addArtifactCommentReply(art.id, c.id, u.user.id, u.user.displayName, "good question");
    s.addArtifactCommentReply(art.id, c.id, "agent", "Assistant", "I've added step two.");
    s.addArtifactCommentReply(art.id, c.id, u.user.id, u.user.displayName, "thanks, @agent can you also add step three?");
    s.addArtifactCommentReply(art.id, c.id, "agent", "Assistant", "Done — step three added.");

    const full = s.getArtifactComment(art.id, c.id)!;
    expect(full.replies).toHaveLength(4);
    expect(full.replies.map((r) => r.author)).toEqual([u.user.id, "agent", u.user.id, "agent"]);
    expect(full.replies[1].authorName).toBe("Assistant");

    const listed = s.listArtifactComments(art.id)[0];
    expect(listed.replies).toHaveLength(4);
  });

  it("deleting a comment deletes its replies; deleting the artifact deletes everything", () => {
    const u = seedUser(store, { username: "u2" });
    const s = store.scoped(u.user.id);
    const art = s.createArtifact({ title: "Plan", html: "<p>x</p>" });
    const c1 = s.addArtifactComment({ artifactId: art.id, body: "a" })!;
    const c2 = s.addArtifactComment({ artifactId: art.id, body: "b" })!;
    s.addArtifactCommentReply(art.id, c1.id, "agent", "Assistant", "reply 1");
    s.addArtifactCommentReply(art.id, c2.id, "agent", "Assistant", "reply 2");

    s.deleteArtifactComment(art.id, c1.id);
    expect(s.listArtifactComments(art.id)).toHaveLength(1);

    s.deleteArtifact(art.id);
    // No dangling reply rows — reach in via a fresh comment id reuse is
    // impossible to observe directly, but a second artifact's comments
    // must come back empty (nothing leaked across ids).
    expect(s.listArtifactComments(art.id)).toEqual([]);
  });

  it("addArtifactCommentReply refuses a reply on a comment from a different user's artifact", () => {
    const owner = seedUser(store, { username: "owner" });
    const other = seedUser(store, { username: "other" });
    const art = store.scoped(owner.user.id).createArtifact({ title: "P", html: "<p>x</p>" });
    const c = store.scoped(owner.user.id).addArtifactComment({ artifactId: art.id, body: "note" })!;
    expect(store.scoped(other.user.id).addArtifactCommentReply(art.id, c.id, other.user.id, other.user.displayName, "sneaky")).toBeUndefined();
  });
});

describe("wiki comment threads — store", () => {
  let store: Store;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-wtc-"));
    store = new Store(":memory:");
  });
  afterEach(() => {
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("any signed-in member can comment and reply — no ownership check", () => {
    const ann = seedUser(store, { username: "ann" });
    const bo = seedUser(store, { username: "bo", role: "member" });
    const page = store.createWikiPage("Chores", "- Take out trash", ann.user.id);

    const c = store.addWikiComment({ pageId: page.id, userId: ann.user.id, body: "should we split by day?" })!;
    expect(c).toBeTruthy();
    store.addWikiCommentReply(page.id, c.id, bo.user.id, bo.user.displayName, "sure, I'll do Mondays");

    const thread = store.getWikiComment(page.id, c.id)!;
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].authorName).toBe(bo.user.displayName);
  });

  it("resolve / reopen toggles status", () => {
    const u = seedUser(store, { username: "u" });
    const page = store.createWikiPage("Chores", "body", u.user.id);
    const c = store.addWikiComment({ pageId: page.id, userId: u.user.id, body: "note" })!;
    expect(store.resolveWikiComment(page.id, c.id)!.status).toBe("resolved");
    expect(store.reopenWikiComment(page.id, c.id)!.status).toBe("open");
  });

  it("deleting the page cleans up its comments and replies", () => {
    const u = seedUser(store, { username: "u" });
    const page = store.createWikiPage("Chores", "body", u.user.id);
    const c = store.addWikiComment({ pageId: page.id, userId: u.user.id, body: "note" })!;
    store.addWikiCommentReply(page.id, c.id, "agent", "Assistant", "reply");
    store.deleteWikiPage(page.id);
    expect(store.listWikiComments(page.id)).toEqual([]);
    expect(store.getWikiComment(page.id, c.id)).toBeUndefined();
  });
});

describe("HTTP API — threaded replies", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-tch-"));
    config.artifactsEnabled = true;
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    inject = authInject(app, admin.token);
  });
  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("POST a plain reply on an artifact comment — no @agent, no AI call, thread just grows", async () => {
    const art = store.scoped(admin.user.id).createArtifact({ title: "Plan", html: "<p>step one</p>" });
    const created = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments`,
      payload: { body: "why only one step?", quote: "step one" },
    });
    const cid = created.json().comment.id;

    const replied = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments/${cid}/replies`,
      payload: { body: "good question, will add more" },
    });
    expect(replied.statusCode).toBe(200);
    expect(replied.json().comment.replies).toHaveLength(1);
    expect(replied.json().comment.replies[0].author).toBe(admin.user.id);
    expect(replied.json().comment.replies[0].body).toBe("good question, will add more");

    const again = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments/${cid}/replies`,
      payload: { body: "actually here's step two" },
    });
    expect(again.json().comment.replies).toHaveLength(2);
  });

  it("reply routes 404 on an unknown comment", async () => {
    const art = store.scoped(admin.user.id).createArtifact({ title: "Plan", html: "<p>x</p>" });
    const res = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments/nope/replies`,
      payload: { body: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("wiki: create a page comment, reply, list carries userName + reply authorName", async () => {
    const page = (await inject({ method: "POST", url: "/wiki", payload: { title: "Chores" } })).json().page;
    const created = await inject({
      method: "POST",
      url: `/wiki/${page.id}/comments`,
      payload: { body: "should we add a schedule?" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().comment.userName).toBe(admin.user.displayName);
    const cid = created.json().comment.id;

    const replied = await inject({
      method: "POST",
      url: `/wiki/${page.id}/comments/${cid}/replies`,
      payload: { body: "sure, I will draft one" },
    });
    expect(replied.statusCode).toBe(200);
    expect(replied.json().comment.replies).toHaveLength(1);
    expect(replied.json().comment.replies[0].authorName).toBe(admin.user.displayName);

    const listed = (await inject(`/wiki/${page.id}/comments`)).json().comments;
    expect(listed).toHaveLength(1);
    expect(listed[0].replies).toHaveLength(1);
  });

  it("wiki comment routes 404 for an unknown page", async () => {
    const res = await inject({ method: "POST", url: "/wiki/nope/comments", payload: { body: "hi" } });
    expect(res.statusCode).toBe(404);
  });

  it("wiki comment can be resolved and reopened", async () => {
    const page = (await inject({ method: "POST", url: "/wiki", payload: { title: "Chores" } })).json().page;
    const cid = (
      await inject({ method: "POST", url: `/wiki/${page.id}/comments`, payload: { body: "note" } })
    ).json().comment.id;
    const resolved = await inject({ method: "POST", url: `/wiki/${page.id}/comments/${cid}/resolve` });
    expect(resolved.json().comment.status).toBe("resolved");
    const reopened = await inject({ method: "POST", url: `/wiki/${page.id}/comments/${cid}/reopen` });
    expect(reopened.json().comment.status).toBe("open");
  });

  it("wiki comment can be deleted", async () => {
    const page = (await inject({ method: "POST", url: "/wiki", payload: { title: "Chores" } })).json().page;
    const cid = (
      await inject({ method: "POST", url: `/wiki/${page.id}/comments`, payload: { body: "note" } })
    ).json().comment.id;
    const del = await inject({ method: "DELETE", url: `/wiki/${page.id}/comments/${cid}` });
    expect(del.json().deleted).toBe(true);
    expect((await inject(`/wiki/${page.id}/comments`)).json().comments).toEqual([]);
  });
});
