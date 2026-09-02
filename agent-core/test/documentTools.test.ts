import { describe, it, expect, beforeEach } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";
import { makeDocumentTools } from "../src/agents/documentTools.js";

// Direct unit coverage of the tools bound to the document-agent subagent —
// added after a live-model run asked "what documents do I have?" and got
// "I found no documents" despite one existing: the subagent had no way to
// enumerate documents, only look one up by id it would have had to guess.
describe("document tools", () => {
  let store: ScopedStore;
  let tools: ReturnType<typeof makeDocumentTools>;

  beforeEach(() => {
    const raw = new Store(":memory:");
    store = raw.scoped(raw.createUser({ username: "u", displayName: "U", password: "sekret123" }).id);
    tools = makeDocumentTools(store);
  });

  function find(name: string) {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it("list_documents reports none when the store is empty", async () => {
    const result = await find("list_documents").invoke({});
    expect(result).toContain("No documents");
  });

  it("list_documents surfaces id, category, and summary once extracted", async () => {
    const doc = store.createDocument({ filename: "bill.txt", rawText: "..." });
    store.updateDocumentExtraction(doc.id, { category: "bill", summary: "A utility bill" });

    const result = await find("list_documents").invoke({});
    expect(result).toContain("bill.txt");
    expect(result).toContain(doc.id);
    expect(result).toContain("bill");
    expect(result).toContain("A utility bill");
  });

  it("list_documents notes documents still awaiting extraction", async () => {
    store.createDocument({ filename: "pending.txt", rawText: "..." });
    const result = await find("list_documents").invoke({});
    expect(result).toContain("still being processed");
  });

  it("get_document returns the raw text for a known id, an error message otherwise", async () => {
    const doc = store.createDocument({ filename: "note.txt", rawText: "hello world" });
    const found = await find("get_document").invoke({ documentId: doc.id });
    expect(found).toContain("hello world");

    const missing = await find("get_document").invoke({ documentId: "NOPE0000" });
    expect(missing).toContain("No document found");
  });

  it("save_extraction persists fields onto the right document", async () => {
    const doc = store.createDocument({ filename: "note.txt", rawText: "hello" });
    await find("save_extraction").invoke({
      documentId: doc.id,
      summary: "A short note",
      category: "other",
      importantDates: ["2026-12-01"],
    });
    const updated = store.getDocument(doc.id);
    expect(updated?.extracted).toMatchObject({ category: "other", summary: "A short note" });
  });
});
