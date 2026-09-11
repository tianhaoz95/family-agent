import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ChatOllama } from "@langchain/ollama";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { wrapArtifact } from "../src/artifacts/wrap.js";
import { resolveArtifactComments } from "../src/artifacts/resolve.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

/** A model whose bound `.invoke()` returns a fixed set of tool calls. */
function fakeModel(calls: { name: string; args: Record<string, unknown> }[]): ChatOllama {
  return {
    bindTools() {
      return { async invoke() { return { content: "", tool_calls: calls }; } };
    },
  } as unknown as ChatOllama;
}

describe("artifact comments — store + resolve", () => {
  let store: Store;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-ac-"));
    store = new Store(":memory:");
  });
  afterEach(() => {
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("wrapArtifact seeds the comment list and the annotation api", () => {
    const a = { id: "a1", title: "Guide", html: "<p>hello world</p>", source: null, sourceId: null, revision: 0, canRevert: false, createdAt: "", updatedAt: null };
    const r = wrapArtifact(a, [{ id: "c1", quote: "world", prefix: "hello ", suffix: "", status: "open" }]);
    expect(r.document).toContain("window.__ARTIFACT_COMMENTS=[");
    expect(r.document).toContain('"quote":"world"');
    expect(r.document).toContain("window.__artifactApi");
    expect(r.document).toContain("artifact:selection");
  });

  it("comments are scoped through the owning artifact", () => {
    const owner = seedUser(store, { username: "owner" });
    const kid = seedUser(store, { username: "kid", role: "member" });
    const art = store.scoped(owner.user.id).createArtifact({ title: "Budget", html: "<p>x</p>" });

    const ok = store.scoped(owner.user.id).addArtifactComment({ artifactId: art.id, body: "change this", quote: "x" });
    expect(ok).toBeTruthy();
    // a different user can't comment on it or read its comments
    expect(store.scoped(kid.user.id).addArtifactComment({ artifactId: art.id, body: "sneaky" })).toBeUndefined();
    expect(store.scoped(kid.user.id).listArtifactComments(art.id)).toEqual([]);
    expect(store.scoped(owner.user.id).listArtifactComments(art.id)).toHaveLength(1);
  });

  it("resolveArtifactComments edits the artifact, resolves what it addressed, keeps prev for revert", async () => {
    const u = seedUser(store, { username: "u" });
    const s = store.scoped(u.user.id);
    const art = s.createArtifact({ title: "Mortgage", html: "<h1>Mortgage</h1><p>Rate: 5%</p>" });
    const c1 = s.addArtifactComment({ artifactId: art.id, body: "the rate should be 4.5%", quote: "5%" })!;
    const c2 = s.addArtifactComment({ artifactId: art.id, body: "is this monthly or yearly?", quote: "Rate" })!;

    const model = fakeModel([
      { name: "edit_artifact", args: { html: "<h1>Mortgage</h1><p>Rate: 4.5% per year</p>" } },
      { name: "resolve_comment", args: { commentId: c1.id, reply: "Updated the rate to 4.5%." } },
      { name: "resolve_comment", args: { commentId: c2.id, reply: "Clarified: it's the yearly rate." } },
    ]);
    const res = await resolveArtifactComments(model, s, art.id);
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.edited).toBe(true);
    expect(res.outcomes.map((o) => o.action)).toEqual(["edited", "edited"]);

    const after = s.getArtifact(art.id)!;
    expect(after.html).toContain("4.5% per year");
    expect(after.revision).toBe(1);
    expect(after.canRevert).toBe(true);
    expect(s.listArtifactComments(art.id).every((c) => c.status === "resolved")).toBe(true);
    expect(s.listArtifactComments(art.id)[0].resolvedBy).toBe("agent");

    // one-step revert
    const reverted = s.revertArtifact(art.id)!;
    expect(reverted.html).toBe("<h1>Mortgage</h1><p>Rate: 5%</p>");
    expect(reverted.canRevert).toBe(false);
  });

  it("a comment the model ignores stays open and is marked skipped", async () => {
    const u = seedUser(store, { username: "u2" });
    const s = store.scoped(u.user.id);
    const art = s.createArtifact({ title: "X", html: "<p>a b c</p>" });
    const c = s.addArtifactComment({ artifactId: art.id, body: "do something", quote: "b" })!;
    const res = await resolveArtifactComments(fakeModel([]), s, art.id);
    if ("error" in res) throw new Error(res.error);
    expect(res.outcomes[0].action).toBe("skipped");
    expect(s.getArtifactComment(art.id, c.id)!.status).toBe("open");
  });

  it("no edit is applied when the model returns invalid html", async () => {
    const u = seedUser(store, { username: "u3" });
    const s = store.scoped(u.user.id);
    const art = s.createArtifact({ title: "Y", html: "<p>original</p>" });
    const c = s.addArtifactComment({ artifactId: art.id, body: "tweak", quote: "original" })!;
    const model = fakeModel([
      { name: "edit_artifact", args: { html: "<!doctype html><body>nope</body>" } }, // rejected: full doc
      { name: "resolve_comment", args: { commentId: c.id, reply: "done" } },
    ]);
    const res = await resolveArtifactComments(model, s, art.id);
    if ("error" in res) throw new Error(res.error);
    expect(res.edited).toBe(false);
    expect(s.getArtifact(art.id)!.html).toBe("<p>original</p>");
    expect(s.getArtifactComment(art.id, c.id)!.status).toBe("resolved"); // reply still recorded
  });
});

