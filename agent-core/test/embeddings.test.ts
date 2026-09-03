import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store, type ScopedStore, trigramSimilarity, toTrigramMatchQuery } from "../src/db.js";
import { config } from "../src/config.js";
import {
  chunkDocumentText,
  rrfMerge,
  searchDocumentsSmart,
  type Embedder,
} from "../src/embeddings.js";

// A deterministic, offline stand-in for an Ollama embedding model: each word
// maps to a fixed random-ish basis vector, a text is the (normalised) sum of
// its words' vectors. Shared vocabulary ⇒ high cosine similarity, so the whole
// semantic + hybrid + rank-fusion path can be tested with no model running.
function fakeEmbedder(dim = 32): Embedder {
  const basis = new Map<string, Float32Array>();
  const vecFor = (word: string) => {
    let v = basis.get(word);
    if (!v) {
      v = new Float32Array(dim);
      let h = 0;
      for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
      for (let i = 0; i < dim; i++) {
        h = (h * 1664525 + 1013904223) >>> 0;
        v[i] = (h / 0xffffffff) * 2 - 1;
      }
      basis.set(word, v);
    }
    return v;
  };
  return {
    model: "fake-embed",
    async embed(texts) {
      return texts.map((t) => {
        const out = new Float32Array(dim);
        const words = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
        for (const w of words) {
          const bv = vecFor(w);
          for (let i = 0; i < dim; i++) out[i] += bv[i];
        }
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += out[i] * out[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < dim; i++) out[i] /= norm;
        return out;
      });
    },
  };
}

describe("trigramSimilarity", () => {
  it("is 1 for identical strings and 0 for disjoint ones", () => {
    expect(trigramSimilarity("insurance", "insurance")).toBe(1);
    expect(trigramSimilarity("insurance", "xyzzy")).toBeLessThan(0.1);
  });

  it("stays usably high across a typo or a transposition", () => {
    expect(trigramSimilarity("insurnce", "insurance")).toBeGreaterThan(0.45);
    expect(trigramSimilarity("teh cat", "the cat")).toBeGreaterThan(0.35);
    // and clearly above an unrelated pairing
    expect(trigramSimilarity("insurnce", "insurance")).toBeGreaterThan(
      trigramSimilarity("insurnce", "groceries")
    );
  });

  it("is order-independent for word swaps", () => {
    expect(trigramSimilarity("auto policy", "policy auto")).toBeGreaterThan(0.6);
  });

  it("handles empty input without throwing", () => {
    expect(trigramSimilarity("", "anything")).toBe(0);
    expect(trigramSimilarity("anything", "")).toBe(0);
  });
});

describe("toTrigramMatchQuery", () => {
  it("breaks each word into quoted 3-grams joined by OR", () => {
    expect(toTrigramMatchQuery("cat")).toBe('"cat"');
    expect(toTrigramMatchQuery("cats")).toBe('"cat" OR "ats"');
  });

  it("returns empty when no word is long enough for the trigram tokenizer", () => {
    expect(toTrigramMatchQuery("a to be")).toBe("");
    expect(toTrigramMatchQuery("")).toBe("");
  });

  it("caps the number of grams for a pasted paragraph", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    expect(toTrigramMatchQuery(huge).split(" OR ").length).toBeLessThanOrEqual(60);
  });
});

