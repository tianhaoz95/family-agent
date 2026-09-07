import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  // The settings.json tests write real files under config.dataDir — which now
  // defaults to the user's home. Redirect it to a throwaway dir so a test run
  // can never touch a developer's actual local store.
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-test-"));
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

  it("GET /health reports ok, the model, and setup/discovery fields", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe("gemma4:e2b");
    expect(typeof body.serverName).toBe("string");
    expect(body.needsSetup).toBe(false); // an admin was seeded
    expect(body.compute).toBe(true); // code sandbox on by default
    expect(body.web).toBe("off");
    expect(body.shell).toBe("off");
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

  it("GET /documents/search ranks keyword hits and applies filters", async () => {
    await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "car-insurance.pdf", text: "auto policy renewal" } });
    await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "grocery.txt", text: "milk eggs bread" } });

    const hit = await inject({ method: "GET", url: "/documents/search?q=insurance%20renewal" });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().results.map((r: any) => r.filename)).toEqual(["car-insurance.pdf"]);

    const miss = await inject({ method: "GET", url: "/documents/search?q=insurance&category=school" });
    expect(miss.json().results).toHaveLength(0);
  });

  it("GET /documents/search is scoped to the signed-in user", async () => {
    const member = seedUser(store, { username: "kid2", role: "member" });
    const asMember = authInject(app, member.token);
    await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "admin.txt", text: "shared word receipt" } });
    await asMember({ method: "POST", url: "/documents/ingest", payload: { filename: "kid.txt", text: "shared word receipt" } });

    expect((await inject({ method: "GET", url: "/documents/search?q=receipt" })).json().results.map((r: any) => r.filename)).toEqual(["admin.txt"]);
    expect((await asMember({ method: "GET", url: "/documents/search?q=receipt" })).json().results.map((r: any) => r.filename)).toEqual(["kid.txt"]);
  });

  it("GET /documents/search?mode=fuzzy tolerates a misspelled query", async () => {
    await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "Auto Insurance Policy.pdf", text: "vehicle coverage premium deductible" },
    });
    await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "grocery.txt", text: "milk eggs bread" } });

    const strict = await inject({ method: "GET", url: "/documents/search?q=insurnce&mode=keyword" });
    expect(strict.json().results).toHaveLength(0);

    const fuzzy = await inject({ method: "GET", url: "/documents/search?q=insurnce&mode=fuzzy" });
    expect(fuzzy.statusCode).toBe(200);
    expect(fuzzy.json().results.map((r: any) => r.filename)).toContain("Auto Insurance Policy.pdf");
  });

  it("GET /documents/search ignores an unknown mode and defaults to hybrid", async () => {
    await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "car-insurance.pdf", text: "auto policy renewal" } });
    const res = await inject({ method: "GET", url: "/documents/search?q=insurance%20renewal&mode=bogus" });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: any) => r.filename)).toEqual(["car-insurance.pdf"]);
  });

  it("GET /health reports semanticSearch off when embeddings are disabled", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().semanticSearch).toBe("off");
  });

  it("GET /tasks/search finds a task by keyword and filters by status", async () => {
    await inject({ method: "POST", url: "/tasks", payload: { title: "Renew car registration" } });
    await inject({ method: "POST", url: "/tasks", payload: { title: "Buy stamps" } });

    const res = await inject({ method: "GET", url: "/tasks/search?q=registration" });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: any) => r.title)).toEqual(["Renew car registration"]);

    const none = await inject({ method: "GET", url: "/tasks/search?q=registration&status=done" });
    expect(none.json().results).toHaveLength(0);
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

  it("PATCH /documents/:id renames a document and logs it, 404s for unknown", async () => {
    const created = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "scan_001.pdf", text: "Blue Cross explanation of benefits" },
    });
    const id = created.json().document.id;

    const renamed = await inject({
      method: "PATCH",
      url: `/documents/${id}`,
      payload: { filename: "Blue Cross EOB.pdf" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().document.filename).toBe("Blue Cross EOB.pdf");

    expect((await inject({ method: "GET", url: `/documents/${id}` })).json().document.filename).toBe(
      "Blue Cross EOB.pdf"
    );
    const activity = (await inject({ method: "GET", url: "/activity" })).json().activity;
    expect(activity.some((a: any) => a.action === "document.renamed")).toBe(true);

    expect((await inject({ method: "PATCH", url: "/documents/nope", payload: { filename: "z" } })).statusCode).toBe(404);
    expect((await inject({ method: "PATCH", url: `/documents/${id}`, payload: {} })).statusCode).toBe(400);
  });

  it("a member can't rename another user's document", async () => {
    const created = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "mine.txt", text: "secret" },
    });
    const id = created.json().document.id;
    const member = seedUser(store, { username: "kid3", role: "member" });
    const asMember = authInject(app, member.token);
    expect((await asMember({ method: "PATCH", url: `/documents/${id}`, payload: { filename: "hax.txt" } })).statusCode).toBe(
      404
    );
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

  it("GET /documents/:id/original serves an uploaded file back, 404 for pasted text", async () => {
    const { contentType, body } = await multipart("note.txt", "original bytes here");
    const up = await inject({
      method: "POST",
      url: "/documents/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    const id = up.json().document.id;

    const orig = await inject({ method: "GET", url: `/documents/${id}/original` });
    expect(orig.statusCode).toBe(200);
    expect(orig.headers["content-type"]).toContain("text/plain");
    expect(orig.body).toBe("original bytes here");

    // A pasted-text document has no stored original.
    const pasted = await inject({
      method: "POST",
      url: "/documents/ingest",
      payload: { filename: "typed.txt", text: "just text" },
    });
    const pastedId = pasted.json().document.id;
    expect((await inject({ method: "GET", url: `/documents/${pastedId}/original` })).statusCode).toBe(404);

    // Gone after the document is deleted.
    await inject({ method: "DELETE", url: `/documents/${id}` });
    expect((await inject({ method: "GET", url: `/documents/${id}/original` })).statusCode).toBe(404);
  });

  const userDocsDir = () => join(config.dataDir, "documents", admin.user.id);
  const uploadText = async (filename: string, content: string) => {
    const { contentType, body } = await multipart(filename, content);
    const res = await inject({
      method: "POST",
      url: "/documents/upload",
      headers: { "content-type": contentType },
      payload: body,
    });
    return res.json().document.id as string;
  };

  it("stores an uploaded original under its real filename, extension and all", async () => {
    const id = await uploadText("Tax Return 2025.txt", "line one of the return");
    expect(readdirSync(userDocsDir())).toContain("Tax Return 2025.txt");
    expect(readdirSync(userDocsDir())).not.toContain(id);
    expect((await inject({ method: "GET", url: `/documents/${id}/original` })).body).toBe("line one of the return");
  });

  it("moves the on-disk original when the document is renamed", async () => {
    const id = await uploadText("scan_001.txt", "scanned body text");
    expect(readdirSync(userDocsDir())).toContain("scan_001.txt");

    await inject({ method: "PATCH", url: `/documents/${id}`, payload: { filename: "Passport scan.txt" } });
    const files = readdirSync(userDocsDir());
    expect(files).toContain("Passport scan.txt");
    expect(files).not.toContain("scan_001.txt");
    expect((await inject({ method: "GET", url: `/documents/${id}/original` })).body).toBe("scanned body text");
  });

  it("suffixes a colliding on-disk name instead of clobbering another document", async () => {
    const a = await uploadText("Receipt.txt", "first receipt");
    const b = await uploadText("Receipt.txt", "second receipt");

    const files = readdirSync(userDocsDir()).sort();
    expect(files).toEqual(["Receipt (2).txt", "Receipt.txt"]);
    // Both documents still resolve to their own bytes.
    expect((await inject({ method: "GET", url: `/documents/${a}/original` })).body).toBe("first receipt");
    expect((await inject({ method: "GET", url: `/documents/${b}/original` })).body).toBe("second receipt");
  });

  it("renaming onto an existing name gets a suffix, not a collision", async () => {
    const a = await uploadText("a.txt", "aaa");
    await uploadText("b.txt", "bbb");
    await inject({ method: "PATCH", url: `/documents/${a}`, payload: { filename: "b.txt" } });
    const files = readdirSync(userDocsDir()).sort();
    expect(files).toEqual(["b (2).txt", "b.txt"]);
    expect((await inject({ method: "GET", url: `/documents/${a}/original` })).body).toBe("aaa");
  });

  it("still serves a legacy original saved at the bare <docId> path", async () => {
    const id = (
      await inject({ method: "POST", url: "/documents/ingest", payload: { filename: "old.pdf", text: "legacy body" } })
    ).json().document.id;
    // Simulate a pre-upgrade upload: bytes at documents/<userId>/<docId>, no
    // original_disk_name recorded.
    mkdirSync(userDocsDir(), { recursive: true });
    writeFileSync(join(userDocsDir(), id), "legacy pdf bytes");

    const orig = await inject({ method: "GET", url: `/documents/${id}/original` });
    expect(orig.statusCode).toBe(200);
    expect(orig.body).toBe("legacy pdf bytes");

    // The startup backfill renames it to the real filename and records it.
    const { backfillOriginalDiskNames } = await import("../src/documentFiles.js");
    await backfillOriginalDiskNames(store);
    expect(readdirSync(userDocsDir())).toEqual(["old.pdf"]);
    expect(admin.scoped.getDocument(id)?.originalDiskName).toBe("old.pdf");
    expect((await inject({ method: "GET", url: `/documents/${id}/original` })).body).toBe("legacy pdf bytes");
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

  // /transcribe's happy path needs the Whisper model and is covered in
  // transcribe.test.ts (opt-in). Here: the HTTP contract around it.
  it("POST /transcribe rejects a request with no audio", async () => {
    const res = await inject({ method: "POST", url: "/transcribe", payload: "" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /transcribe 403s when voice input is disabled, and reports it in /health", async () => {
    const original = config.asrEnabled;
    config.asrEnabled = false;
    try {
      const { contentType, body } = await multipart("voice.wav", "RIFFxxxxWAVE", "audio/wav");
      const res = await inject({
        method: "POST",
        url: "/transcribe",
        headers: { "content-type": contentType },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/health" })).json().asrEnabled).toBe(false);
    } finally {
      config.asrEnabled = original;
    }
  });

  it("GET /health reports asrEnabled true by default", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().asrEnabled).toBe(true);
  });

  // /speak's happy path needs the Kokoro model and is covered in tts.test.ts
  // (opt-in). Here: the HTTP contract around it.
  it("POST /speak validates the body (missing text -> 400)", async () => {
    const res = await inject({ method: "POST", url: "/speak", payload: JSON.stringify({}), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
  });

  it("POST /speak 403s when voice output is disabled, and reports it in /health", async () => {
    const original = config.ttsEnabled;
    config.ttsEnabled = false;
    try {
      const res = await inject({
        method: "POST",
        url: "/speak",
        payload: JSON.stringify({ text: "hello" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/health" })).json().ttsEnabled).toBe(false);
      expect((await inject({ method: "GET", url: "/tts/voices" })).statusCode).toBe(403);
    } finally {
      config.ttsEnabled = original;
    }
  });

  it("GET /health reports ttsEnabled true by default", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().ttsEnabled).toBe(true);
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

  it("PUT /settings saves an embedding model Ollama has, and admin-gates it", async () => {
    const original = config.embedModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    const restore = stubOllamaTags(["gemma4:e2b", "nomic-embed-text:latest"]);
    try {
      expect((await inject({ method: "GET", url: "/settings" })).json()).toMatchObject({
        embedModel: original,
        embedEnabled: false, // disabled in the test suite (see test/setup.ts)
      });

      const set = await inject({ method: "PUT", url: "/settings", payload: { embedModel: "nomic-embed-text:latest" } });
      expect(set.statusCode).toBe(200);
      expect(set.json().embedModel).toBe("nomic-embed-text:latest");
      expect(config.embedModel).toBe("nomic-embed-text:latest");

      const member = seedUser(store, { username: "kid-embed", role: "member" });
      const denied = await authInject(app, member.token)({
        method: "PUT",
        url: "/settings",
        payload: { embedModel: "gemma4:e2b" },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      restore();
      config.embedModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings rejects an embedding model Ollama doesn't have", async () => {
    const original = config.embedModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    const restore = stubOllamaTags(["gemma4:e2b"]);
    try {
      const res = await inject({ method: "PUT", url: "/settings", payload: { embedModel: "no-such-embed" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/ollama pull no-such-embed/);
      expect(config.embedModel).toBe(original);
    } finally {
      restore();
      config.embedModel = original;
      if (existsSync(settingsFilePath)) rmSync(settingsFilePath);
    }
  });

  it("PUT /settings saves a voice-input (ASR) model without hitting Ollama, and admin-gates it", async () => {
    const original = config.asrModel;
    const settingsFilePath = `${config.dataDir}/settings.json`;
    try {
      const set = await inject({ method: "PUT", url: "/settings", payload: { asrModel: "Xenova/whisper-small" } });
      expect(set.statusCode).toBe(200);
      expect(set.json().asrModel).toBe("Xenova/whisper-small");
      expect(config.asrModel).toBe("Xenova/whisper-small");

      const member = seedUser(store, { username: "kid2", role: "member" });
      const asMember = authInject(app, member.token);
      const denied = await asMember({ method: "PUT", url: "/settings", payload: { asrModel: "Xenova/whisper-tiny" } });
      expect(denied.statusCode).toBe(403);
      expect(config.asrModel).toBe("Xenova/whisper-small");
    } finally {
      config.asrModel = original;
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
    expect(list.json().tools[0]).toMatchObject({
      id: t.id,
      name: "Chore chart",
      status: "ready",
      path: `/${t.id}/`,
      revisionCount: 0,
      revisionState: null,
      canRevert: false,
    });

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

  it("POST /tools/:id/iterate validates input, 404s for a missing tool, 409s while revising", async () => {
    expect(
      (await inject({ method: "POST", url: "/tools/NOPE/iterate", payload: { instruction: "add a date field" } })).statusCode
    ).toBe(404);

    const short = admin.scoped.createTool({ name: "A", description: "d", prompt: "p", kind: "static" });
    admin.scoped.setToolStatus(short.id, "ready");
    expect(
      (await inject({ method: "POST", url: `/tools/${short.id}/iterate`, payload: { instruction: "x" } })).statusCode
    ).toBe(400);

    const busy = admin.scoped.createTool({ name: "B", description: "d", prompt: "p", kind: "static" });
    admin.scoped.setToolStatus(busy.id, "ready");
    admin.scoped.beginToolRevision(busy.id);
    expect(
      (await inject({ method: "POST", url: `/tools/${busy.id}/iterate`, payload: { instruction: "a real change" } })).statusCode
    ).toBe(409);
  });

  it("POST /tools/:id/revert restores the previous version and clears prev/", async () => {
    const t = admin.scoped.createTool({ name: "Packing list", description: "v2", prompt: "packing list", kind: "static" });
    admin.scoped.setToolStatus(t.id, "ready");
    const dir = join(config.dataDir, "tools", t.id);
    mkdirSync(join(dir, "prev"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>v2</title>current");
    writeFileSync(join(dir, "prev", "index.html"), "<!doctype html><title>v1</title>previous");
    writeFileSync(join(dir, "prev", "meta.json"), JSON.stringify({ name: "Packing list", description: "v1", kind: "static" }));

    expect((await inject({ method: "GET", url: `/tools/${t.id}` })).json().tool.canRevert).toBe(true);

    const res = await inject({ method: "POST", url: `/tools/${t.id}/revert` });
    expect(res.statusCode).toBe(200);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("previous");
    expect(existsSync(join(dir, "prev"))).toBe(false);
    expect(res.json().tool.canRevert).toBe(false);
    expect(admin.scoped.getTool(t.id)!.description).toBe("v1");

    // nothing to revert now
    expect((await inject({ method: "POST", url: `/tools/${t.id}/revert` })).statusCode).toBe(400);
  });

  it("GET /tools/:id/operations returns the cached MCP operation list", async () => {
    const t = admin.scoped.createTool({ name: "Item Tracker", description: "where stuff is", prompt: "x", kind: "server" });
    admin.scoped.setToolStatus(t.id, "ready");

    // No cache yet.
    expect((await inject({ method: "GET", url: `/tools/${t.id}/operations` })).json().operations).toEqual([]);

    // Stand in for what toolMcp.refreshManifest writes at build time.
    const dir = join(config.dataDir, "tools", t.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        name: "Item Tracker",
        operations: [
          { name: "find_item", description: "look up an item", access: "read", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
          { name: "save_item", description: "record an item", access: "write", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );

    const res = await inject({ method: "GET", url: `/tools/${t.id}/operations` });
    expect(res.statusCode).toBe(200);
    expect(res.json().operations.map((o: any) => `${o.name}:${o.access}`)).toEqual(["find_item:read", "save_item:write"]);

    expect((await inject({ method: "GET", url: "/tools/NOPE/operations" })).statusCode).toBe(404);
  });

  // ---- tool database inspector ----
  // Stands in for what tools/harness.ts writes at runtime: a server tool with
  // its own SQLite db under <dataDir>/tools/<id>/data/tool.db.
  function seedServerToolDb(scoped: typeof admin.scoped, seed?: (db: DatabaseSync) => void) {
    const t = scoped.createTool({ name: "Chore points", description: "points ledger", prompt: "x", kind: "server" });
    scoped.setToolStatus(t.id, "ready");
    const dir = join(config.dataDir, "tools", t.id, "data");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "tool.db"));
    db.exec("CREATE TABLE _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE points (id INTEGER PRIMARY KEY, who TEXT NOT NULL, n INTEGER DEFAULT 0)");
    db.prepare("INSERT INTO points (who, n) VALUES (?, ?)").run("ada", 3);
    db.prepare("INSERT INTO points (who, n) VALUES (?, ?)").run("bo", 7);
    db.prepare("INSERT INTO _kv (key, value) VALUES (?, ?)").run("state", '{"round":2}');
    seed?.(db);
    db.close();
    return t;
  }

  it("GET /tools/:id/db returns the schema and row counts for a server tool", async () => {
    const t = seedServerToolDb(admin.scoped);
    const res = await inject({ method: "GET", url: `/tools/${t.id}/db` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(true);
    const points = body.tables.find((x: any) => x.name === "points");
    expect(points).toMatchObject({ type: "table", rowCount: 2 });
    expect(points.columns.map((c: any) => c.name)).toEqual(["id", "who", "n"]);
    expect(points.columns.find((c: any) => c.name === "id").pk).toBe(true);
  });

  it("GET /tools/:id/db reports exists:false when a server tool never ran", async () => {
    const server = admin.scoped.createTool({ name: "Fresh", description: "d", prompt: "x", kind: "server" });
    admin.scoped.setToolStatus(server.id, "ready");
    expect((await inject({ method: "GET", url: `/tools/${server.id}/db` })).json()).toMatchObject({
      kind: "server",
      exists: false,
    });
  });

  it("GET /tools/:id/db + /db/state expose a static tool's saved __state blobs", async () => {
    const stat = admin.scoped.createTool({ name: "Static", description: "d", prompt: "x", kind: "static" });
    admin.scoped.setToolStatus(stat.id, "ready");

    // no data/ dir yet
    expect((await inject({ method: "GET", url: `/tools/${stat.id}/db` })).json()).toMatchObject({
      kind: "static",
      exists: false,
      stateEntries: [],
    });

    const dataDir = join(config.dataDir, "tools", stat.id, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "state.json"), JSON.stringify({ recipes: ["a", "b"], last: 1 }));
    writeFileSync(join(dataDir, "__ls.json"), JSON.stringify({ theme: "dark" }));

    const ov = (await inject({ method: "GET", url: `/tools/${stat.id}/db` })).json();
    expect(ov.exists).toBe(true);
    expect(ov.stateEntries.map((e: any) => e.key).sort()).toEqual(["__ls", "state"]);

    const val = await inject({ method: "GET", url: `/tools/${stat.id}/db/state?key=state` });
    expect(val.json().value).toEqual({ recipes: ["a", "b"], last: 1 });

    expect((await inject({ method: "GET", url: `/tools/${stat.id}/db/state?key=missing` })).statusCode).toBe(400);
    // the SQL routes don't apply to a static tool
    expect((await inject({ method: "GET", url: `/tools/${stat.id}/db/rows?table=x` })).statusCode).toBe(400);
  });

  it("GET /tools/:id/db/rows paginates and sorts", async () => {
    const t = seedServerToolDb(admin.scoped);
    const res = await inject({ method: "GET", url: `/tools/${t.id}/db/rows?table=points&limit=1&offset=1&orderBy=n&dir=desc` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ table: "points", total: 2, limit: 1, offset: 1 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].who).toBe("ada"); // n desc -> [bo(7), ada(3)], offset 1

    expect((await inject({ method: "GET", url: `/tools/${t.id}/db/rows?table=nope` })).statusCode).toBe(400);
    expect((await inject({ method: "GET", url: `/tools/${t.id}/db/rows?table=points&orderBy=bogus` })).statusCode).toBe(400);
  });

  it("POST /tools/:id/db/query runs a read-only statement and refuses writes", async () => {
    const t = seedServerToolDb(admin.scoped);
    const ok = await inject({ method: "POST", url: `/tools/${t.id}/db/query`, payload: { sql: "SELECT who, n FROM points ORDER BY n" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rows.map((r: any) => r.who)).toEqual(["ada", "bo"]);

    for (const sql of ["DELETE FROM points", "UPDATE points SET n = 0", "DROP TABLE points", "SELECT 1; DROP TABLE points"]) {
      const bad = await inject({ method: "POST", url: `/tools/${t.id}/db/query`, payload: { sql } });
      expect(bad.statusCode, sql).toBe(400);
    }
    // the write was blocked, not applied
    expect((await inject({ method: "GET", url: `/tools/${t.id}/db` })).json().tables.find((x: any) => x.name === "points").rowCount).toBe(2);
  });

  it("tool db routes 404 for another user's tool", async () => {
    const t = seedServerToolDb(admin.scoped);
    const stranger = seedUser(store, { username: "stranger", role: "member" });
    const asStranger = authInject(app, stranger.token);
    expect((await asStranger({ method: "GET", url: `/tools/${t.id}/db` })).statusCode).toBe(404);
    expect((await asStranger({ method: "GET", url: `/tools/${t.id}/db/rows?table=points` })).statusCode).toBe(404);
    expect((await asStranger({ method: "POST", url: `/tools/${t.id}/db/query`, payload: { sql: "SELECT 1" } })).statusCode).toBe(404);
  });

  it("GET /health advertises the tools port", async () => {
    const h = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(typeof h.toolsPort).toBe("number");
    expect(["full", "static-only", "off"]).toContain(h.toolsEnabled);
  });

  it("GET /tasks/:id and /documents/:id fetch one item, 404 for a stranger's", async () => {
    const t = admin.scoped.createTask({ title: "Book dentist" });
    const d = admin.scoped.createDocument({ filename: "bill.txt", rawText: "amount due 42" });
    expect((await inject({ method: "GET", url: `/tasks/${t.id}` })).json().task.title).toBe("Book dentist");
    expect((await inject({ method: "GET", url: `/documents/${d.id}` })).json().document.filename).toBe("bill.txt");

    const kid = seedUser(store, { username: "kid", role: "member" });
    const asKid = authInject(app, kid.token);
    expect((await asKid({ method: "GET", url: `/tasks/${t.id}` })).statusCode).toBe(404);
    expect((await asKid({ method: "GET", url: `/documents/${d.id}` })).statusCode).toBe(404);
  });

  // ---- family directory + chat ----

  it("GET /family/members lists every account (name + username only) for any user", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const res = await authInject(app, kid.token)({ method: "GET", url: "/family/members" });
    expect(res.statusCode).toBe(200);
    const members = res.json().members;
    expect(members.map((m: any) => m.username).sort()).toEqual(["kid", "owner"]);
    expect(members[0]).not.toHaveProperty("role");
  });

  it("a DM: create, post, the other member reads it, a non-member is 403", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const outsider = seedUser(store, { username: "gran", role: "member" });
    const asKid = authInject(app, kid.token);
    const asOutsider = authInject(app, outsider.token);

    const created = await inject({
      method: "POST",
      url: "/channels",
      payload: { kind: "dm", memberIds: [kid.user.id] },
    });
    expect(created.statusCode).toBe(200);
    const channelId = created.json().channel.id;

    // Idempotent from the other side.
    const again = await asKid({
      method: "POST",
      url: "/channels",
      payload: { kind: "dm", memberIds: [admin.user.id] },
    });
    expect(again.json().channel.id).toBe(channelId);

    await inject({ method: "POST", url: `/channels/${channelId}/messages`, payload: { body: "hi kid" } });

    const kidView = await asKid({ method: "GET", url: `/channels/${channelId}/messages` });
    expect(kidView.json().messages.map((m: any) => m.body)).toEqual(["hi kid"]);

    expect((await asOutsider({ method: "GET", url: `/channels/${channelId}` })).statusCode).toBe(403);
    expect(
      (await asOutsider({ method: "GET", url: `/channels/${channelId}/messages` })).statusCode
    ).toBe(403);
    expect(
      (await asOutsider({ method: "POST", url: `/channels/${channelId}/messages`, payload: { body: "sneak" } }))
        .statusCode
    ).toBe(403);
  });

  it("an @agent mention drops a pending assistant message into the channel", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const created = await inject({
      method: "POST",
      url: "/channels",
      payload: { kind: "dm", memberIds: [kid.user.id] },
    });
    const channelId = created.json().channel.id;

    await inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      payload: { body: "@agent what documents do we have?" },
    });

    const msgs = (await inject({ method: "GET", url: `/channels/${channelId}/messages` })).json().messages;
    const pending = msgs.find((m: any) => m.senderId === "_agent_");
    expect(pending).toBeTruthy();
    expect(pending.pending).toBe(true); // model call is fire-and-forget; no live model in this suite
  });

  it("a leading \"/\" command in a channel invokes the assistant, like in 1:1 chat", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const channelId = (
      await inject({ method: "POST", url: "/channels", payload: { kind: "dm", memberIds: [kid.user.id] } })
    ).json().channel.id;

    // No @agent, but "/calc …" should still pull in the assistant.
    await inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      payload: { body: "/calc 15% of 80" },
    });
    const msgs = (await inject({ method: "GET", url: `/channels/${channelId}/messages` })).json().messages;
    expect(msgs.some((m: any) => m.senderId === "_agent_")).toBe(true);
    // the user's own message keeps the leading "/" (honest transcript)
    expect(msgs.find((m: any) => m.senderId !== "_agent_").body).toBe("/calc 15% of 80");
  });

  it("a plain channel message with no @agent and no \"/\" does NOT invoke the assistant", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const channelId = (
      await inject({ method: "POST", url: "/channels", payload: { kind: "dm", memberIds: [kid.user.id] } })
    ).json().channel.id;
    await inject({ method: "POST", url: `/channels/${channelId}/messages`, payload: { body: "picking up milk" } });
    const msgs = (await inject({ method: "GET", url: `/channels/${channelId}/messages` })).json().messages;
    expect(msgs.some((m: any) => m.senderId === "_agent_")).toBe(false);
  });

  it("GET /channels shows unread counts and is scoped to the caller", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const created = await inject({
      method: "POST",
      url: "/channels",
      payload: { kind: "group", name: "Household", memberIds: [kid.user.id] },
    });
    const channelId = created.json().channel.id;
    await inject({ method: "POST", url: `/channels/${channelId}/messages`, payload: { body: "chores today" } });

    const kidChannels = (await authInject(app, kid.token)({ method: "GET", url: "/channels" })).json().channels;
    expect(kidChannels).toHaveLength(1);
    expect(kidChannels[0].unreadCount).toBe(1);
    expect(kidChannels[0].title).toBe("Household");

    // A brand-new third account sees no channels at all.
    const gran = seedUser(store, { username: "gran", role: "member" });
    expect((await authInject(app, gran.token)({ method: "GET", url: "/channels" })).json().channels).toEqual([]);
  });

  it("a chat message can carry image attachments (data URIs), echoed back on read", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const created = await inject({
      method: "POST",
      url: "/channels",
      payload: { kind: "dm", memberIds: [kid.user.id] },
    });
    const channelId = created.json().channel.id;
    const img = "data:image/png;base64,iVBORw0KGgo=";

    const posted = await inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      payload: { body: "look at this", images: [img] },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().message.images).toEqual([img]);

    const back = (await inject({ method: "GET", url: `/channels/${channelId}/messages` })).json().messages;
    expect(back[0].images).toEqual([img]);

    // A non-image data URI is rejected.
    const bad = await inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      payload: { body: "nope", images: ["data:text/html,<script>"] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("DELETE /channels/:id: a member removes it for everyone, a non-member is 403", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const outsider = seedUser(store, { username: "gran", role: "member" });
    const asKid = authInject(app, kid.token);
    const asOutsider = authInject(app, outsider.token);

    const created = await inject({
      method: "POST",
      url: "/channels",
      payload: { kind: "group", name: "Household", memberIds: [kid.user.id] },
    });
    const channelId = created.json().channel.id;
    await inject({ method: "POST", url: `/channels/${channelId}/messages`, payload: { body: "hi" } });

    // An outsider can't delete it.
    expect((await asOutsider({ method: "DELETE", url: `/channels/${channelId}` })).statusCode).toBe(403);

    // A member can — and it's gone for the other member too.
    const del = await asKid({ method: "DELETE", url: `/channels/${channelId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(true);
    expect((await inject({ method: "GET", url: "/channels" })).json().channels).toEqual([]);
    expect((await asKid({ method: "GET", url: `/channels/${channelId}/messages` })).statusCode).toBe(403);
  });

  // ---- chat sessions ----
  // POST /chat itself needs a live model for a real reply (covered in
  // agents.integration.test.ts); here we only need to confirm it still does
  // its bookkeeping — lazily creating a session and persisting the user's
  // turn — even when the model call fails, and that the session CRUD routes
  // enforce per-user ownership the same way the channel routes enforce
  // membership.

  // Lazy session creation + persisting a turn end-to-end through POST /chat
  // itself is covered by the live-model test in agents.integration.test.ts —
  // this file's /chat coverage is intentionally limited to what never reaches
  // the model (see the file comment above), same as everywhere else here.

  it("POST /chat with an unknown sessionId 404s instead of silently starting a new one", async () => {
    const res = await inject({ method: "POST", url: "/chat", payload: { message: "hi", sessionId: "nope" } });
    expect(res.statusCode).toBe(404);
  });

  it("GET/PATCH/DELETE /chat/sessions are scoped to the caller", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const asKid = authInject(app, kid.token);

    const session = store.scoped(admin.user.id).createChatSession("what's for dinner?");
    store.scoped(admin.user.id).addChatMessage(session.id, "user", "what's for dinner?");
    store.scoped(admin.user.id).addChatMessage(session.id, "assistant", "How about tacos?");

    // The owner sees it, with both turns in order.
    const own = (await inject({ method: "GET", url: `/chat/sessions/${session.id}/messages` })).json().messages;
    expect(own.map((m: any) => m.body)).toEqual(["what's for dinner?", "How about tacos?"]);

    // Another user gets 404s across the board, not the owner's data.
    expect((await asKid({ method: "GET", url: `/chat/sessions/${session.id}/messages` })).statusCode).toBe(404);
    expect(
      (await asKid({ method: "PATCH", url: `/chat/sessions/${session.id}`, payload: { title: "steal it" } }))
        .statusCode
    ).toBe(404);
    expect((await asKid({ method: "DELETE", url: `/chat/sessions/${session.id}` })).statusCode).toBe(404);
    expect((await asKid({ method: "GET", url: "/chat/sessions" })).json().sessions).toEqual([]);

    // The owner can rename and delete it.
    const renamed = await inject({
      method: "PATCH",
      url: `/chat/sessions/${session.id}`,
      payload: { title: "Dinner plans" },
    });
    expect(renamed.json().session.title).toBe("Dinner plans");

    const deleted = await inject({ method: "DELETE", url: `/chat/sessions/${session.id}` });
    expect(deleted.json().deleted).toBe(true);
    expect((await inject({ method: "GET", url: "/chat/sessions" })).json().sessions).toEqual([]);
    expect((await inject({ method: "DELETE", url: `/chat/sessions/${session.id}` })).statusCode).toBe(404);
  });

  it("a leading '/' with tools disabled replies plainly with no model call, but still persists the turn", async () => {
    const originalEnabled = config.toolsEnabled;
    (config as { toolsEnabled: boolean }).toolsEnabled = false;
    try {
      const res = await inject({ method: "POST", url: "/chat", payload: { message: "/where is the drill?" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().reply).toBe("Tools aren't turned on for this server.");

      const sessionId = res.json().sessionId;
      const messages = (await inject({ method: "GET", url: `/chat/sessions/${sessionId}/messages` })).json()
        .messages;
      // The stored user turn keeps the "/" — an honest transcript of what was typed.
      expect(messages.map((m: { role: string; body: string }) => [m.role, m.body])).toEqual([
        ["user", "/where is the drill?"],
        ["assistant", "Tools aren't turned on for this server."],
      ]);
    } finally {
      (config as { toolsEnabled: boolean }).toolsEnabled = originalEnabled;
    }
  });

  // ---- sticky notes ----

  it("sticky notes: shared board is common, private board is per-user", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const asKid = authInject(app, kid.token);

    const shared = await inject({
      method: "POST",
      url: "/notes",
      payload: { scope: "shared", text: "buy milk", color: "mint" },
    });
    expect(shared.statusCode).toBe(200);
    await inject({ method: "POST", url: "/notes", payload: { scope: "private", text: "owner secret" } });
    await asKid({ method: "POST", url: "/notes", payload: { scope: "private", text: "kid secret" } });

    // Both see the shared note.
    expect((await asKid({ method: "GET", url: "/notes?scope=shared" })).json().notes.map((n: any) => n.text)).toEqual([
      "buy milk",
    ]);
    // Private boards don't cross over.
    expect((await asKid({ method: "GET", url: "/notes?scope=private" })).json().notes.map((n: any) => n.text)).toEqual([
      "kid secret",
    ]);
    expect((await inject({ method: "GET", url: "/notes?scope=private" })).json().notes.map((n: any) => n.text)).toEqual([
      "owner secret",
    ]);
  });

  it("PATCH /notes: a member can edit a shared note but not another's private note", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const asKid = authInject(app, kid.token);

    const sharedId = (
      await inject({ method: "POST", url: "/notes", payload: { scope: "shared", text: "draft" } })
    ).json().note.id;
    const privId = (
      await inject({ method: "POST", url: "/notes", payload: { scope: "private", text: "mine" } })
    ).json().note.id;

    expect(
      (await asKid({ method: "PATCH", url: `/notes/${sharedId}`, payload: { text: "final" } })).statusCode
    ).toBe(200);
    expect(
      (await asKid({ method: "PATCH", url: `/notes/${privId}`, payload: { text: "hacked" } })).statusCode
    ).toBe(404);
    expect((await asKid({ method: "DELETE", url: `/notes/${privId}` })).statusCode).toBe(404);
  });

  it("POST /notes accepts a blank note; PATCH /notes moves it by position", async () => {
    const created = await inject({
      method: "POST",
      url: "/notes",
      payload: { scope: "shared", x: 40, y: 60 },
    });
    expect(created.statusCode).toBe(200);
    const note = created.json().note;
    expect(note.text).toBe("");
    expect({ x: note.x, y: note.y }).toEqual({ x: 40, y: 60 });

    const moved = await inject({
      method: "PATCH",
      url: `/notes/${note.id}`,
      payload: { x: 200, y: 150 },
    });
    expect(moved.statusCode).toBe(200);
    expect({ x: moved.json().note.x, y: moved.json().note.y }).toEqual({ x: 200, y: 150 });

    // Empty patch is still rejected.
    expect((await inject({ method: "PATCH", url: `/notes/${note.id}`, payload: {} })).statusCode).toBe(400);
    // Non-finite coordinates are rejected.
    expect(
      (await inject({ method: "PATCH", url: `/notes/${note.id}`, payload: { x: 1e9 } })).statusCode
    ).toBe(400);
  });
});
