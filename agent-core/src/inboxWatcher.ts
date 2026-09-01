import chokidar, { type FSWatcher } from "chokidar";
import { readFile, mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Store } from "./db.js";
import type { ChatOllama } from "@langchain/ollama";
import { extractDocument } from "./agents/extraction.js";

// Text-only for now — real document capture (photos, scanned PDFs) needs an
// OCR step this build doesn't have. Anything else dropped in the folder is
// logged and skipped rather than silently ignored, so it's visible in
// Activity that the app saw the file and chose not to touch it.
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md"]);

/**
 * Watches config.inboxDir and ingests any new text file it finds, the same
 * way §01 of the architecture notes describes: drop a file in, the agent
 * picks it up. Runs alongside the HTTP ingest path (POST /documents/ingest)
 * rather than replacing it — the API path is still how the desktop/Android
 * "paste text" flow and any future direct-upload UI feed the pipeline.
 */
export async function startInboxWatcher(store: Store, model: ChatOllama, inboxDir: string): Promise<FSWatcher> {
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

async function handleNewFile(store: Store, model: ChatOllama, path: string): Promise<void> {
  const filename = basename(path);

  if (store.findDocumentBySourcePath(path)) {
    return; // already ingested this exact path — avoids reprocessing on restart
  }

  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) {
    store.logActivity(
      "document-agent",
      "document.skipped",
      `Skipped "${filename}" — only .txt/.md are supported right now (no OCR pipeline yet).`
    );
    return;
  }

  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (err) {
    store.logActivity(
      "document-agent",
      "document.read_error",
      `Could not read "${filename}": ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!rawText.trim()) return;

  const doc = store.createDocument({ filename, rawText, sourcePath: path });
  await extractDocument(model, store, doc);
}
