import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";

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

  it("answers CORS preflight for the desktop webview origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/tasks",
      headers: { origin: "http://localhost:1420", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:1420");
  });

  it("GET /activity reflects task and document mutations", async () => {
    await app.inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const res = await app.inject({ method: "GET", url: "/activity" });
    const activity = res.json().activity;
    expect(activity.some((a: any) => a.action === "task.created")).toBe(true);
  });
});
