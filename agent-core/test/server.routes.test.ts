import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";

// These exercise the HTTP contract without requiring a live model — /chat and
// the async extraction leg of /documents/ingest are covered separately in
// agents.integration.test.ts against the real local model.
describe("HTTP API", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServer(new Store(":memory:"));
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /health reports ok and the configured model", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe("gemma4:e2b");
    expect(typeof body.inboxDir).toBe("string");
  });

  it("POST /tasks creates a task, GET /tasks lists it", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { title: "Buy stamps", dueDate: "2026-09-10" },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json().task;
    expect(created.title).toBe("Buy stamps");

    const list = await app.inject({ method: "GET", url: "/tasks" });
    expect(list.json().tasks).toHaveLength(1);
  });

  it("POST /tasks rejects a missing title", async () => {
    const res = await app.inject({ method: "POST", url: "/tasks", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /tasks/:id marks a task done, 404s for unknown id", async () => {
    const create = await app.inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const id = create.json().task.id;

    const ok = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { status: "done" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().task.status).toBe("done");

    const missing = await app.inject({ method: "PATCH", url: "/tasks/nope", payload: { status: "done" } });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /documents/ingest stores the raw document immediately", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "test.txt", text: "hello world" },
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json().document;
    expect(doc.filename).toBe("test.txt");
    expect(doc.extracted).toBeNull();

    const list = await app.inject({ method: "GET", url: "/documents" });
    expect(list.json().documents).toHaveLength(1);
  });

  // FormData + Response is the standard-library way to build a real,
  // spec-correct multipart/form-data body (boundary and all) without a
  // separate form-data package — Node has had both globally since 18.
  async function multipart(filename: string, content: string, type = "text/plain") {
    const fd = new FormData();
    fd.append("file", new Blob([content], { type }), filename);
    const res = new Response(fd);
    return { contentType: res.headers.get("content-type")!, body: Buffer.from(await res.arrayBuffer()) };
  }

  it("POST /documents/upload accepts a text file", async () => {
    const { contentType, body } = await multipart("note.txt", "hello from upload");
    const res = await app.inject({
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
    const res = await app.inject({
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
    const res = await app.inject({
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
  // app.inject() (used everywhere else in this file) and curl both bypass
  // real CORS preflight entirely, so a missing PATCH/PUT entry here would
  // never fail any of those — only a real browser enforces this. Confirmed
  // broken in the actual desktop webview before this test/fix existed.
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

  it("PUT /settings rejects an empty inboxDir", async () => {
    const res = await app.inject({ method: "PUT", url: "/settings", payload: { inboxDir: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("GET/PUT /settings updates the watched folder and restarts the watcher via the provided callback", async () => {
    // config is a shared singleton mutated by the PUT handler — restore it
    // and delete the file it writes so this test doesn't leak into a real
    // run of the app on this machine (config.dataDir is the real data dir
    // in tests, since it's fixed at module load, not overridable per-test).
    const originalInboxDir = config.inboxDir;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    let calledWith: string | undefined;
    const testApp = buildServer(new Store(":memory:"), async (dir) => {
      calledWith = dir;
    });
    try {
      const before = await testApp.inject({ method: "GET", url: "/settings" });
      expect(before.json().inboxDir).toBe(originalInboxDir);

      const newDir = "/tmp/family-agent-settings-test-inbox";
      const put = await testApp.inject({ method: "PUT", url: "/settings", payload: { inboxDir: newDir } });
      expect(put.statusCode).toBe(200);
      expect(put.json().inboxDir).toBe(newDir);
      expect(calledWith).toBe(newDir); // watcher-restart callback actually invoked

      const after = await testApp.inject({ method: "GET", url: "/settings" });
      expect(after.json().inboxDir).toBe(newDir);

      const health = await testApp.inject({ method: "GET", url: "/health" });
      expect(health.json().inboxDir).toBe(newDir);
    } finally {
      config.inboxDir = originalInboxDir;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
      await testApp.close();
    }
  });

  it("GET /activity reflects task and document mutations", async () => {
    await app.inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const res = await app.inject({ method: "GET", url: "/activity" });
    const activity = res.json().activity;
    expect(activity.some((a: any) => a.action === "task.created")).toBe(true);
  });
});
