import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { Store, type ScopedStore, LEGACY_USER_ID, toFtsMatchQuery } from "../src/db.js";

describe("Store (scoped to one user)", () => {
  let raw: Store;
  let store: ScopedStore;

  beforeEach(() => {
    raw = new Store(":memory:");
    const user = raw.createUser({ username: "owner", displayName: "Owner", password: "sekret123", role: "admin" });
    store = raw.scoped(user.id);
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

  it("updateTask reschedules and clears a due date", () => {
    const t = store.createTask({ title: "Dentist" });
    expect(t.dueDate).toBeNull();

    const rescheduled = store.updateTask(t.id, { dueDate: "2026-12-01" });
    expect(rescheduled?.dueDate).toBe("2026-12-01");

    const cleared = store.updateTask(t.id, { dueDate: null });
    expect(cleared?.dueDate).toBeNull();

    // status untouched when only dueDate is patched
    expect(cleared?.status).toBe("open");

    expect(store.updateTask("nope", { dueDate: "2026-12-01" })).toBeUndefined();
  });

  it("updateTask sets a time, and clearing the date clears the time too", () => {
    const t = store.createTask({ title: "Dentist", dueDate: "2026-12-01" });

    const timed = store.updateTask(t.id, { dueTime: "09:30" });
    expect(timed?.dueTime).toBe("09:30");

    const retimed = store.updateTask(t.id, { dueTime: "11:00" });
    expect(retimed?.dueTime).toBe("11:00");

    const allDay = store.updateTask(t.id, { dueTime: null });
    expect(allDay?.dueTime).toBeNull();
    expect(allDay?.dueDate).toBe("2026-12-01");

    // re-add a time, then clear the date — time must go with it
    store.updateTask(t.id, { dueTime: "08:00" });
    const cleared = store.updateTask(t.id, { dueDate: null });
    expect(cleared?.dueDate).toBeNull();
    expect(cleared?.dueTime).toBeNull();
  });

  it("createTask drops a time when there is no date", () => {
    const t = store.createTask({ title: "Loose", dueTime: "10:00" });
    expect(t.dueTime).toBeNull();
    const withBoth = store.createTask({ title: "Firm", dueDate: "2026-12-01", dueTime: "10:00" });
    expect(withBoth.dueTime).toBe("10:00");
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

  it("deletes a document and logs it", () => {
    const doc = store.createDocument({ filename: "junk.txt", rawText: "x" });
    expect(store.deleteDocument(doc.id)?.id).toBe(doc.id);
    expect(store.getDocument(doc.id)).toBeUndefined();
    expect(store.deleteDocument(doc.id)).toBeUndefined();
    expect(store.listActivity().some((a) => a.action === "document.deleted")).toBe(true);
  });

  it("tracks builder tools through their lifecycle", () => {
    const tool = store.createTool({ name: "Packing list", description: "pack a bag", prompt: "make me a packing list", kind: "static" });
    expect(tool.status).toBe("building");
    expect(store.listTools()).toHaveLength(1);

    store.renameTool(tool.id, "Beach Packing", "for the beach", "static");
    store.setToolStatus(tool.id, "ready");
    expect(store.getTool(tool.id)).toMatchObject({ name: "Beach Packing", status: "ready" });

    expect(store.deleteTool(tool.id)?.id).toBe(tool.id);
    expect(store.getTool(tool.id)).toBeUndefined();
    expect(store.listActivity().some((a) => a.action === "tool.deleted")).toBe(true);
  });
});

describe("Store — users, sessions, isolation", () => {
  let raw: Store;

  beforeEach(() => {
    raw = new Store(":memory:");
  });

  it("creates users, looks them up, hashes the password", () => {
    const u = raw.createUser({ username: "Dad", displayName: "Dad", password: "hunter22" });
    expect(u.role).toBe("member");
    expect(raw.getUserByUsername("dad")?.id).toBe(u.id); // case-insensitive
    expect(raw.getPasswordHash(u.id)).toMatch(/^scrypt\$/);
    expect(raw.countUsers()).toBe(1);
  });

  it("resolves a session token and slides its expiry; rejects a bad one", () => {
    const u = raw.createUser({ username: "kid", displayName: "Kid", password: "abcdef" });
    const { token } = raw.createSession(u.id);
    expect(raw.resolveSession(token)?.id).toBe(u.id);
    expect(raw.resolveSession("garbage")).toBeUndefined();
    raw.deleteSession(token);
    expect(raw.resolveSession(token)).toBeUndefined();
  });

  it("keeps each user's tasks/documents/activity separate", () => {
    const a = raw.createUser({ username: "a", displayName: "A", password: "aaaaaa" });
    const b = raw.createUser({ username: "b", displayName: "B", password: "bbbbbb" });
    raw.scoped(a.id).createTask({ title: "A's task" });
    raw.scoped(b.id).createTask({ title: "B's task" });

    expect(raw.scoped(a.id).listTasks().map((t) => t.title)).toEqual(["A's task"]);
    expect(raw.scoped(b.id).listTasks().map((t) => t.title)).toEqual(["B's task"]);
    // A can't see or mutate B's task even with the id.
    const bTaskId = raw.scoped(b.id).listTasks()[0].id;
    expect(raw.scoped(a.id).getTask(bTaskId)).toBeUndefined();
    expect(raw.scoped(a.id).updateTaskStatus(bTaskId, "done")).toBeUndefined();
    expect(raw.scoped(a.id).listActivity().every((e) => !e.detail.includes("B's task"))).toBe(true);
  });

  it("deleting a user removes all of their data", () => {
    const a = raw.createUser({ username: "a", displayName: "A", password: "aaaaaa" });
    raw.scoped(a.id).createTask({ title: "gone soon" });
    raw.scoped(a.id).createDocument({ filename: "x.txt", rawText: "x" });
    raw.deleteUser(a.id);
    expect(raw.getUser(a.id)).toBeUndefined();
    // A fresh scoped view over the same id sees nothing.
    expect(raw.scoped(a.id).listTasks()).toHaveLength(0);
    expect(raw.scoped(a.id).listDocuments()).toHaveLength(0);
  });

  it("guards the last admin count", () => {
    raw.createUser({ username: "admin1", displayName: "A1", password: "aaaaaa", role: "admin" });
    expect(raw.countAdmins()).toBe(1);
    raw.createUser({ username: "admin2", displayName: "A2", password: "bbbbbb", role: "admin" });
    expect(raw.countAdmins()).toBe(2);
  });
});

describe("Store — migration from a single-user database", () => {
  it("adds user_id, backfills to the legacy sentinel, and reassigns on setup", () => {
    const path = `/tmp/family-agent-legacy-${Date.now()}.db`;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, raw_text TEXT NOT NULL,
        extracted TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE activity (
        id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE tools (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL,
        kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'building', error TEXT, created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)").run("OLDTASK1", "legacy task", now, now);
    legacy.prepare("INSERT INTO documents (id, filename, raw_text, extracted, created_at) VALUES (?, ?, ?, ?, ?)").run("OLDDOC01", "old.pdf", "text", null, now);
    legacy.close();

    const store = new Store(path);
    // Before setup, the legacy row is owned by the sentinel.
    expect(store.scoped(LEGACY_USER_ID).listTasks()).toHaveLength(1);

    const admin = store.createUser({ username: "owner", displayName: "Owner", password: "sekret123", role: "admin" });
    const moved = store.reassignLegacyData(admin.id);
    expect(moved).toBeGreaterThanOrEqual(2);
    expect(store.scoped(admin.id).listTasks().map((t) => t.title)).toContain("legacy task");
    expect(store.scoped(admin.id).getDocument("OLDDOC01")?.extractionStatus).toBe("failed");
    expect(store.scoped(LEGACY_USER_ID).listTasks()).toHaveLength(0);

    store.close();
    unlinkSync(path);
  });

  it("fails stale pending extractions on startup (global)", () => {
    const path = `/tmp/family-agent-pending-${Date.now()}.db`;
    const s1 = new Store(path);
    const u = s1.createUser({ username: "u", displayName: "U", password: "aaaaaa" });
    s1.scoped(u.id).createDocument({ filename: "a.txt", rawText: "x" }); // left pending
    s1.close();

    const s2 = new Store(path);
    expect(s2.failStalePendingExtractions()).toBe(1);
    expect(s2.scoped(u.id).listDocuments()[0].extractionStatus).toBe("failed");
    s2.close();
    unlinkSync(path);
  });

  it("fails builds left mid-flight on startup (global)", () => {
    const path = `/tmp/family-agent-tools-${Date.now()}.db`;
    const s1 = new Store(path);
    const u = s1.createUser({ username: "u", displayName: "U", password: "aaaaaa" });
    s1.scoped(u.id).createTool({ name: "x", description: "x", prompt: "x", kind: "static" });
    s1.close();
    const s2 = new Store(path);
    expect(s2.failStaleBuildingTools()).toBe(1);
    expect(s2.scoped(u.id).listTools()[0]).toMatchObject({ status: "failed", error: "interrupted" });
    s2.close();
    unlinkSync(path);
  });

  it("persists to disk and reopens", () => {
    const path = `/tmp/family-agent-test-${Date.now()}.db`;
    const s1 = new Store(path);
    const u = s1.createUser({ username: "u", displayName: "U", password: "aaaaaa" });
    s1.scoped(u.id).createTask({ title: "Persisted task" });
    s1.close();

    const s2 = new Store(path);
    const again = s2.getUserByUsername("u")!;
    expect(s2.scoped(again.id).listTasks().map((t) => t.title)).toContain("Persisted task");
    s2.close();
    unlinkSync(path);
  });

  it("backfills the search index for a legacy single-user database", () => {
    const path = `/tmp/family-agent-legacy-fts-${Date.now()}.db`;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, raw_text TEXT NOT NULL,
        extracted TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE activity (id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE tools (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, prompt TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'building', error TEXT, created_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    legacy
      .prepare("INSERT INTO documents (id, filename, raw_text, extracted, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("OLDDOC01", "water.pdf", "Palo Alto water utility bill for September", null, now);
    legacy.prepare("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'open', ?, ?)").run("OLDTASK1", "call the plumber", now, now);
    legacy.close();

    const store = new Store(path);
    const admin = store.createUser({ username: "owner", displayName: "Owner", password: "sekret123", role: "admin" });
    store.reassignLegacyData(admin.id);
    const scoped = store.scoped(admin.id);

    expect(scoped.searchDocuments("water bill").map((h) => h.id)).toContain("OLDDOC01");
    expect(scoped.searchTasks("plumber").map((h) => h.id)).toContain("OLDTASK1");

    store.close();
    unlinkSync(path);
  });

  it("rebuildSearchIndex() repairs a mirror wiped out of band", () => {
    const raw = new Store(":memory:");
    const u = raw.createUser({ username: "u", displayName: "U", password: "sekret123" });
    const store = raw.scoped(u.id);
    store.createDocument({ filename: "note.txt", rawText: "the quarterly gas bill is overdue" });
    expect(store.searchDocuments("gas bill")).toHaveLength(1);

    raw.handle.exec("DELETE FROM documents_fts");
    expect(store.searchDocuments("gas bill")).toHaveLength(0);

    raw.rebuildSearchIndex();
    expect(store.searchDocuments("gas bill")).toHaveLength(1);
  });
});

describe("toFtsMatchQuery", () => {
  it("reduces free text to quoted prefix tokens ORed together", () => {
    expect(toFtsMatchQuery("car insurance")).toBe('"car"* OR "insurance"*');
  });
  it("strips punctuation and FTS operator words survive only as literals", () => {
    expect(toFtsMatchQuery("what's my water bill?")).toBe('"what"* OR "my"* OR "water"* OR "bill"*');
  });
  it("drops one-character noise and caps very long input", () => {
    expect(toFtsMatchQuery("a I x")).toBe("");
    expect(toFtsMatchQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")).split(" OR ")).toHaveLength(12);
  });
  it("returns empty string for a query with nothing searchable", () => {
    expect(toFtsMatchQuery("   ?!  ")).toBe("");
    expect(toFtsMatchQuery("")).toBe("");
  });
});

describe("ScopedStore — full-text search", () => {
  let raw: Store;
  let store: ScopedStore;

  beforeEach(() => {
    raw = new Store(":memory:");
    store = raw.scoped(raw.createUser({ username: "owner", displayName: "Owner", password: "sekret123" }).id);
  });

  it("matches on filename, body, and extracted summary", () => {
    const byName = store.createDocument({ filename: "car-insurance-2026.pdf", rawText: "policy terms and conditions" });
    const byBody = store.createDocument({ filename: "scan001.pdf", rawText: "State Farm auto insurance renewal notice" });
    const bySummary = store.createDocument({ filename: "scan002.pdf", rawText: "illegible" });
    store.updateDocumentExtraction(bySummary.id, { category: "insurance", summary: "Home insurance declarations page" });

    expect(store.searchDocuments("insurance").map((h) => h.id).sort()).toEqual(
      [byName.id, byBody.id, bySummary.id].sort()
    );
    expect(store.searchDocuments("car insurance")[0].id).toBe(byName.id);
    expect(store.searchDocuments("renewal").map((h) => h.id)).toEqual([byBody.id]);
  });

  it("still matches when only some query words appear in the document", () => {
    // Regression: "what is my insurance number?" must find an insurance
    // document that never contains the literal word "number". Tokens are
    // ORed, not ANDed — see toFtsMatchQuery.
    const doc = store.createDocument({
      filename: "regence.pdf",
      rawText: "Regence BlueShield health insurance. Member ID: 210284396.",
    });
    expect(store.searchDocuments("what is my insurance number").map((h) => h.id)).toEqual([doc.id]);
  });

  it("matches on the extracted category even when the text never says it", () => {
    const doc = store.createDocument({ filename: "scan_0007.jpg", rawText: "Member 4471. Amount 42.10. Due 09/20." });
    store.updateDocumentExtraction(doc.id, { category: "bill", summary: "Water service statement" });
    expect(store.searchDocuments("bill").map((h) => h.id)).toEqual([doc.id]);
  });

  it("returns a snippet around the match", () => {
    store.createDocument({
      filename: "utilities.txt",
      rawText: "Account 4471. Your City of Palo Alto water service payment of $42.10 is due on 2026-09-20.",
    });
    const [hit] = store.searchDocuments("water payment");
    expect(hit.snippet.toLowerCase()).toContain("water");
  });

  it("keeps one family member's search out of another's documents", () => {
    const other = raw.scoped(raw.createUser({ username: "kid", displayName: "Kid", password: "sekret123" }).id);
    store.createDocument({ filename: "mine.txt", rawText: "shared keyword dentist" });
    other.createDocument({ filename: "theirs.txt", rawText: "shared keyword dentist" });

    expect(store.searchDocuments("dentist").map((h) => h.filename)).toEqual(["mine.txt"]);
    expect(other.searchDocuments("dentist").map((h) => h.filename)).toEqual(["theirs.txt"]);
  });

  it("filters by extracted category", () => {
    const bill = store.createDocument({ filename: "a.txt", rawText: "amount due keyword" });
    store.updateDocumentExtraction(bill.id, { category: "bill", summary: "A bill" });
    const school = store.createDocument({ filename: "b.txt", rawText: "amount due keyword" });
    store.updateDocumentExtraction(school.id, { category: "school", summary: "A permission slip" });

    expect(store.searchDocuments("keyword", { category: "bill" }).map((h) => h.id)).toEqual([bill.id]);
  });

  it("filters by an important-date range", () => {
    const soon = store.createDocument({ filename: "soon.txt", rawText: "keyword" });
    store.updateDocumentExtraction(soon.id, { category: "bill", summary: "s", importantDates: ["2026-09-20"] });
    const later = store.createDocument({ filename: "later.txt", rawText: "keyword" });
    store.updateDocumentExtraction(later.id, { category: "bill", summary: "s", importantDates: ["2027-03-01"] });
    const undated = store.createDocument({ filename: "undated.txt", rawText: "keyword" });
    store.updateDocumentExtraction(undated.id, { category: "bill", summary: "s" });

    expect(store.searchDocuments("keyword", { dueBefore: "2026-12-31" }).map((h) => h.id)).toEqual([soon.id]);
    expect(store.searchDocuments("keyword", { dueAfter: "2026-12-31" }).map((h) => h.id)).toEqual([later.id]);
  });

  it("an empty query falls back to a filtered recency listing", () => {
    const bill = store.createDocument({ filename: "bill.txt", rawText: "x" });
    store.updateDocumentExtraction(bill.id, { category: "bill", summary: "Electric bill" });
    store.createDocument({ filename: "misc.txt", rawText: "y" });

    const all = store.searchDocuments("");
    expect(all).toHaveLength(2);
    expect(all[0].filename).toBe("misc.txt"); // newest first

    expect(store.searchDocuments("   ", { category: "bill" }).map((h) => h.id)).toEqual([bill.id]);
  });

  it("stays current as documents are extracted and deleted", () => {
    const doc = store.createDocument({ filename: "scan.pdf", rawText: "unreadable blob" });
    expect(store.searchDocuments("hydro")).toHaveLength(0);

    store.updateDocumentExtraction(doc.id, { category: "bill", summary: "Hydro Quebec electricity bill" });
    expect(store.searchDocuments("hydro").map((h) => h.id)).toEqual([doc.id]);

    store.deleteDocument(doc.id);
    expect(store.searchDocuments("hydro")).toHaveLength(0);
  });

  it("searchTasks matches title and notes, filters by status, and follows completion", () => {
    const a = store.createTask({ title: "Renew car registration", notes: "DMV appointment needed" });
    store.createTask({ title: "Buy milk" });

    expect(store.searchTasks("registration").map((h) => h.id)).toEqual([a.id]);
    expect(store.searchTasks("DMV").map((h) => h.id)).toEqual([a.id]);

    store.updateTaskStatus(a.id, "done");
    expect(store.searchTasks("registration", { status: "open" })).toHaveLength(0);
    expect(store.searchTasks("registration", { status: "done" }).map((h) => h.id)).toEqual([a.id]);
  });

  it("searchTasks with an empty query lists recent tasks, status-filtered", () => {
    const open1 = store.createTask({ title: "one" });
    const done1 = store.createTask({ title: "two" });
    store.updateTaskStatus(done1.id, "done");

    expect(store.searchTasks("", { status: "open" }).map((h) => h.id)).toEqual([open1.id]);
  });
});
