import { OllamaEmbeddings } from "@langchain/ollama";
import { config } from "./config.js";
import type { DocumentSearchHit, ScopedStore, Store } from "./db.js";

// Semantic document search. A local Ollama embedding model turns each
// document's text into vectors (stored by db.ts's ScopedStore); a query is
// embedded the same way and matched by cosine similarity, so "car cover
// renewal" finds a file titled "Auto Insurance Policy" even with no shared
// words. This is layered ON TOP OF the keyword + trigram-fuzzy index, merged
// with reciprocal-rank fusion — never a replacement. Everything here degrades
// to lexical-only if the model is unreachable or disabled
// (config.embedEnabled / FAMILY_AGENT_EMBED=0).
//
// Same shape as agents/extraction.ts and transcribe.ts: a heavy inference
// path that is NOT the deepagents planner, kicked off the ingest path with no
// user in the loop. It never delegates to a subagent.

export interface Embedder {
  /** The Ollama model name, recorded alongside each stored vector. */
  readonly model: string;
  /** Embed a batch of texts. Returns one unit-agnostic Float32 vector each. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Semantic search is wired up (a model is configured and the feature is on).
 *  Says nothing about whether that model is actually pulled/reachable. */
export function embeddingsEnabled(): boolean {
  return config.embedEnabled && !!config.embedModel.trim();
}

/** Build an embedder from current config, or null when the feature is off. */
export function createEmbedder(): Embedder | null {
  if (!embeddingsEnabled()) return null;
  const model = config.embedModel.trim();
  const client = new OllamaEmbeddings({
    model,
    baseUrl: config.ollamaBaseUrl,
    // Let Ollama clip an over-long chunk to the model's context rather than
    // erroring the whole request — chunkDocumentText already keeps them small.
    truncate: true,
    keepAlive: config.ollamaKeepAlive,
  });
  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const vecs = await client.embedDocuments(texts);
      return vecs.map((v) => Float32Array.from(v));
    },
  };
}

/**
 * Is `model` actually pulled into the Ollama at `baseUrl`? A cheap `/api/tags`
 * probe with a short timeout — gates the startup backfill, and mirrors the
 * guard the live-model integration tests use, so a box without the model set
 * up just runs keyword + fuzzy search with no errors. A pure reachability
 * check: it does NOT consult `config.embedEnabled` (callers that care check
 * `embeddingsEnabled()` themselves).
 */
export async function embedderReady(
  baseUrl: string = config.ollamaBaseUrl,
  model: string = config.embedModel
): Promise<boolean> {
  if (!model.trim()) return false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const strip = (s: string) => s.replace(/:latest$/, "");
    const want = strip(model.trim());
    return (body.models ?? []).some((m) =>
      [m.name, m.model].some((n) => typeof n === "string" && strip(n) === want)
    );
  } catch {
    return false;
  }
}

// ---- chunking ----

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;
const MAX_CHUNKS = 64; // a runaway OCR dump must not fan out without bound

/**
 * Split a document into embedding-sized pieces. Prefers paragraph boundaries;
 * hard-slices a single paragraph longer than a chunk (with overlap so a
 * sentence spanning the cut still matches). The extracted one-line summary, if
 * present, is prepended as its own chunk — it is often the cleanest statement
 * of what the document is.
 */
export function chunkDocumentText(raw: string, summary?: string | null): string[] {
  const chunks: string[] = [];
  const sum = (summary ?? "").replace(/\s+/g, " ").trim();
  if (sum) chunks.push(sum);

  const text = (raw ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) return chunks;

  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        chunks.push(p.slice(i, i + CHUNK_CHARS));
        if (chunks.length >= MAX_CHUNKS) return chunks.slice(0, MAX_CHUNKS);
      }
      continue;
    }
    if (buf.length + p.length + 2 > CHUNK_CHARS) flush();
    buf += (buf ? "\n\n" : "") + p;
  }
  flush();
  return chunks.slice(0, MAX_CHUNKS);
}

// ---- ingest-path indexing ----

interface EmbeddableDoc {
  id: string;
  filename: string;
  rawText: string;
  extracted?: Record<string, unknown> | null;
}

/** Build (or rebuild) the vector index for one document. Throws on failure. */
export async function embedDocument(
  embedder: Embedder,
  store: ScopedStore,
  doc: EmbeddableDoc
): Promise<void> {
  const summary = typeof doc.extracted?.summary === "string" ? (doc.extracted.summary as string) : null;
  const chunks = chunkDocumentText(doc.rawText, summary);
  if (chunks.length === 0) return;
  const vectors = await embedder.embed(chunks);
  if (vectors.length !== chunks.length) {
    throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
  }
  store.upsertDocumentEmbeddings(
    doc.id,
    embedder.model,
    chunks.map((text, i) => ({ text, vector: vectors[i] }))
  );
}

/**
 * Fire-and-forget wrapper for the ingest routes / inbox watcher: never throws,
 * logs a failure to the console rather than the activity feed (a model that
 * isn't pulled would otherwise spam it on every upload). A no-op when
 * `embedder` is null (feature off).
 */