describe("chunkDocumentText", () => {
  it("prepends the summary as its own chunk", () => {
    const chunks = chunkDocumentText("Some body text.", "A one-line summary");
    expect(chunks[0]).toBe("A one-line summary");
    expect(chunks[1]).toContain("body text");
  });

  it("returns just the summary when there is no body", () => {
    expect(chunkDocumentText("", "only a summary")).toEqual(["only a summary"]);
    expect(chunkDocumentText("   ")).toEqual([]);
  });

  it("splits a long document and caps the chunk count", () => {
    const para = "sentence ".repeat(400); // ~3600 chars, one paragraph
    const doc = Array.from({ length: 300 }, () => para).join("\n\n");
    const chunks = chunkDocumentText(doc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(64);
  });

  it("keeps a short multi-paragraph document as a small number of chunks", () => {
    const chunks = chunkDocumentText("Para one.\n\nPara two.\n\nPara three.");
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("Para three");
  });
});

describe("rrfMerge", () => {
  it("ranks items that appear in multiple lists above single-list items", () => {
    const a = [{ id: "x" }, { id: "y" }, { id: "z" }];
    const b = [{ id: "y" }, { id: "q" }, { id: "x" }];
    const merged = rrfMerge([a, b], (o) => o.id, 4);
    // x and y each appear in both lists → both rank ahead of z and q.
    expect(merged.slice(0, 2).map((o) => o.id).sort()).toEqual(["x", "y"]);
    expect(merged[3].id).toBe("z"); // z is last: only list a, rank 2
  });

  it("returns the first-seen object for a duplicated key", () => {
    const a = [{ id: "x", from: "a" }];
    const b = [{ id: "x", from: "b" }];
    expect(rrfMerge([a, b], (o) => o.id, 1)[0].from).toBe("a");
  });

  it("respects the limit", () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
    expect(rrfMerge([list], (o) => o.id, 5)).toHaveLength(5);
  });
});

