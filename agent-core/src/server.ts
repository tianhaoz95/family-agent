import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { Store } from "./db.js";
import { config, dbPath, envLocked } from "./config.js";
import { buildFamilyAgent, askFamilyAgent } from "./agents/index.js";
import { extractDocument } from "./agents/extraction.js";
import { createLocalModel } from "./model.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { persistSettings } from "./settingsFile.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./fileExtract.js";
import { listOllamaModels, ollamaListHasModel } from "./ollamaOcr.js";
import { toolsDir } from "./config.js";
import { ToolSupervisor } from "./tools/supervisor.js";
import { startToolsServer } from "./tools/server.js";
import { buildTool } from "./tools/builder.js";

export function buildServer(
  store: Store = new Store(dbPath()),
  onInboxDirChange?: (newDir: string) => Promise<void>,
  // Called after config.model / config.ollamaBaseUrl change and the in-process
  // agent + extraction clients have been rebuilt — main() uses it to rebuild
  // the inbox-watcher's model client and restart the watcher.
  onModelChange?: () => Promise<void>,
  // Shared with main()'s tools HTTP server so both sides talk to the same
  // pool of sandboxed tool backends.
  supervisor: ToolSupervisor = new ToolSupervisor()
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

  // Rebuilt (not hot-patched) when the model or Ollama URL changes — a
  // langchain ChatOllama binds its base URL and model at construction, and
  // the deepagents graph binds the model. The route handlers read these
  // `let`s fresh, so reassigning is enough.
  let extractionModel = createLocalModel();

  // Fire-and-forget tool generation. Used both by the builder-agent subagent
  // (chat: "build me a…") and POST /tools (the desktop's build form).
  const startToolBuild = (prompt: string) => {
    if (!config.toolsEnabled) return;
    void buildTool(extractionModel, store, supervisor, prompt).catch((e) => {
      // buildTool records failures on the ToolRecord itself; this catch is a
      // last resort for something outside that (e.g. mkdir failing).
      console.error("tool build crashed:", e);
    });
  };

  let agent = buildFamilyAgent(store, { startToolBuild });
  const rebuildModelClients = () => {
    extractionModel = createLocalModel();
    agent = buildFamilyAgent(store, { startToolBuild });
  };

  // Documents left mid-extraction by a previous run will never finish on
  // their own — mark them failed so the UI offers a retry instead of a
  // spinner that never resolves. Same for tool builds.
  store.failStalePendingExtractions();
  store.failStaleBuildingTools();

  app.get("/health", async () => ({
    ok: true,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    inboxDir: config.inboxDir,
    // Clients build a tool's URL as http://<same host>:<toolsPort>/<id>/
    toolsPort: config.toolsPort,
    toolsEnabled: config.toolsEnabled && supervisor.denoAvailable() ? "full" : config.toolsEnabled ? "static-only" : "off",
  }));

  // zod's `error.message` is a JSON dump — fine for a dev, ugly in the UI.
  // Surface just the first issue as "<field>: <message>".
  const firstIssue = (err: z.ZodError) => {
    const i = err.issues[0];
    return i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid request.";
  };

  const ChatBody = z.object({
    message: z.string().min(1),
    // Data URIs (data:image/png;base64,…) — the planner model is multimodal.
    // Capped so a stray huge upload can't wedge a slow local model.
    images: z.array(z.string().regex(/^data:image\/[a-z+.-]+;base64,/i)).max(4).optional(),
  });
  // A single photo base64-encodes to several MB — well over Fastify's 1 MB
  // default body limit.
  app.post("/chat", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { message, images = [] } = parsed.data;
    store.logActivity(
      "user",
      "chat.message",
      images.length ? `${message}  [+${images.length} image${images.length > 1 ? "s" : ""}]` : message
    );
    try {
      const responseText = await askFamilyAgent(agent, message, images);
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

  // ---- builder tools ----
  const toolView = (t: ReturnType<typeof store.getTool>) =>
    t && {
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      status: t.status,
      error: t.error,
      createdAt: t.createdAt,
      // Relative — the client prepends http://<host>:<toolsPort>.
      path: t.status === "ready" ? `/${t.id}/` : null,
    };

  app.get("/tools", async () => ({ tools: store.listTools().map(toolView) }));

  app.get("/tools/:id", async (req, reply) => {
    const view = toolView(store.getTool((req.params as { id: string }).id));
    if (!view) return reply.code(404).send({ error: "tool not found" });
    return { tool: view };
  });

  const BuildToolBody = z.object({ prompt: z.string().min(3).max(600) });
  app.post("/tools", async (req, reply) => {
    if (!config.toolsEnabled) return reply.code(403).send({ error: "Tool building is disabled." });
    const parsed = BuildToolBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    // Build synchronously enough to return the record, but the codegen itself
    // is slow — return immediately with a "building" placeholder and let the
    // client poll GET /tools, mirroring document extraction.
    const prompt = parsed.data.prompt;
    void buildTool(extractionModel, store, supervisor, prompt).catch((e) =>
      console.error("tool build crashed:", e)
    );
    return reply.code(202).send({ building: true, prompt });
  });

  app.delete("/tools/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = store.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    supervisor.stop(id);
    await rm(join(toolsDir(), id), { recursive: true, force: true }).catch(() => {});
    store.deleteTool(id);
    return { deleted: true };
  });

  // Models pulled into the configured Ollama — powers the Settings dropdowns.
  // `reachable: false` (with an empty list) means Ollama itself is down.
  app.get("/ollama/models", async () => {
    const models = await listOllamaModels();
    return { models: models ?? [], reachable: models !== null };
  });

  const settingsPayload = () => ({
    inboxDir: config.inboxDir,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    // "" means the built-in tesseract.js engine.
    ocrModel: config.ocrModel,
    // Which fields are pinned by an env var and therefore read-only in the UI.
    envLocked,
  });

  app.get("/settings", async () => settingsPayload());

  // All four settings are editable live unless pinned by an env var. Changing
  // `model` / `ollamaBaseUrl` rebuilds the agent + extraction model clients
  // (and, via onModelChange, the watcher's); `inboxDir` restarts the file
  // watcher; `ocrModel` is just read at extraction time. All persist to disk.
  const UpdateSettingsBody = z.object({
    // min(1) — a blank watched folder / model / URL is never meaningful.
    inboxDir: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    // Must be an absolute http(s) URL — zod's .url() alone accepts things like
    // "localhost:11434" (scheme "localhost"), which then can't be fetched.
    ollamaBaseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://")
      .optional(),
    // Empty string IS meaningful for ocrModel — it clears back to the
    // built-in engine — so it's the one field allowed to be "".
    ocrModel: z.string().optional(),
  });
  app.put("/settings", async (req, reply) => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const patch = parsed.data;
    if (Object.values(patch).every((v) => v === undefined)) {
      return reply.code(400).send({ error: "Nothing to update." });
    }

    for (const key of ["inboxDir", "model", "ollamaBaseUrl", "ocrModel"] as const) {
      if (patch[key] !== undefined && envLocked[key]) {
        return reply.code(400).send({
          error: `"${key}" is pinned by an environment variable and can't be changed here.`,
        });
      }
    }

    // Validate model / ocrModel against the Ollama we'd be using *after* this
    // change (so "point at a new Ollama + pick a model it has" works in one
    // PUT). Only enforced when that Ollama is actually reachable to check.
    const effectiveBaseUrl = patch.ollamaBaseUrl ?? config.ollamaBaseUrl;
    if (patch.model !== undefined || (patch.ocrModel !== undefined && patch.ocrModel !== "")) {
      const available = await listOllamaModels(effectiveBaseUrl);
      if (available) {
        for (const m of [patch.model, patch.ocrModel]) {
          if (m && !ollamaListHasModel(available, m)) {
            return reply.code(400).send({
              error: `"${m}" isn't pulled into Ollama at ${effectiveBaseUrl}. Run: ollama pull ${m}`,
            });
          }
        }
      }
    }

    persistSettings(config.dataDir, patch);

    const modelClientsChanged = patch.model !== undefined || patch.ollamaBaseUrl !== undefined;
    if (patch.ollamaBaseUrl !== undefined) config.ollamaBaseUrl = patch.ollamaBaseUrl;
    if (patch.model !== undefined) config.model = patch.model;
    if (patch.ocrModel !== undefined) config.ocrModel = patch.ocrModel;
    if (patch.inboxDir !== undefined) config.inboxDir = patch.inboxDir;

    if (modelClientsChanged) {
      rebuildModelClients();
      if (onModelChange) await onModelChange();
    }
    if (patch.inboxDir !== undefined && onInboxDirChange) {
      await onInboxDirChange(patch.inboxDir);
    }

    for (const [msg, changed] of [
      [`Watched folder changed to "${patch.inboxDir}"`, patch.inboxDir !== undefined],
      [`Chat model set to "${patch.model}"`, patch.model !== undefined],
      [`Ollama address set to "${patch.ollamaBaseUrl}"`, patch.ollamaBaseUrl !== undefined],
      [
        patch.ocrModel ? `OCR model set to "${patch.ocrModel}"` : "OCR model cleared — using the built-in engine",
        patch.ocrModel !== undefined,
      ],
    ] as const) {
      if (changed) store.logActivity("system", "settings.updated", msg);
    }

    return settingsPayload();
  });

  return app;
}

