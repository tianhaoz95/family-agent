import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { Store } from "./db.js";
import { config, dbPath } from "./config.js";
import { buildFamilyAgent, askFamilyAgent } from "./agents/index.js";
import { extractDocument } from "./agents/extraction.js";
import { createLocalModel } from "./model.js";
import { startInboxWatcher } from "./inboxWatcher.js";

export function buildServer(store: Store = new Store(dbPath())) {
  const app = Fastify({ logger: false });
  // Local-only server (see docs/DECISIONS.md) — the Tauri webview and any
  // future tailnet-connected companion app are different origins from this
  // server's perspective, so CORS is opened rather than restricted; there is
  // no cross-origin data to protect since nothing here is reachable off-box.
  void app.register(cors, { origin: true });
  const agent = buildFamilyAgent(store);
  const extractionModel = createLocalModel();

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

  app.get("/activity", async () => ({ activity: store.listActivity() }));

  return app;
}

async function main() {
  const store = new Store(dbPath());
  const app = buildServer(store);
  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
    console.log(`agent-core listening on http://127.0.0.1:${config.port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  const watcher = await startInboxWatcher(store, createLocalModel(), config.inboxDir);
  console.log(`watching ${config.inboxDir} for new documents`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await watcher.close();
      process.exit(0);
    });
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main();
}