describe("ScopedStore — embedding storage & vector search", () => {
  let raw: Store;
  let store: ScopedStore;

  beforeEach(() => {
    raw = new Store(":memory:");
    const u = raw.createUser({ username: "o", displayName: "O", password: "sekret123", role: "admin" });
    store = raw.scoped(u.id);
  });

  const vec = (...xs: number[]) => Float32Array.from(xs);

  it("stores chunks and finds the nearest document by cosine", () => {
    const a = store.createDocument({ filename: "a.txt", rawText: "alpha" });
    const b = store.createDocument({ filename: "b.txt", rawText: "beta" });
    store.upsertDocumentEmbeddings(a.id, "m", [{ text: "alpha", vector: vec(1, 0, 0) }]);
    store.upsertDocumentEmbeddings(b.id, "m", [{ text: "beta", vector: vec(0, 1, 0) }]);

    const hits = store.searchDocumentChunksByVector(vec(0.9, 0.1, 0), { minScore: 0 });
    expect(hits[0].id).toBe(a.id);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].snippet).toBe("alpha");
  });

  it("keeps the best-scoring chunk per document", () => {
    const d = store.createDocument({ filename: "d.txt", rawText: "x" });
    store.upsertDocumentEmbeddings(d.id, "m", [
      { text: "far", vector: vec(0, 1, 0) },
      { text: "near", vector: vec(1, 0, 0) },
    ]);
    const [hit] = store.searchDocumentChunksByVector(vec(1, 0, 0), { minScore: 0 });
    expect(hit.snippet).toBe("near");
    expect(hit.score).toBeCloseTo(1, 5);
  });

  it("applies minScore and limit", () => {
    const a = store.createDocument({ filename: "a.txt", rawText: "x" });
    const b = store.createDocument({ filename: "b.txt", rawText: "y" });
    store.upsertDocumentEmbeddings(a.id, "m", [{ text: "a", vector: vec(1, 0) }]);
    store.upsertDocumentEmbeddings(b.id, "m", [{ text: "b", vector: vec(-1, 0) }]);
    expect(store.searchDocumentChunksByVector(vec(1, 0), { minScore: 0.5 }).map((h) => h.id)).toEqual([a.id]);
    expect(store.searchDocumentChunksByVector(vec(1, 0), { minScore: 0, limit: 1 })).toHaveLength(1);
  });

  it("ignores rows whose dimensionality differs from the query", () => {
    const d = store.createDocument({ filename: "d.txt", rawText: "x" });
    store.upsertDocumentEmbeddings(d.id, "m", [{ text: "d", vector: vec(1, 0, 0, 0) }]);
    expect(store.searchDocumentChunksByVector(vec(1, 0, 0), { minScore: 0 })).toHaveLength(0);
  });

  it("re-upsert replaces a document's chunks", () => {
    const d = store.createDocument({ filename: "d.txt", rawText: "x" });
    store.upsertDocumentEmbeddings(d.id, "m", [
      { text: "one", vector: vec(1, 0) },
      { text: "two", vector: vec(0, 1) },
    ]);
    expect(store.embeddingChunkCount()).toBe(2);
    store.upsertDocumentEmbeddings(d.id, "m", [{ text: "only", vector: vec(1, 1) }]);
    expect(store.embeddingChunkCount()).toBe(1);
  });

  it("deleting a document removes its embedding rows (trigger)", () => {
    const d = store.createDocument({ filename: "d.txt", rawText: "x" });
    store.upsertDocumentEmbeddings(d.id, "m", [{ text: "d", vector: vec(1, 0) }]);
    store.deleteDocument(d.id);
    expect(store.embeddingChunkCount()).toBe(0);
  });

  it("scopes vector search and storage to one user", () => {
    const other = raw.scoped(
      raw.createUser({ username: "p", displayName: "P", password: "sekret123", role: "member" }).id
    );
    const mine = store.createDocument({ filename: "mine.txt", rawText: "x" });
    store.upsertDocumentEmbeddings(mine.id, "m", [{ text: "mine", vector: vec(1, 0) }]);
    // other user can't write to my doc, and can't see my chunks
    other.upsertDocumentEmbeddings(mine.id, "m", [{ text: "hax", vector: vec(1, 0) }]);
    expect(store.embeddingChunkCount()).toBe(1);
    expect(other.searchDocumentChunksByVector(vec(1, 0), { minScore: 0 })).toHaveLength(0);
  });

  it("documentIdsMissingEmbeddings / pruneEmbeddingsNotMatching track the model", () => {
    const a = store.createDocument({ filename: "a.txt", rawText: "alpha" });
    const b = store.createDocument({ filename: "b.txt", rawText: "beta" });
    store.createDocument({ filename: "empty.txt", rawText: "   " });
    expect(store.documentIdsMissingEmbeddings("m1").sort()).toEqual([a.id, b.id].sort());

    store.upsertDocumentEmbeddings(a.id, "m1", [{ text: "alpha", vector: vec(1, 0) }]);
    expect(store.documentIdsMissingEmbeddings("m1")).toEqual([b.id]);
    // a different model ⇒ a is "missing" again
    expect(store.documentIdsMissingEmbeddings("m2").sort()).toEqual([a.id, b.id].sort());

    store.upsertDocumentEmbeddings(b.id, "m2", [{ text: "beta", vector: vec(0, 1) }]);
    expect(store.pruneEmbeddingsNotMatching("m2")).toBe(1); // drops a's m1 row
    expect(store.documentIdsMissingEmbeddings("m2")).toEqual([a.id]);
  });
});

