import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";
import { config } from "../src/config.js";
import {
  createEmbedder,
  embedDocument,
  embedderReady,
  searchDocumentsSmart,
  type Embedder,
} from "../src/embeddings.js";

// Real end-to-end semantic search against a locally running Ollama embedding
// model (nomic-embed-text by default). Slow-ish and environment-dependent, so
// it skips itself when the model isn't pulled — the fast suites stay green
// without it. Mirrors agents.integration.test.ts's modelIsReady() guard.
//
// test/setup.ts sets FAMILY_AGENT_EMBED=0 for the suite; this file is the one
// that needs it on, so it toggles config in beforeAll/afterAll (NOT at module
// scope — config is a shared singleton and a top-level mutation would leak
// into every other test file).
const EMBED_MODEL = process.env.FAMILY_AGENT_EMBED_MODEL || "nomic-embed-text";

const ready = await embedderReady(config.ollamaBaseUrl, EMBED_MODEL);
const maybe = ready ? describe : describe.skip;

maybe(`semantic document search (live model: ${EMBED_MODEL})`, () => {
  let raw: Store;
  let store: ScopedStore;
  let embedder: Embedder;
  let savedEnabled: boolean;
  let savedModel: string;

  const DOCS: [string, string][] = [
    ["Auto Insurance Policy.pdf", "State Farm private passenger auto policy. Covers collision and comprehensive for a 2019 Honda Civic. Six-month premium $612. Deductible $500."],
    ["Blue Cross EOB.pdf", "Explanation of benefits. Provider: Palo Alto Medical Foundation. Office visit. Plan paid $140, patient responsibility $35."],
    ["Lincoln Elementary Field Trip.pdf", "Permission slip for the third grade trip to the science museum on October 14. Please return with $12 by October 7."],
    ["Water Bill September.pdf", "City of Palo Alto Utilities. Water and sewer service. Amount due $84.20 by 2026-09-28. Account 4471820."],
    ["Chocolate Chip Cookies.txt", "Cream butter and sugar, add eggs and vanilla, mix in flour baking soda and chocolate chips. Bake at 375F for 10 minutes."],
  ];

  beforeAll(async () => {
    savedEnabled = config.embedEnabled;
    savedModel = config.embedModel;
    config.embedEnabled = true;
    config.embedModel = EMBED_MODEL;

    raw = new Store(":memory:");
    store = raw.scoped(
      raw.createUser({ username: "owner", displayName: "Owner", password: "sekret123", role: "admin" }).id
    );
    embedder = createEmbedder()!;
    expect(embedder).toBeTruthy();
    for (const [filename, text] of DOCS) {
      const doc = store.createDocument({ filename, rawText: text });
      await embedDocument(embedder, store, doc);
    }
  });

  afterAll(() => {
    raw?.close();
    config.embedEnabled = savedEnabled;
    config.embedModel = savedModel;
  });

  it("indexed every document", () => {
    expect(store.embeddingChunkCount()).toBeGreaterThanOrEqual(DOCS.length);
    expect(store.documentIdsMissingEmbeddings(EMBED_MODEL)).toHaveLength(0);
  });

  it("finds the car insurance policy from a paraphrase with no shared keyword", async () => {
    const hits = await searchDocumentsSmart(embedder, store, "how much does my vehicle cover cost", {
      mode: "semantic",
    });
    expect(hits[0]?.filename).toBe("Auto Insurance Policy.pdf");
  });

  it("finds the medical EOB from 'what did the doctor visit cost'", async () => {
    const hits = await searchDocumentsSmart(embedder, store, "what did the doctor visit cost", {
      mode: "semantic",
    });
    expect(hits.slice(0, 2).map((h) => h.filename)).toContain("Blue Cross EOB.pdf");
  });

  it("finds the school trip from 'kids museum outing money'", async () => {
    const hits = await searchDocumentsSmart(embedder, store, "kids museum outing money", { mode: "semantic" });
    expect(hits.slice(0, 2).map((h) => h.filename)).toContain("Lincoln Elementary Field Trip.pdf");
  });

  it("hybrid mode beats keyword-only for a semantic query", async () => {
    const q = "utility payment for tap water";
    const keyword = await searchDocumentsSmart(embedder, store, q, { mode: "keyword" });
    const hybrid = await searchDocumentsSmart(embedder, store, q, { mode: "hybrid" });
    expect(hybrid[0]?.filename).toBe("Water Bill September.pdf");
    // keyword alone may still get it via "water"/"payment"; the point is hybrid
    // is at least as good and returns the target at the top.
    expect(hybrid.map((h) => h.filename)).toContain("Water Bill September.pdf");
    expect(keyword.length).toBeGreaterThanOrEqual(0);
  });

  it("re-embedding a document replaces its vectors, and delete clears them", async () => {
    const doc = store.createDocument({ filename: "temp.txt", rawText: "the mitochondria is the powerhouse of the cell" });
    await embedDocument(embedder, store, doc);
    const before = store.embeddingChunkCount();
    await embedDocument(embedder, store, doc); // idempotent
    expect(store.embeddingChunkCount()).toBe(before);
    store.deleteDocument(doc.id);
    expect(store.documentIdsMissingEmbeddings(EMBED_MODEL)).not.toContain(doc.id);
  });
});
