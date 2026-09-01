import { describe, it, expect, beforeEach } from "vitest";
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

    const updated = store.updateDocumentExtraction(doc.id, {
      category: "bill",
      summary: "Utility bill for $120",
      importantDates: ["2026-09-15"],
    });

    expect(updated?.extracted).toMatchObject({ category: "bill" });
    expect(store.getDocument(doc.id)?.extracted).toMatchObject({ category: "bill" });
  });

  it("logs activity for every mutating call", () => {
    store.createTask({ title: "A" });
    const activity = store.listActivity();
    expect(activity.length).toBeGreaterThanOrEqual(1);
    expect(activity[0].action).toBe("task.created");
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