export async function embedDocumentSafely(
  embedder: Embedder | null,
  store: ScopedStore,
  doc: EmbeddableDoc
): Promise<void> {
  if (!embedder) return;
  try {
    await embedDocument(embedder, store, doc);
  } catch (err) {
    console.warn(
      `semantic index: could not embed "${doc.filename}" — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Index every document that is missing vectors for the current model, across
 * all accounts. Runs once at startup (from server.ts's main()). Skips itself
 * cleanly when the model isn't reachable. Also prunes vectors left behind by a
 * previous embedding model.
 */
export async function backfillEmbeddings(
  store: Store,
  getEmbedder: () => Embedder | null
): Promise<void> {
  const embedder = getEmbedder();
  if (!embedder) return;
  if (!(await embedderReady())) {
    console.log(
      `semantic search: embedding model "${config.embedModel}" not reachable — ` +
        `skipping index backfill (keyword + fuzzy search still work)`
    );
    return;
  }

  let indexed = 0;
  let pruned = 0;
  for (const user of store.listUsers()) {
    const scoped = store.scoped(user.id);
    pruned += scoped.pruneEmbeddingsNotMatching(embedder.model);
    for (const id of scoped.documentIdsMissingEmbeddings(embedder.model)) {
      const doc = scoped.getDocument(id);
      if (!doc) continue;
      try {
        await embedDocument(embedder, scoped, doc);
        indexed++;
      } catch (err) {
        console.warn(
          `semantic index backfill: "${doc.filename}" failed — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  if (indexed || pruned) {
    console.log(
      `semantic search: indexed ${indexed} document(s)` + (pruned ? `, pruned ${pruned} stale chunk(s)` : "")
    );
  }
}

// ---- query time ----

export type SearchMode = "keyword" | "fuzzy" | "semantic" | "hybrid";

export interface SmartSearchOpts {
  category?: string;
  dueAfter?: string;
  dueBefore?: string;
  limit?: number;
  /** Default "hybrid" — keyword + fuzzy + semantic, merged by rank fusion. */
  mode?: SearchMode;
}

/**
 * The one entry point the HTTP route and the document-agent tool call.
 * Dispatches by `mode`, transparently falling back to lexical search whenever
 * semantic search is unavailable (feature off, no query, model unreachable).
 */
export async function searchDocumentsSmart(
  embedder: Embedder | null,
  store: ScopedStore,
  query: string,
  opts: SmartSearchOpts = {}
): Promise<DocumentSearchHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
  const mode: SearchMode = opts.mode ?? "hybrid";
  const filters = { category: opts.category, dueAfter: opts.dueAfter, dueBefore: opts.dueBefore };
  const q = (query ?? "").trim();
  const canSemantic = !!embedder && embeddingsEnabled() && q.length >= 2;

  if (mode === "keyword" || mode === "fuzzy") {
    return store.searchDocuments(q, { ...filters, limit, mode });
  }

  if (mode === "semantic") {
    if (!canSemantic) return store.searchDocuments(q, { ...filters, limit, mode: "keyword" });
    try {
      return await semanticHits(embedder!, store, q, filters, limit);
    } catch (err) {
      console.warn(`semantic search failed, using keyword: ${err instanceof Error ? err.message : String(err)}`);
      return store.searchDocuments(q, { ...filters, limit, mode: "keyword" });
    }
  }

  // hybrid
  const keyword = store.searchDocuments(q, { ...filters, limit: limit * 3, mode: "keyword" });
  const fuzzy = q ? store.searchDocuments(q, { ...filters, limit: limit * 3, mode: "fuzzy" }) : [];
  const lists: DocumentSearchHit[][] = [keyword, fuzzy];
  if (canSemantic) {
    try {
      lists.push(await semanticHits(embedder!, store, q, filters, limit * 3));
    } catch (err) {
      console.warn(
        `semantic search unavailable, using keyword + fuzzy only: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const merged = rrfMerge(lists, (h) => h.id, limit);
  // Nothing matched anything (short/odd query, empty corpus) — fall back to the
  // recency+filter listing the keyword path returns for an empty query, so a
  // filter-only request (?category=bill) still works in hybrid mode.
  if (merged.length === 0 && (filters.category || filters.dueAfter || filters.dueBefore || !q)) {
    return store.searchDocuments(q, { ...filters, limit, mode: "keyword" });
  }
  return merged;
}

async function semanticHits(
  embedder: Embedder,
  store: ScopedStore,
  query: string,
  filters: { category?: string; dueAfter?: string; dueBefore?: string },
  limit: number
): Promise<DocumentSearchHit[]> {
  const [vec] = await embedder.embed([query]);
  if (!vec) return [];
  const raw = store.searchDocumentChunksByVector(vec, { ...filters, limit, model: embedder.model });
  const hits: DocumentSearchHit[] = [];
  for (const r of raw) {
    const doc = store.getDocument(r.id);
    if (!doc) continue;
    hits.push({
      id: doc.id,
      filename: doc.filename,
      category: (doc.extracted?.category as string) ?? null,
      summary: (doc.extracted?.summary as string) ?? null,
      snippet: r.snippet,
      createdAt: doc.createdAt,
      extractionStatus: doc.extractionStatus,
    });
  }
  return hits;
}

/**
 * Reciprocal-rank fusion: merge several ranked lists into one, scoring each
 * item by the sum of 1/(k + rank) across the lists it appears in. Parameter-
 * free and scale-free — no need to normalise bm25 against cosine. The first
 * list an item appears in supplies the returned object (lists are passed
 * lexical-first, so FTS snippets win over semantic ones).
 */
export function rrfMerge<T>(lists: T[][], keyOf: (t: T) => string, limit: number, k = 60): T[] {
  const score = new Map<string, number>();
  const first = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1));
      if (!first.has(key)) first.set(key, item);
    });
  }
  return [...first.values()]
    .sort((a, b) => score.get(keyOf(b))! - score.get(keyOf(a))!)
    .slice(0, limit);
}