describe("searchDocumentsSmart", () => {
  let raw: Store;
  let store: ScopedStore;
  let embedEnabled: boolean;
  let embedModel: string;

  beforeEach(() => {
    raw = new Store(":memory:");
    const u = raw.createUser({ username: "o", displayName: "O", password: "sekret123", role: "admin" });
    store = raw.scoped(u.id);
    embedEnabled = config.embedEnabled;
    embedModel = config.embedModel;
    config.embedEnabled = true;
    config.embedModel = "fake-embed";
  });
  afterEach(() => {
    config.embedEnabled = embedEnabled;
    config.embedModel = embedModel;
  });

  async function seedIndexed(embedder: Embedder, filename: string, text: string, summary?: string) {
    const doc = store.createDocument({
      filename,
      rawText: text,
      extracted: summary ? { summary, category: "insurance", importantDates: [] } : null,
    });
    const chunks = summary ? [summary, text] : [text];
    const vecs = await embedder.embed(chunks);
    store.upsertDocumentEmbeddings(doc.id, embedder.model, chunks.map((t, i) => ({ text: t, vector: vecs[i] })));
    return doc;
  }

  it("with no embedder, hybrid falls back to keyword + fuzzy", async () => {
    store.createDocument({ filename: "car-insurance.pdf", rawText: "auto policy renewal" });
    store.createDocument({ filename: "grocery.txt", rawText: "milk eggs bread" });
    const hits = await searchDocumentsSmart(null, store, "insurance renewal", {});
    expect(hits.map((h) => h.filename)).toEqual(["car-insurance.pdf"]);
  });

  it("fuzzy mode tolerates a typo the keyword index would miss", async () => {
    store.createDocument({ filename: "Auto Insurance Policy.pdf", rawText: "coverage and premium details" });
    store.createDocument({ filename: "grocery.txt", rawText: "milk eggs bread" });
    const kw = await searchDocumentsSmart(null, store, "insurnce", { mode: "keyword" });
    expect(kw).toHaveLength(0);
    const fz = await searchDocumentsSmart(null, store, "insurnce", { mode: "fuzzy" });
    expect(fz.map((h) => h.filename)).toContain("Auto Insurance Policy.pdf");
  });

  it("semantic mode matches on meaning with no shared keyword", async () => {
    const embedder = fakeEmbedder();
    await seedIndexed(embedder, "Auto Insurance Policy.pdf", "vehicle coverage premium deductible", "car insurance");
    await seedIndexed(embedder, "Recipe.txt", "flour sugar butter eggs oven", "a cake recipe");

    const hits = await searchDocumentsSmart(embedder, store, "car insurance", { mode: "semantic" });
    expect(hits[0].filename).toBe("Auto Insurance Policy.pdf");
  });

  it("hybrid merges lexical and semantic and still honours filters", async () => {
    const embedder = fakeEmbedder();
    await seedIndexed(embedder, "Auto Insurance Policy.pdf", "vehicle coverage premium", "car insurance");
    const other = store.createDocument({
      filename: "School Newsletter.pdf",
      rawText: "car insurance was mentioned once",
      extracted: { summary: "school news", category: "school", importantDates: [] },
    });
    const ov = await embedder.embed(["school news", other.rawText]);
    store.upsertDocumentEmbeddings(other.id, embedder.model, [
      { text: "school news", vector: ov[0] },
      { text: other.rawText, vector: ov[1] },
    ]);

    const all = await searchDocumentsSmart(embedder, store, "car insurance", { mode: "hybrid" });
    expect(all.map((h) => h.filename)).toContain("Auto Insurance Policy.pdf");

    const filtered = await searchDocumentsSmart(embedder, store, "car insurance", {
      mode: "hybrid",
      category: "insurance",
    });
    expect(filtered.map((h) => h.filename)).toEqual(["Auto Insurance Policy.pdf"]);
  });

  it("falls back to lexical when the embedder throws", async () => {
    const broken: Embedder = {
      model: "fake-embed",
      async embed() {
        throw new Error("ollama down");
      },
    };
    store.createDocument({ filename: "car-insurance.pdf", rawText: "auto policy renewal" });
    const hits = await searchDocumentsSmart(broken, store, "insurance", { mode: "hybrid" });
    expect(hits.map((h) => h.filename)).toEqual(["car-insurance.pdf"]);
  });

  it("empty query with a category filter still lists that category in hybrid mode", async () => {
    store.createDocument({
      filename: "bill.pdf",
      rawText: "amount due",
      extracted: { summary: "a bill", category: "bill", importantDates: [] },
    });
    store.createDocument({ filename: "note.txt", rawText: "hello" });
    const hits = await searchDocumentsSmart(fakeEmbedder(), store, "", { mode: "hybrid", category: "bill" });
    expect(hits.map((h) => h.filename)).toEqual(["bill.pdf"]);
  });
});
