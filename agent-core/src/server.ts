import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { Store } from "./db.js";
import { config, dbPath } from "./config.js";
import { buildFamilyAgent, askFamilyAgent } from "./agents/index.js";
import { extractDocument } from "./agents/extraction.js";
import { createLocalModel } from "./model.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { persistInboxDir } from "./settingsFile.js";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./fileExtract.js";

export function buildServer(
  store: Store = new Store(dbPath()),
  onInboxDirChange?: (newDir: string) => Promise<void>
) {
  const app = Fastify({ logger: false });
  // Local-only server (see docs/DECISIONS.md) — the Tauri webview and any
  // future tailnet-connected companion app are different origins from this
  // server's perspective, so CORS is opened rather than restricted; there is
  // no cross-origin data to protect since nothing here is reachable off-box.
  //
  // methods must be listed explicitly: @fastify/cors defaults to
  // "GET,HEAD,POST" only. Found by actually clicking things in a browser,
  // not by the test suite — `app.inject()` and curl both bypass real CORS
  // preflight, so PATCH /tasks/:id and PUT /settings silently "worked" in
  // every test and every curl check while being completely broken from the
  // desktop webview the whole time. See the CORS preflight tests below for
  // the regression coverage this bug should have had from the start.
  void app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });
  void app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  const agent = buildFamilyAgent(store);
  const extractionModel = createLocalModel();

  // Documents left mid-extraction by a previous run will never finish on
  // their own — mark them failed so the UI offers a retry instead of a
  // spinner that never resolves.
  store.failStalePendingExtractions();

  app.get("/health", async () => ({
    ok: true,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    inboxDir: config.inboxDir,
  }));

  const ChatBody = z.object({ message: z.string().min(1) });
  app.post("/chat", async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    store.logActivity("user", "chat.message", parsed.data.message);
    try {
      const responseText = await askFamilyAgent(agent, parsed.data.message);
      store.logActivity("family-planner", "chat.reply", responseText);
      return { reply: responseText };
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(502).send({
        error: "The local model could not be reached. Is Ollama running with the configured model pulled?",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/tasks", async (req) => {
    const status = (req.query as any)?.status;
    return { tasks: store.listTasks(status === "open" || status === "done" ? status : undefined) };
  });

  const CreateTaskBody = z.object({
    title: z.string().min(1),
    notes: z.string().optional(),
    dueDate: z.string().optional(),
  });
  app.post("/tasks", async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return { task: store.createTask(parsed.data) };
  });

  const UpdateTaskBody = z.object({ status: z.enum(["open", "done"]) });
  app.patch("/tasks/:id", async (req, reply) => {
    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { id } = req.params as { id: string };
    const updated = store.updateTaskStatus(id, parsed.data.status);
    if (!updated) return reply.code(404).send({ error: "task not found" });
    return { task: updated };
  });

  app.get("/documents", async () => ({ documents: store.listDocuments() }));

  const IngestBody = z.object({ filename: z.string().min(1), text: z.string().min(1) });
  app.post("/documents/ingest", async (req, reply) => {
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const doc = store.createDocument({ filename: parsed.data.filename, rawText: parsed.data.text });
    // Fire-and-forget: ingest responds immediately, extraction lands a few
    // seconds later. Client polls GET /documents for the `extracted` field.
    // Deliberately does not go through the planner — see agents/extraction.ts.
    void extractDocument(extractionModel, store, doc);
    return { document: doc };
  });

  // File upload: PDFs (text-layer only — see fileExtract.ts), photos/scans
  // (OCR via tesseract.js), or plain text/markdown. This is the actual
  // "upload a PDF, a photo, or a camera scan" path; /documents/ingest above
  // stays as the paste-text path both UIs also offer.
  app.post("/documents/upload", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No file uploaded." });

    const filename = data.filename || "upload";
    const buffer = await data.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "Uploaded file is empty." });

    let rawText: string;
    try {
      rawText = await extractText(filename, buffer);
    } catch (err) {
      if (err instanceof UnsupportedFileTypeError) {
        return reply.code(400).send({
          error: `${err.message}. Supported types: ${[...SUPPORTED_EXTENSIONS].join(", ")}.`,
        });
      }
      req.log?.error?.(err);
      return reply.code(422).send({
        error: "Could not extract text from this file.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (!rawText.trim()) {
      return reply
        .code(422)
        .send({ error: "No readable text found in this file (a blank page, or an image OCR couldn't read)." });
    }

    const doc = store.createDocument({ filename, rawText });
    void extractDocument(extractionModel, store, doc);
    return { document: doc };
  });

  app.delete("/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = store.deleteDocument(id);
    if (!deleted) return reply.code(404).send({ error: "document not found" });
    return { document: deleted };
  });

  // Re-run field extraction for a document whose first attempt failed (a
  // transient model outage, say). Resets it to "pending" and fires the same
  // fire-and-forget path as ingest.
  app.post("/documents/:id/retry-extraction", async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = store.getDocument(id);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    store.setDocumentExtractionStatus(id, "pending");
    void extractDocument(extractionModel, store, { id: doc.id, filename: doc.filename, rawText: doc.rawText });
    return { document: store.getDocument(id) };
  });

  app.get("/activity", async () => ({ activity: store.listActivity() }));

  app.get("/settings", async () => ({
    inboxDir: config.inboxDir,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
  }));

  // Model and Ollama URL are env-var-only (a running model client can't be
  // safely hot-swapped mid-request) — inboxDir is the one setting this app
  // lets you change live, since restarting a filesystem watcher is cheap
  // and safe. Persisted to disk so it survives the next restart too.
  const UpdateSettingsBody = z.object({ inboxDir: z.string().min(1) });
  app.put("/settings", async (req, reply) => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const newDir = parsed.data.inboxDir;
    persistInboxDir(config.dataDir, newDir);
    config.inboxDir = newDir;
    if (onInboxDirChange) await onInboxDirChange(newDir);
    store.logActivity("system", "settings.updated", `Watched folder changed to "${newDir}"`);
    return { inboxDir: config.inboxDir, model: config.model, ollamaBaseUrl: config.ollamaBaseUrl };
  });

  return app;
}

async function main() {
  const store = new Store(dbPath());
  const watcherModel = createLocalModel();
  let watcher: Awaited<ReturnType<typeof startInboxWatcher>> | undefined;

  const onInboxDirChange = async (newDir: string) => {
    await watcher?.close();
    watcher = await startInboxWatcher(store, watcherModel, newDir);
    console.log(`now watching ${newDir} for new documents`);
  };

  const app = buildServer(store, onInboxDirChange);
  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
    console.log(`agent-core listening on http://127.0.0.1:${config.port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  watcher = await startInboxWatcher(store, watcherModel, config.inboxDir);
  console.log(`watching ${config.inboxDir} for new documents`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await watcher?.close();
      process.exit(0);
    });
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main();
}
