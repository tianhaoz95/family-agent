import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { wrapArtifact, validateArtifactFragment, MAX_ARTIFACT_FRAGMENT } from "../src/artifacts/wrap.js";
import { makeArtifactTools } from "../src/agents/artifactTools.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

describe("artifacts/wrap", () => {
  it("wraps a fragment into a full sealed page document", () => {
    const r = wrapArtifact({
      id: "a1",
      title: "Mortgage <maths>",
      html: "<div class='wrap'><h1>Hi</h1></div>",
      source: "chat",
      sourceId: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });
    expect(r.document).toContain("<!doctype html>");
    expect(r.document).toContain("Content-Security-Policy");
    expect(r.document).toContain("default-src 'none'");
    expect(r.document).not.toContain("connect-src");
    // title is escaped into <title>
    expect(r.document).toContain("<title>Mortgage &lt;maths&gt;</title>");
    expect(r.document).toContain("<div class='wrap'><h1>Hi</h1></div>");
    // shared runtime present (error trap + Card helper)
    expect(r.document).toContain("window.Card");
    // raw fragment untouched
    expect(r.html).toBe("<div class='wrap'><h1>Hi</h1></div>");
  });

  it("validateArtifactFragment rejects a full doc, oversize, broken script; allows a real page", () => {
    expect(validateArtifactFragment("").ok).toBe(false);
    expect(validateArtifactFragment("<!doctype html><body>x</body>").ok).toBe(false);
    expect(validateArtifactFragment("<html>x</html>").ok).toBe(false);
    expect(validateArtifactFragment("x".repeat(MAX_ARTIFACT_FRAGMENT + 1)).ok).toBe(false);
    expect(validateArtifactFragment("<h1>ok</h1><script>function( {</script>").ok).toBe(false);
    expect(validateArtifactFragment("<h1>ok</h1><script>const a = 1;</script>").ok).toBe(true);
    expect(validateArtifactFragment("<div>Card.barChart({a:1})</div>").ok).toBe(false);
  });

  it("render_artifact saves the artifact, emits an `artifact` reference, asks for a text reply", async () => {
    const saved: any[] = [];
    const refs: any[] = [];
    const [renderArtifact] = makeArtifactTools({
      saveArtifact: (a) => {
        const rec = { id: "art123", title: a.title };
        saved.push(a);
        return rec;
      },
      onReference: (r) => refs.push(r),
    });
    const out = await renderArtifact.invoke({ title: "Amortisation", html: "<div class='wrap'><h1>x</h1></div>" });
    expect(saved).toHaveLength(1);
    expect(refs).toEqual([{ type: "artifact", id: "art123" }]);
    expect(String(out)).toMatch(/Artifacts tab/i);
  });

  it("render_artifact bounces a broken fragment back to the model", async () => {
    const [renderArtifact] = makeArtifactTools({ saveArtifact: () => ({ id: "x", title: "x" }) });
    const out = await renderArtifact.invoke({ title: "x", html: "<script>oops(</script>" });
    expect(String(out)).toMatch(/syntax error/i);
  });
});

describe("HTTP API — artifacts", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let realDataDir: string;
  const wasEnabled = config.artifactsEnabled;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-artifacts-"));
    config.artifactsEnabled = true;
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
    config.artifactsEnabled = wasEnabled;
    vi.restoreAllMocks();
  });

  it("/health reports the flag", async () => {
    expect((await app.inject("/health")).json().artifacts).toBe("on");
    config.artifactsEnabled = false;
    expect((await app.inject("/health")).json().artifacts).toBe("off");
  });

  it("list omits html; GET :id returns the wrapped document; per-user isolation", async () => {
    const a = store.scoped(admin.user.id).createArtifact({ title: "Guide", html: "<div class='wrap'>body</div>" });

    const list = await authInject(app, admin.token)("/artifacts");
    expect(list.json().artifacts).toHaveLength(1);
    expect(list.json().artifacts[0]).toMatchObject({ id: a.id, title: "Guide" });
    expect(list.json().artifacts[0].html).toBeUndefined();

    const one = await authInject(app, admin.token)(`/artifacts/${a.id}`);
    expect(one.json().artifact.html).toBe("<div class='wrap'>body</div>");
    expect(one.json().artifact.document).toContain("<!doctype html>");
    expect(one.json().artifact.document).toContain("body");

    // a different user can't see it
    const asMember = await authInject(app, member.token)(`/artifacts/${a.id}`);
    expect(asMember.statusCode).toBe(404);
    expect((await authInject(app, member.token)("/artifacts")).json().artifacts).toHaveLength(0);
  });

  it("rename + delete", async () => {
    const a = store.scoped(admin.user.id).createArtifact({ title: "Old", html: "<p>x</p>" });
    const renamed = await authInject(app, admin.token)({
      method: "PATCH",
      url: `/artifacts/${a.id}`,
      payload: { title: "New name" },
    });
    expect(renamed.json().artifact.title).toBe("New name");

    const del = await authInject(app, admin.token)({ method: "DELETE", url: `/artifacts/${a.id}` });
    expect(del.json().deleted).toBe(true);
    expect((await authInject(app, admin.token)(`/artifacts/${a.id}`)).statusCode).toBe(404);
  });

  it("routes 404 when the feature is off", async () => {
    config.artifactsEnabled = false;
    expect((await authInject(app, admin.token)("/artifacts")).statusCode).toBe(404);
  });

  it("a persisted `artifact` chat reference resolves to the artifact's title", async () => {
    const scoped = store.scoped(admin.user.id);
    const a = scoped.createArtifact({ title: "Budget explainer", html: "<p>x</p>" });
    const session = scoped.createChatSession("hi");
    scoped.addChatMessage(session.id, "assistant", "See the artifact.", [], [
      { type: "artifact", id: a.id, label: "Budget explainer" },
    ]);
    const res = await authInject(app, admin.token)(`/chat/sessions/${session.id}/messages`);
    const msg = res.json().messages.at(-1);
    expect(msg.refs).toEqual([{ type: "artifact", id: a.id, label: "Budget explainer" }]);
  });
});
