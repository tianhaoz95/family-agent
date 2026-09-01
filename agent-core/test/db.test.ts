import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { Store } from "../src/db.js";

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("creates and lists tasks", () => {
    store.createTask({ title: "Renew passport", dueDate: "2026-10-01" });
    store.createTask({ title: "Pay water bill" });

    const tasks = store.listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title)).toContain("Renew passport");
    expect(tasks.every((t) => t.status === "open")).toBe(true);
  });

  it("filters tasks by status", () => {
    const t1 = store.createTask({ title: "A" });
    store.createTask({ title: "B" });
    store.updateTaskStatus(t1.id, "done");

    expect(store.listTasks("done")).toHaveLength(1);
    expect(store.listTasks("open")).toHaveLength(1);
  });

  it("completing an unknown task returns undefined and does not throw", () => {
    expect(store.updateTaskStatus("nope", "done")).toBeUndefined();
  });

  it("creates a document and later attaches an extraction", () => {
    const doc = store.createDocument({ filename: "bill.txt", rawText: "Due $120 on 2026-09-15" });
    expect(doc.extracted).toBeNull();
    expect(doc.sourcePath).toBeNull();

    const updated = store.updateDocumentExtraction(doc.id, {
      category: "bill",
      summary: "Utility bill for $120",
      importantDates: ["2026-09-15"],
    });

    expect(updated?.extracted).toMatchObject({ category: "bill" });
    expect(store.getDocument(doc.id)?.extracted).toMatchObject({ category: "bill" });
  });

  it("finds a document by its watched-folder source path, dedupes on it", () => {
    const doc = store.createDocument({ filename: "a.txt", rawText: "x", sourcePath: "/inbox/a.txt" });
    expect(store.findDocumentBySourcePath("/inbox/a.txt")?.id).toBe(doc.id);
    expect(store.findDocumentBySourcePath("/inbox/missing.txt")).toBeUndefined();
  });

  it("logs activity for every mutating call", () => {
    store.createTask({ title: "A" });
    const activity = store.listActivity();
    expect(activity.length).toBeGreaterThanOrEqual(1);
    expect(activity[0].action).toBe("task.created");
  });

  it("upgrades a pre-source_path database instead of failing every document insert", () => {
    // A database as created by a build before the source_path column existed.
    const path = `/tmp/family-agent-legacy-${Date.now()}.db`;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        raw_text TEXT NOT NULL,
        extracted TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE activity (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, detail TEXT NOT NULL
      );
    `);
    legacy.close();

    const legacyDoc = { id: "OLD12345", filename: "old.pdf" };
    const reopen = new DatabaseSync(path);
    reopen.prepare(
      "INSERT INTO documents (id, filename, raw_text, extracted, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(legacyDoc.id, legacyDoc.filename, "text", null, new Date().toISOString());
    reopen.close();

    const store = new Store(path);
    const doc = store.createDocument({ filename: "bill.pdf", rawText: "Due Oct 3" });
    expect(doc.sourcePath).toBeNull();
    expect(doc.extractionStatus).toBe("pending");
    expect(store.getDocument(doc.id)?.filename).toBe("bill.pdf");
    // A pre-existing row with no fields is treated as a failed extraction,
    // not left as an eternal "Extracting…".
    expect(store.getDocument(legacyDoc.id)?.extractionStatus).toBe("failed");
    store.close();
    unlinkSync(path);
  });

  it("deletes a document and logs it", () => {
    const doc = store.createDocument({ filename: "junk.txt", rawText: "x" });
    expect(store.deleteDocument(doc.id)?.id).toBe(doc.id);
    expect(store.getDocument(doc.id)).toBeUndefined();
    expect(store.deleteDocument(doc.id)).toBeUndefined();
    expect(store.listActivity().some((a) => a.action === "document.deleted")).toBe(true);
  });

  it("fails stale pending extractions on startup", () => {
    const path = `/tmp/family-agent-pending-${Date.now()}.db`;
    const s1 = new Store(path);
    s1.createDocument({ filename: "a.txt", rawText: "x" }); // left pending
    s1.close();

    const s2 = new Store(path);
    // Reopening does not itself reset (that's the server's job) — call it.
    expect(s2.failStalePendingExtractions()).toBe(1);
    expect(s2.listDocuments()[0].extractionStatus).toBe("failed");
    s2.close();
    unlinkSync(path);
  });

  it("persists to disk and reopens", () => {
    const path = `/tmp/family-agent-test-${Date.now()}.db`;
    const s1 = new Store(path);
    s1.createTask({ title: "Persisted task" });
    s1.close();

    const s2 = new Store(path);
    expect(s2.listTasks().map((t) => t.title)).toContain("Persisted task");
    s2.close();
  });
});