async function main() {
  const store = new Store(dbPath());
  let watcherModel = createLocalModel();
  let watcher: Awaited<ReturnType<typeof startInboxWatcher>> | undefined;
  const supervisor = new ToolSupervisor();
  let toolsServer: ReturnType<typeof startToolsServer> | undefined;
  if (config.toolsEnabled) {
    const { resolveDenoPath } = await import("./tools/supervisor.js");
    toolsServer = startToolsServer(store, supervisor);
    console.log(
      `tools server on http://127.0.0.1:${config.toolsPort}` +
        (resolveDenoPath() || supervisor.denoAvailable() ? " (Deno backend available)" : " (static tools only — Deno not found)")
    );
  }

  const onInboxDirChange = async (newDir: string) => {
    await watcher?.close();
    watcher = await startInboxWatcher(store, watcherModel, newDir);
    console.log(`now watching ${newDir} for new documents`);
  };

  const onModelChange = async () => {
    watcherModel = createLocalModel();
    await watcher?.close();
    watcher = await startInboxWatcher(store, watcherModel, config.inboxDir);
    console.log(`model config changed — now using ${config.model} at ${config.ollamaBaseUrl}`);
  };

  const app = buildServer(store, onInboxDirChange, onModelChange, supervisor);
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
      supervisor.stopAll();
      toolsServer?.close();
      await watcher?.close();
      process.exit(0);
    });
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main();
}
