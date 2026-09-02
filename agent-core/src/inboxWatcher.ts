import chokidar, { type FSWatcher } from "chokidar";
import { readFile, mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ScopedStore } from "./db.js";
import type { ChatOllama } from "@langchain/ollama";
import { extractDocument } from "./agents/extraction.js";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./fileExtract.js";

/**
 * Watches config.inboxDir and ingests any new supported file it finds, the
 * same way §01 of the architecture notes describes: drop a file in, the
 * agent picks it up. Runs alongside the HTTP ingest paths
 * (POST /documents/ingest for pasted text, POST /documents/upload for
 * uploaded files) rather than replacing them.
 */
export async function startInboxWatcher(store: ScopedStore, model: ChatOllama, inboxDir: string): Promise<FSWatcher> {
  await mkdir(inboxDir, { recursive: true });

  const watcher = chokidar.watch(inboxDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    depth: 0,
  });

  watcher.on("add", (path) => {
    void handleNewFile(store, model, path);
  });

  return watcher;
}

async function handleNewFile(store: ScopedStore, model: ChatOllama, path: string): Promise<void> {
  const filename = basename(path);

  if (store.findDocumentBySourcePath(path)) {
    return; // already ingested this exact path — avoids reprocessing on restart
  }

  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) {
    const supported = [...SUPPORTED_EXTENSIONS].join(", ");
    store.logActivity("document-agent", "document.skipped", `Skipped "${filename}" — supported types: ${supported}.`);
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    store.logActivity(
      "document-agent",
      "document.read_error",
      `Could not read "${filename}": ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  let rawText: string;
  try {
    rawText = await extractText(filename, buffer);
  } catch (err) {
    // SUPPORTED_EXTENSIONS was already checked above, so UnsupportedFileTypeError
    // shouldn't happen here — this catch is for real extraction failures
    // (a corrupt PDF, an OCR engine error), not the "wrong type" case.
    const detail = err instanceof UnsupportedFileTypeError ? err.message : `extraction failed: ${err}`;
    store.logActivity("document-agent", "document.read_error", `Could not read "${filename}": ${detail}`);
    return;
  }

  if (!rawText.trim()) return;

  const doc = store.createDocument({ filename, rawText, sourcePath: path });
  await extractDocument(model, store, doc);
}