describe("HTTP API — artifact comments", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-ach-"));
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

  it("create → list → edit → delete a comment; GET :id carries them + the count", async () => {
    const art = store.scoped(admin.user.id).createArtifact({ title: "Plan", html: "<p>step one</p>" });

    const created = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments`,
      payload: { body: "add a step two", quote: "step one", prefix: "", suffix: "" },
    });
    expect(created.statusCode).toBe(200);
    const cid = created.json().comment.id;

    expect((await inject(`/artifacts/${art.id}/comments`)).json().comments).toHaveLength(1);

    const full = await inject(`/artifacts/${art.id}`);
    expect(full.json().comments).toHaveLength(1);
    expect(full.json().artifact.document).toContain('"quote":"step one"');

    const list = await inject("/artifacts");
    expect(list.json().artifacts[0].openComments).toBe(1);

    const edited = await inject({ method: "PATCH", url: `/artifacts/${art.id}/comments/${cid}`, payload: { body: "actually, add TWO steps" } });
    expect(edited.json().comment.body).toBe("actually, add TWO steps");

    const del = await inject({ method: "DELETE", url: `/artifacts/${art.id}/comments/${cid}` });
    expect(del.json().deleted).toBe(true);
    expect((await inject(`/artifacts/${art.id}/comments`)).json().comments).toHaveLength(0);
  });

  it("a comment can be resolved manually (no AI) and reopened again", async () => {
    const art = store.scoped(admin.user.id).createArtifact({ title: "Plan", html: "<p>step one</p>" });
    const created = await inject({
      method: "POST",
      url: `/artifacts/${art.id}/comments`,
      payload: { body: "looks fine actually", quote: "step one", prefix: "", suffix: "" },
    });
    const cid = created.json().comment.id;

    const resolved = await inject({ method: "POST", url: `/artifacts/${art.id}/comments/${cid}/resolve` });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().comment.status).toBe("resolved");
    expect(resolved.json().comment.resolvedBy).toBe("user");

    // Resolved comments stay in the list (not deleted) — the client filters them.
    const list = (await inject(`/artifacts/${art.id}/comments`)).json().comments;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("resolved");

    const reopened = await inject({ method: "PATCH", url: `/artifacts/${art.id}/comments/${cid}`, payload: { status: "open" } });
    expect(reopened.json().comment.status).toBe("open");
  });

  it("revert 409s when there's nothing to revert to", async () => {
    const art = store.scoped(admin.user.id).createArtifact({ title: "P", html: "<p>x</p>" });
    expect((await inject({ method: "POST", url: `/artifacts/${art.id}/revert` })).statusCode).toBe(409);
  });

  it("comment routes 404 when the feature is off", async () => {
    config.artifactsEnabled = false;
    const res = await inject({ method: "POST", url: "/artifacts/x/comments", payload: { body: "hi" } });
    expect(res.statusCode).toBe(404);
  });
});
