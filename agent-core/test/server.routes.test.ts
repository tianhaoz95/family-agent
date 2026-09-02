import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config, envLocked } from "../src/config.js";

// These exercise the HTTP contract without requiring a live model — /chat and
// the async extraction leg of /documents/ingest are covered separately in
// agents.integration.test.ts against the real local model.
describe("HTTP API", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
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
    expect(doc.extractionStatus).toBe("pending");
  });

  it("DELETE /documents/:id removes a document, 404s when it's gone", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "junk.txt", text: "junk" },
    });
    const id = created.json().document.id;

    const del = await app.inject({ method: "DELETE", url: `/documents/${id}` });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/documents" });
    expect(list.json().documents).toHaveLength(0);

    const again = await app.inject({ method: "DELETE", url: `/documents/${id}` });
    expect(again.statusCode).toBe(404);
  });

  it("POST /documents/:id/retry-extraction resets a failed document to pending", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "bill.txt", text: "amount due" },
    });
    const id = created.json().document.id;
    store.setDocumentExtractionStatus(id, "failed");

    const retry = await app.inject({ method: "POST", url: `/documents/${id}/retry-extraction` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().document.extractionStatus).toBe("pending");

    const missing = await app.inject({ method: "POST", url: "/documents/nope/retry-extraction" });
    expect(missing.statusCode).toBe(404);
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

  // These stub fetch so they don't depend on whether this machine happens to
  // have Ollama running (it does in CI-less local dev, it doesn't in CI).
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
      expect((await app.inject({ method: "GET", url: "/settings" })).json().ocrModel).toBe("");

      const set = await app.inject({ method: "PUT", url: "/settings", payload: { ocrModel: "glm-ocr:latest" } });
      expect(set.statusCode).toBe(200);
      expect(set.json().ocrModel).toBe("glm-ocr:latest");
      expect(config.ocrModel).toBe("glm-ocr:latest");

      const cleared = await app.inject({ method: "PUT", url: "/settings", payload: { ocrModel: "" } });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().ocrModel).toBe("");
      expect(config.ocrModel).toBe("");
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
      const res = await app.inject({ method: "PUT", url: "/settings", payload: { ocrModel: "not-pulled:latest" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/ollama pull not-pulled:latest/);
      expect(config.ocrModel).toBe(original);
    } finally {
      restore();
      config.ocrModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings saves the OCR model unchecked when Ollama is unreachable", async () => {
    const original = config.ocrModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    const restore = stubOllamaTags(null);
    try {
      const res = await app.inject({ method: "PUT", url: "/settings", payload: { ocrModel: "glm-ocr:latest" } });
      expect(res.statusCode).toBe(200);
      expect(config.ocrModel).toBe("glm-ocr:latest");
    } finally {
      restore();
      config.ocrModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings with an empty body is a 400", async () => {
    const res = await app.inject({ method: "PUT", url: "/settings", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /ollama/models lists the models and whether Ollama is reachable", async () => {
    const restore = stubOllamaTags(["gemma4:e2b", "glm-ocr:latest"]);
    try {
      const ok = await app.inject({ method: "GET", url: "/ollama/models" });
      expect(ok.json()).toEqual({ models: ["gemma4:e2b", "glm-ocr:latest"], reachable: true });
    } finally {
      restore();
    }
    const down = stubOllamaTags(null);
    try {
      const res = await app.inject({ method: "GET", url: "/ollama/models" });
      expect(res.json()).toEqual({ models: [], reachable: false });
    } finally {
      down();
    }
  });

  it("PUT /settings changes the chat model and Ollama address (validating the model against the new address)", async () => {
    const origModel = config.model;
    const origUrl = config.ollamaBaseUrl;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    let modelChangeCalls = 0;
    const testApp = buildServer(new Store(":memory:"), undefined, async () => {
      modelChangeCalls++;
    });
    // model check hits the *new* base URL — return the model only for that host.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url) === "http://10.0.0.9:11434/api/tags") {
        return new Response(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }), { status: 200 });
      }
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const res = await testApp.inject({
        method: "PUT",
        url: "/settings",
        payload: { model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.9:11434" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.9:11434" });
      expect(config.model).toBe("llama3.1:8b");
      expect(config.ollamaBaseUrl).toBe("http://10.0.0.9:11434");
      expect(modelChangeCalls).toBe(1);

      const health = await testApp.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({ model: "llama3.1:8b", ollamaBaseUrl: "http://10.0.0.9:11434" });
    } finally {
      globalThis.fetch = realFetch;
      config.model = origModel;
      config.ollamaBaseUrl = origUrl;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
      await testApp.close();
    }
  });

  it("PUT /settings rejects a non-URL Ollama address", async () => {
    const res = await app.inject({ method: "PUT", url: "/settings", payload: { ollamaBaseUrl: "not a url" } });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /settings refuses to change an env-pinned field", async () => {
    const locked = envLocked as { -readonly [K in keyof typeof envLocked]: boolean };
    locked.model = true;
    try {
      const res = await app.inject({ method: "PUT", url: "/settings", payload: { model: "whatever:latest" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/environment variable/);
      const payload = (await app.inject({ method: "GET", url: "/settings" })).json();
      expect(payload.envLocked.model).toBe(true);
    } finally {
      locked.model = false;
    }
  });

  it("GET /activity reflects task and document mutations", async () => {
    await app.inject({ method: "POST", url: "/tasks", payload: { title: "X" } });
    const res = await app.inject({ method: "GET", url: "/activity" });
    const activity = res.json().activity;
    expect(activity.some((a: any) => a.action === "task.created")).toBe(true);
  });

  it("GET/DELETE /tools list and remove a tool", async () => {
    // Create directly (POST /tools kicks off a slow model build with disk I/O).
    const t = store.createTool({ name: "Chore chart", description: "who does what", prompt: "chore chart", kind: "static" });
    store.setToolStatus(t.id, "ready");

    const list = await app.inject({ method: "GET", url: "/tools" });
    expect(list.json().tools[0]).toMatchObject({ id: t.id, name: "Chore chart", status: "ready", path: `/${t.id}/` });

    const one = await app.inject({ method: "GET", url: `/tools/${t.id}` });
    expect(one.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/tools/${t.id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/tools" })).json().tools).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: `/tools/${t.id}` })).statusCode).toBe(404);
  });

  it("POST /tools validates the prompt and reports when disabled", async () => {
    expect((await app.inject({ method: "POST", url: "/tools", payload: { prompt: "hi" } })).statusCode).toBe(400);

    const originalEnabled = config.toolsEnabled;
    (config as { toolsEnabled: boolean }).toolsEnabled = false;
    try {
      const res = await app.inject({ method: "POST", url: "/tools", payload: { prompt: "a budget splitter" } });
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
