import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config, envLocked } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// These exercise the HTTP contract without requiring a live model — /chat and
// the async extraction leg of /documents/ingest are covered separately in
// agents.integration.test.ts against the real local model.
describe("HTTP API", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    inject = authInject(app, admin.token);
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /health reports ok, the model, and setup/discovery fields", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe("gemma4:e2b");
    expect(typeof body.serverName).toBe("string");
    expect(body.needsSetup).toBe(false); // an admin was seeded
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    expect((await app.inject({ method: "GET", url: "/tasks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/activity" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/tasks", headers: { authorization: "Bearer nope" } })).statusCode
    ).toBe(401);
  });

  it("POST /tasks creates a task, GET /tasks lists it", async () => {
    const create = await inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "Buy stamps", dueDate: "2026-09-10" },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().task.title).toBe("Buy stamps");

    const list = await inject({ method: "GET", url: "/tasks" });
    expect(list.json().tasks).toHaveLength(1);
  });

  it("POST /tasks rejects a missing title", async () => {
    const res = await inject({ method: "POST", url: "/tasks", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /tasks/:id marks a task done, 404s for unknown id", async () => {
    const create = await inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const id = create.json().task.id;

    const ok = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: { status: "done" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().task.status).toBe("done");

    const missing = await inject({ method: "PATCH", url: "/tasks/nope", payload: { status: "done" } });
    expect(missing.statusCode).toBe(404);
  });

  it("PATCH /tasks/:id reschedules and clears a due date, rejects an empty body", async () => {
    const create = await inject({ method: "POST", url: "/tasks", payload: { title: "Vet visit" } });
    const id = create.json().task.id;

    const moved = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: { dueDate: "2026-12-01" } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().task.dueDate).toBe("2026-12-01");

    const cleared = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: { dueDate: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().task.dueDate).toBeNull();

    const empty = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("POST /tasks accepts a dueTime, PATCH can change and clear it", async () => {
    const create = await inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "Dentist", dueDate: "2026-10-15", dueTime: "09:30" },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().task.dueTime).toBe("09:30");
    const id = create.json().task.id;

    const moved = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: { dueTime: "11:00" } });
    expect(moved.json().task.dueTime).toBe("11:00");

    const allDay = await inject({ method: "PATCH", url: `/tasks/${id}`, payload: { dueTime: null } });
    expect(allDay.json().task.dueTime).toBeNull();
    expect(allDay.json().task.dueDate).toBe("2026-10-15");
  });

  it("keeps two users' tasks isolated over HTTP", async () => {
    const member = seedUser(store, { username: "kid", role: "member" });
    const asMember = authInject(app, member.token);

    await inject({ method: "POST", url: "/tasks", payload: { title: "admin task" } });
    await asMember({ method: "POST", url: "/tasks", payload: { title: "kid task" } });

    expect((await inject({ method: "GET", url: "/tasks" })).json().tasks.map((t: any) => t.title)).toEqual(["admin task"]);
    expect((await asMember({ method: "GET", url: "/tasks" })).json().tasks.map((t: any) => t.title)).toEqual(["kid task"]);
  });

  it("POST /documents/ingest stores the raw document immediately", async () => {
    const res = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "test.txt", text: "hello world" },
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json().document;
    expect(doc.filename).toBe("test.txt");
    expect(doc.extracted).toBeNull();
    expect(doc.extractionStatus).toBe("pending");

    const list = await inject({ method: "GET", url: "/documents" });
    expect(list.json().documents).toHaveLength(1);
  });

  it("DELETE /documents/:id removes a document, 404s when it's gone", async () => {
    const created = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "junk.txt", text: "x" },
    });
    const id = created.json().document.id;

    const del = await inject({ method: "DELETE", url: `/documents/${id}` });
    expect(del.statusCode).toBe(200);

    const list = await inject({ method: "GET", url: "/documents" });
    expect(list.json().documents).toHaveLength(0);

    const again = await inject({ method: "DELETE", url: `/documents/${id}` });
    expect(again.statusCode).toBe(404);
  });

  it("POST /documents/:id/retry-extraction resets a failed doc, 404s for unknown", async () => {
    const created = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "x.txt", text: "y" },
    });
    const id = created.json().document.id;
    admin.scoped.setDocumentExtractionStatus(id, "failed");

    const retry = await inject({ method: "POST", url: `/documents/${id}/retry-extraction` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().document.extractionStatus).toBe("pending");

    const missing = await inject({ method: "POST", url: "/documents/nope/retry-extraction" });
    expect(missing.statusCode).toBe(404);
  });

  // FormData + Response is the standard-library way to build a real multipart
  // body without a separate form-data package — Node has had both globally
  // since 18.
  async function multipart(filename: string, content: string, type = "text/plain") {
    const fd = new FormData();
    fd.append("file", new Blob([content], { type }), filename);
    const res = new Response(fd);
    return { contentType: res.headers.get("content-type")!, body: Buffer.from(await res.arrayBuffer()) };
  }

  it("POST /documents/upload accepts a text file", async () => {
    const { contentType, body } = await multipart("note.txt", "hello from upload");
    const res = await inject({
      method: "POST",
      url: "/documents/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json().document;
    expect(doc.filename).toBe("note.txt");
    expect(doc.rawText).toBe("hello from upload");
  });

  it("POST /documents/upload rejects an unsupported file type with a helpful message", async () => {
    const { contentType, body } = await multipart("resume.docx", "not real", "application/octet-stream");
    const res = await inject({
      method: "POST",
      url: "/documents/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(".docx");
  });

  it("POST /documents/upload rejects an empty file", async () => {
    const { contentType, body } = await multipart("empty.txt", "");
    const res = await inject({
      method: "POST",
      url: "/documents/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("answers CORS preflight for the desktop webview origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/tasks",
      headers: { origin: "http://localhost:1420", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:1420");
  });

  // Regression test: @fastify/cors defaults to allowing only GET/HEAD/POST.
  it.each(["PATCH", "PUT"] as const)(
    "CORS preflight allows %s (not just the @fastify/cors default GET/HEAD/POST)",
    async (method) => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/tasks",
        headers: { origin: "http://localhost:1420", "access-control-request-method": method },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-methods"]).toContain(method);
    }
  );

  // ---- auth handshake ----
  it("GET /auth/status reports whether setup is needed", async () => {
    const fresh = buildServer(new Store(":memory:"));
    expect((await fresh.inject({ method: "GET", url: "/auth/status" })).json().needsSetup).toBe(true);
    await fresh.close();

    // This app already has a seeded admin.
    expect((await app.inject({ method: "GET", url: "/auth/status" })).json().needsSetup).toBe(false);
  });

  it("POST /auth/bootstrap creates the first admin, then refuses a second time", async () => {
    const s = new Store(":memory:");
    const fresh = buildServer(s);
    const boot = await fresh.inject({
      method: "POST",
      url: "/auth/bootstrap",
      payload: { serverName: "The Tests", username: "root", displayName: "Root", password: "sekret123" },
    });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().user).toMatchObject({ username: "root", role: "admin" });
    expect(typeof boot.json().token).toBe("string");

    const again = await fresh.inject({
      method: "POST",
      url: "/auth/bootstrap",
      payload: { username: "other", displayName: "Other", password: "sekret123" },
    });
    expect(again.statusCode).toBe(409);
    await fresh.close();
  });

  it("POST /auth/bootstrap claims data left by a single-user database", async () => {
    const s = new Store(":memory:");
    // A row owned by the legacy sentinel, as a migrated single-user DB has.
    s.scoped("_legacy_").createTask({ title: "from before accounts" });
    const fresh = buildServer(s);
    const boot = await fresh.inject({
      method: "POST",
      url: "/auth/bootstrap",
      payload: { username: "root", displayName: "Root", password: "sekret123" },
    });
    const token = boot.json().token;
    const tasks = await fresh.inject({ method: "GET", url: "/tasks", headers: { authorization: `Bearer ${token}` } });
    expect(tasks.json().tasks.map((t: any) => t.title)).toContain("from before accounts");
    await fresh.close();
  });

  it("POST /auth/login issues a token for good credentials, 401s otherwise", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "owner", password: admin.password },
    });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().token).toBe("string");

    const bad = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "owner", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const noUser = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "ghost", password: "whatever" },
    });
    expect(noUser.statusCode).toBe(401);
  });

  it("GET /auth/me returns the caller; logout invalidates the token", async () => {
    expect((await inject({ method: "GET", url: "/auth/me" })).json().user.username).toBe("owner");
    await inject({ method: "POST", url: "/auth/logout" });
    expect((await inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
  });

  // ---- user management ----
  it("GET/POST /users is admin-only", async () => {
    const member = seedUser(store, { username: "kid", role: "member" });
    const asMember = authInject(app, member.token);

    expect((await asMember({ method: "GET", url: "/users" })).statusCode).toBe(403);
    expect((await inject({ method: "GET", url: "/users" })).json().users.length).toBe(2);

    const created = await inject({
      method: "POST",
      url: "/users",
      payload: { username: "mom", displayName: "Mom", password: "sekret123", role: "member" },
    });
    expect(created.statusCode).toBe(200);
    expect((await inject({ method: "GET", url: "/users" })).json().users.length).toBe(3);

    const dupe = await inject({
      method: "POST",
      url: "/users",
      payload: { username: "mom", displayName: "Mom2", password: "sekret123" },
    });
    expect(dupe.statusCode).toBe(409);
  });

  it("PATCH /users/:id: self can change own password, only admin sets role, last admin protected", async () => {
    const member = seedUser(store, { username: "kid", role: "member" });
    const asMember = authInject(app, member.token);

    expect(
      (await asMember({ method: "PATCH", url: `/users/${member.user.id}`, payload: { password: "newpass123" } })).statusCode
    ).toBe(200);
    expect(
      (await asMember({ method: "PATCH", url: `/users/${member.user.id}`, payload: { role: "admin" } })).statusCode
    ).toBe(403);
    expect(
      (await asMember({ method: "PATCH", url: `/users/${admin.user.id}`, payload: { displayName: "hax" } })).statusCode
    ).toBe(403);
    // Admin can't demote themselves while they're the only admin.
    expect(
      (await inject({ method: "PATCH", url: `/users/${admin.user.id}`, payload: { role: "member" } })).statusCode
    ).toBe(400);
  });

  it("DELETE /users/:id: not self, not the last admin, cascades data", async () => {
    const member = seedUser(store, { username: "kid", role: "member" });
    member.scoped.createTask({ title: "kid's task" });

    expect((await inject({ method: "DELETE", url: `/users/${admin.user.id}` })).statusCode).toBe(400);
    expect((await inject({ method: "DELETE", url: `/users/${member.user.id}` })).statusCode).toBe(200);
    expect(store.getUser(member.user.id)).toBeUndefined();
    expect(store.scoped(member.user.id).listTasks()).toHaveLength(0);
  });

  // ---- settings ----
  it("GET /settings returns machine config + this user's inbox folder", async () => {
    const res = await inject({ method: "GET", url: "/settings" });
    const body = res.json();
    expect(body.model).toBe(config.model);
    expect(body.serverName).toBe(config.serverName);
    expect(body.isAdmin).toBe(true);
    expect(body.inboxDir).toContain(admin.user.id);
  });

  it("PUT /settings rejects an empty inboxDir", async () => {
    const res = await inject({ method: "PUT", url: "/settings", payload: { inboxDir: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /settings changes this user's watched folder and restarts their watcher", async () => {
    let calledWith: { userId: string; dir: string } | undefined;
    const s = new Store(":memory:");
    const testApp = buildServer(s, {
      onUserInboxChange: async (userId, dir) => {
        calledWith = { userId, dir };
      },
    });
    const seeded = seedUser(s);
    const asUser = authInject(testApp, seeded.token);
    try {
      const newDir = "/tmp/family-agent-settings-test-inbox";
      const put = await asUser({ method: "PUT", url: "/settings", payload: { inboxDir: newDir } });
      expect(put.statusCode).toBe(200);
      expect(put.json().inboxDir).toBe(newDir);
      expect(calledWith).toEqual({ userId: seeded.user.id, dir: newDir });

      const after = await asUser({ method: "GET", url: "/settings" });
      expect(after.json().inboxDir).toBe(newDir);
    } finally {
      await testApp.close();
    }
  });

  it("PUT /settings machine fields are admin-only", async () => {
    const member = seedUser(store, { username: "kid", role: "member" });
    const asMember = authInject(app, member.token);
    const res = await asMember({ method: "PUT", url: "/settings", payload: { serverName: "Hacked" } });
    expect(res.statusCode).toBe(403);
    // …but the member can still set their own watched folder.
    expect((await asMember({ method: "PUT", url: "/settings", payload: { inboxDir: "/tmp/kid" } })).statusCode).toBe(200);
  });

  // These stub fetch so they don't depend on whether this machine happens to
  // have Ollama running.
  function stubOllamaTags(models: string[] | null) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith("/api/tags")) {
        if (models === null) throw new Error("ECONNREFUSED");
        return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  it("PUT /settings saves an OCR model Ollama has, and can clear it", async () => {
    const original = config.ocrModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    const restore = stubOllamaTags(["gemma4:e2b", "glm-ocr:latest"]);
    try {
      expect((await inject({ method: "GET", url: "/settings" })).json().ocrModel).toBe("");

      const set = await inject({ method: "PUT", url: "/settings", payload: { ocrModel: "glm-ocr:latest" } });
      expect(set.statusCode).toBe(200);
      expect(set.json().ocrModel).toBe("glm-ocr:latest");
      expect(config.ocrModel).toBe("glm-ocr:latest");

      const cleared = await inject({ method: "PUT", url: "/settings", payload: { ocrModel: "" } });
      expect(cleared.json().ocrModel).toBe("");
    } finally {
      restore();
      config.ocrModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings rejects an OCR model Ollama doesn't have (when Ollama is reachable)", async () => {
    const original = config.ocrModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    const restore = stubOllamaTags(["gemma4:e2b"]);
    try {
      const res = await inject({ method: "PUT", url: "/settings", payload: { ocrModel: "not-pulled:latest" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/ollama pull not-pulled:latest/);
      expect(config.ocrModel).toBe(original);
    } finally {
      restore();
      config.ocrModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings with an empty body is a 400", async () => {
    const res = await inject({ method: "PUT", url: "/settings", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /ollama/models lists the models and whether Ollama is reachable", async () => {
    const restore = stubOllamaTags(["gemma4:e2b", "glm-ocr:latest"]);
    try {
      const ok = await inject({ method: "GET", url: "/ollama/models" });
      expect(ok.json()).toEqual({ models: ["gemma4:e2b", "glm-ocr:latest"], reachable: true });
    } finally {
      restore();
    }
  });

  it("PUT /settings changes the chat model and Ollama address (validating against the new address)", async () => {
    const origModel = config.model;
    const origUrl = config.ollamaBaseUrl;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    let modelChangeCalls = 0;
    const s = new Store(":memory:");
    const testApp = buildServer(s, {
      onModelChange: async () => {
        modelChangeCalls++;
      },
    });
    const seeded = seedUser(s);
    const asUser = authInject(testApp, seeded.token);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === "http://10.0.0.9:11434/api/tags") {
        return new Response(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }), { status: 200 });
      }
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await asUser({
        method: "PUT",
        url: "/settings",
        payload: { model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.9:11434" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.9:11434" });
      expect(config.model).toBe("llama3.1:8b");
      expect(modelChangeCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      config.model = origModel;
      config.ollamaBaseUrl = origUrl;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
      await testApp.close();
    }
  });

  it("PUT /settings rejects a non-URL Ollama address", async () => {
    const res = await inject({ method: "PUT", url: "/settings", payload: { ollamaBaseUrl: "not a url" } });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /settings refuses to change an env-pinned field", async () => {
    const locked = envLocked as { -readonly [K in keyof typeof envLocked]: boolean };
    locked.model = true;
    try {
      const res = await inject({ method: "PUT", url: "/settings", payload: { model: "whatever:latest" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/environment variable/);
      expect((await inject({ method: "GET", url: "/settings" })).json().envLocked.model).toBe(true);
    } finally {
      locked.model = false;
    }
  });

  it("GET /activity reflects task mutations for the calling user", async () => {
    await inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const res = await inject({ method: "GET", url: "/activity" });
    expect(res.json().activity.some((a: any) => a.action === "task.created")).toBe(true);
  });

  it("GET/DELETE /tools list and remove a tool", async () => {
    const t = admin.scoped.createTool({ name: "Chore chart", description: "who does what", prompt: "chore chart", kind: "static" });
    admin.scoped.setToolStatus(t.id, "ready");

    const list = await inject({ method: "GET", url: "/tools" });
    expect(list.json().tools[0]).toMatchObject({ id: t.id, name: "Chore chart", status: "ready", path: `/${t.id}/` });

    const one = await inject({ method: "GET", url: `/tools/${t.id}` });
    expect(one.statusCode).toBe(200);

    const del = await inject({ method: "DELETE", url: `/tools/${t.id}` });
    expect(del.statusCode).toBe(200);
    expect((await inject({ method: "GET", url: "/tools" })).json().tools).toHaveLength(0);
    expect((await inject({ method: "GET", url: `/tools/${t.id}` })).statusCode).toBe(404);
  });

  it("POST /tools validates the prompt and reports when disabled", async () => {
    expect((await inject({ method: "POST", url: "/tools", payload: { prompt: "hi" } })).statusCode).toBe(400);

    const originalEnabled = config.toolsEnabled;
    (config as { toolsEnabled: boolean }).toolsEnabled = false;
    try {
      const res = await inject({ method: "POST", url: "/tools", payload: { prompt: "a budget splitter" } });
      expect(res.statusCode).toBe(403);
    } finally {
      (config as { toolsEnabled: boolean }).toolsEnabled = originalEnabled;
    }
  });

  it("GET /health advertises the tools port", async () => {
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(typeof h.toolsPort).toBe("number");
    expect(["full", "static-only", "off"]).toContain(h.toolsEnabled);
  });
});
