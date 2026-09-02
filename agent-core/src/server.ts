import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { Store, ScopedStore, type UserRecord } from "./db.js";
import { config, dbPath, envLocked, userInboxDir } from "./config.js";
import { buildFamilyAgent, askFamilyAgent, type FamilyAgent } from "./agents/index.js";
import { extractDocument } from "./agents/extraction.js";
import { createLocalModel } from "./model.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { persistSettings } from "./settingsFile.js";
import { verifyPassword, bearerToken } from "./auth.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./fileExtract.js";
import { listOllamaModels, ollamaListHasModel } from "./ollamaOcr.js";
import { toolsDir } from "./config.js";
import { ToolSupervisor } from "./tools/supervisor.js";
import { startToolsServer } from "./tools/server.js";
import { buildTool } from "./tools/builder.js";

// The authenticated user + their scoped store, attached by the auth hook and
// read by every non-public route handler.
declare module "fastify" {
  interface FastifyRequest {
    authUser: UserRecord;
    userStore: ScopedStore;
  }
}

/** A user as sent to clients — never the password hash. */
function publicUser(u: UserRecord) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}

// Routes reachable without a bearer token: discovery, and the auth handshake
// itself. Everything else 401s without a valid session.
const PUBLIC_ROUTES = new Set(["/health", "/auth/status", "/auth/login", "/auth/bootstrap"]);

export interface ServerHooks {
  /** A user changed their watched folder — restart just their watcher. */
  onUserInboxChange?: (userId: string, dir: string) => Promise<void>;
  /** model / ollamaBaseUrl changed — rebuild every model client + watcher. */
  onModelChange?: () => Promise<void>;
  /** A new account was created — start watching its inbox folder. */
  onUserCreated?: (user: UserRecord) => Promise<void>;
  /** An account was deleted — stop watching its inbox folder. */
  onUserDeleted?: (userId: string) => Promise<void>;
  /** The server display name changed — re-announce it over mDNS. */
  onServerNameChange?: (name: string) => Promise<void>;
}

export function buildServer(
  store: Store = new Store(dbPath()),
  hooks: ServerHooks = {},
  // Shared with main()'s tools HTTP server so both sides talk to the same
  // pool of sandboxed tool backends.
  supervisor: ToolSupervisor = new ToolSupervisor()
) {
  const app = Fastify({ logger: false });
  // Local-only server (see docs/DECISIONS.md). The Tauri webview and the
  // companion app are different origins from this server's perspective, so
  // CORS is opened rather than restricted; the real access control is the
  // bearer-token auth hook below, not the origin.
  //
  // methods must be listed explicitly: @fastify/cors defaults to
  // "GET,HEAD,POST" only. Found by actually clicking things in a browser, not
  // by the test suite — `app.inject()` and curl both bypass real CORS
  // preflight. If you add a route using a new HTTP method, add it here too.
  void app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });
  void app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  // ---- auth ----
  // Rejects a brute-force login loop. Per-username, in-memory (a restart
  // clears it — fine for a family LAN box).
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (key: string): boolean => {
    const now = Date.now();
    const rec = loginAttempts.get(key);
    if (!rec || now > rec.resetAt) {
      loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return false;
    }
    rec.count++;
    return rec.count > 10;
  };

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "OPTIONS") return;
    const routeUrl = req.routeOptions?.url ?? req.url.split("?")[0];
    if (PUBLIC_ROUTES.has(routeUrl)) return;
    const token = bearerToken(req.headers.authorization);
    const user = token ? store.resolveSession(token) : undefined;
    if (!user) return reply.code(401).send({ error: "Not signed in." });
    req.authUser = user;
    req.userStore = store.scoped(user.id);
  });

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.authUser?.role !== "admin") {
      return reply.code(403).send({ error: "Admins only." });
    }
  };

  // ---- model + per-user agent clients ----
  // Rebuilt (not hot-patched) when the model or Ollama URL changes — a
  // langchain ChatOllama binds its base URL and model at construction, and
  // the deepagents graph binds the model.
  let extractionModel = createLocalModel();

  const startToolBuild = (userId: string, prompt: string) => {
    if (!config.toolsEnabled) return;
    void buildTool(extractionModel, store.scoped(userId), supervisor, prompt).catch((e) => {
      console.error("tool build crashed:", e);
    });
  };

  // One planner graph per user, built on first use, bound to that user's
  // scoped store so a subagent can never see another family member's data.
  const agents = new Map<string, FamilyAgent>();
  const agentFor = (userId: string): FamilyAgent => {
    let a = agents.get(userId);
    if (!a) {
      a = buildFamilyAgent(store.scoped(userId), { startToolBuild: (p) => startToolBuild(userId, p) });
      agents.set(userId, a);
    }
    return a;
  };
  const rebuildModelClients = () => {
    extractionModel = createLocalModel();
    agents.clear();
  };

  // Rows left mid-flight by a previous run will never finish on their own —
  // mark them failed so the UI offers a retry instead of a stuck spinner.
  store.failStalePendingExtractions();
  store.failStaleBuildingTools();
  store.purgeExpiredSessions();

  // ---- health / discovery (public) ----
  app.get("/health", async () => ({
    ok: true,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    serverName: config.serverName,
    // The desktop shows a first-run setup wizard when this is true.
    needsSetup: store.countUsers() === 0,
    toolsPort: config.toolsPort,
    toolsEnabled: config.toolsEnabled && supervisor.denoAvailable() ? "full" : config.toolsEnabled ? "static-only" : "off",
  }));

  // zod's `error.message` is a JSON dump — fine for a dev, ugly in the UI.
  const firstIssue = (err: z.ZodError) => {
    const i = err.issues[0];
    return i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid request.";
  };

  // ---- auth handshake ----
  app.get("/auth/status", async () => ({
    needsSetup: store.countUsers() === 0,
    serverName: config.serverName,
  }));

  const BootstrapBody = z.object({
    serverName: z.string().trim().min(1).max(60).optional(),
    username: z.string().trim().min(1).max(40),
    displayName: z.string().trim().min(1).max(60),
    password: z.string().min(6).max(200),
  });
  // Creates the first (admin) account and claims any data left by a
  // single-user database. Only works while there are zero users.
  app.post("/auth/bootstrap", async (req, reply) => {
    if (store.countUsers() > 0) return reply.code(409).send({ error: "This server is already set up." });
    const parsed = BootstrapBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { serverName, username, displayName, password } = parsed.data;

    const user = store.createUser({ username, displayName, password, role: "admin" });
    const claimed = store.reassignLegacyData(user.id);
    if (serverName && !envLocked.serverName) {
      persistSettings(config.dataDir, { serverName });
      config.serverName = serverName;
      await hooks.onServerNameChange?.(serverName);
    }
    store.scoped(user.id).logActivity(
      "system",
      "user.created",
      claimed ? `Set up "${user.username}" (admin) and claimed ${claimed} existing item(s)` : `Set up "${user.username}" (admin)`
    );
    await hooks.onUserCreated?.(user);
    const { token } = store.createSession(user.id, "setup");
    return { token, user: publicUser(user) };
  });

  const LoginBody = z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
    deviceLabel: z.string().trim().max(80).optional(),
  });
  app.post("/auth/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { username, password, deviceLabel } = parsed.data;
    if (rateLimited(username.toLowerCase())) {
      return reply.code(429).send({ error: "Too many attempts. Wait a few minutes and try again." });
    }
    const user = store.getUserByUsername(username);
    const hash = user ? store.getPasswordHash(user.id) : undefined;
    // Same generic message + roughly-constant work whether the username
    // exists or not.
    if (!user || !hash || !verifyPassword(password, hash)) {
      if (!user) verifyPassword(password, "scrypt$00$00");
      return reply.code(401).send({ error: "Wrong username or password." });
    }
    loginAttempts.delete(username.toLowerCase());
    const { token } = store.createSession(user.id, deviceLabel ?? null);
    return { token, user: publicUser(user) };
  });

  app.post("/auth/logout", async (req) => {
    const token = bearerToken(req.headers.authorization);
    if (token) store.deleteSession(token);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => ({ user: publicUser(req.authUser) }));

  // ---- user management (admin, except self-service PATCH) ----
  app.get("/users", { preHandler: requireAdmin }, async () => ({
    users: store.listUsers().map(publicUser),
  }));

  const CreateUserBody = z.object({
    username: z.string().trim().min(1).max(40),
    displayName: z.string().trim().min(1).max(60),
    password: z.string().min(6).max(200),
    role: z.enum(["admin", "member"]).optional(),
  });
  app.post("/users", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    if (store.getUserByUsername(parsed.data.username)) {
      return reply.code(409).send({ error: "That username is taken." });
    }
    const user = store.createUser(parsed.data);
    store.scoped(req.authUser.id).logActivity("user", "user.created", `Created account "${user.username}"`);
    await hooks.onUserCreated?.(user);
    return { user: publicUser(user) };
  });

  const UpdateUserBody = z.object({
    displayName: z.string().trim().min(1).max(60).optional(),
    password: z.string().min(6).max(200).optional(),
    role: z.enum(["admin", "member"]).optional(),
  });
  app.patch("/users/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = store.getUser(id);
    if (!target) return reply.code(404).send({ error: "No such user." });
    const isSelf = req.authUser.id === id;
    const isAdmin = req.authUser.role === "admin";
    if (!isSelf && !isAdmin) return reply.code(403).send({ error: "You can only change your own account." });

    const parsed = UpdateUserBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const patch = parsed.data;
    if (patch.role !== undefined && !isAdmin) {
      return reply.code(403).send({ error: "Only an admin can change roles." });
    }
    if (patch.role === "member" && target.role === "admin" && store.countAdmins() <= 1) {
      return reply.code(400).send({ error: "This is the only admin — promote someone else first." });
    }
    const updated = store.updateUser(id, patch);
    // A password reset for someone else boots their other devices.
    if (patch.password !== undefined && !isSelf) store.deleteSessionsForUser(id);
    return { user: publicUser(updated!) };
  });

  app.delete("/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = store.getUser(id);
    if (!target) return reply.code(404).send({ error: "No such user." });
    if (id === req.authUser.id) return reply.code(400).send({ error: "You can't delete your own account." });
    if (target.role === "admin" && store.countAdmins() <= 1) {
      return reply.code(400).send({ error: "Can't delete the only admin." });
    }
    store.deleteUser(id);
    agents.delete(id);
    store.scoped(req.authUser.id).logActivity("user", "user.deleted", `Deleted account "${target.username}"`);
    await hooks.onUserDeleted?.(id);
    return { deleted: true };
  });

  // ---- chat ----
  const ChatBody = z.object({
    message: z.string().min(1),
    images: z.array(z.string().regex(/^data:image\/[a-z+.-]+;base64,/i)).max(4).optional(),
  });
  app.post("/chat", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { message, images = [] } = parsed.data;
    req.userStore.logActivity(
      "user",
      "chat.message",
      images.length ? `${message}  [+${images.length} image${images.length > 1 ? "s" : ""}]` : message
    );
    try {
      const responseText = await askFamilyAgent(agentFor(req.authUser.id), message, images);
      req.userStore.logActivity("family-planner", "chat.reply", responseText);
      return { reply: responseText };
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(502).send({
        error: "The local model could not be reached. Is Ollama running with the configured model pulled?",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- tasks ----
  app.get("/tasks", async (req) => {
    const status = (req.query as any)?.status;
    return { tasks: req.userStore.listTasks(status === "open" || status === "done" ? status : undefined) };
  });

  const CreateTaskBody = z.object({
    title: z.string().min(1),
    notes: z.string().optional(),
    dueDate: z.string().optional(),
  });
  app.post("/tasks", async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return { task: req.userStore.createTask(parsed.data) };
  });

  const UpdateTaskBody = z.object({ status: z.enum(["open", "done"]) });
  app.patch("/tasks/:id", async (req, reply) => {
    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { id } = req.params as { id: string };
    const updated = req.userStore.updateTaskStatus(id, parsed.data.status);
    if (!updated) return reply.code(404).send({ error: "task not found" });
    return { task: updated };
  });

  // ---- documents ----
  app.get("/documents", async (req) => ({ documents: req.userStore.listDocuments() }));

  const IngestBody = z.object({ filename: z.string().min(1), text: z.string().min(1) });
  app.post("/documents/ingest", async (req, reply) => {
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const doc = req.userStore.createDocument({ filename: parsed.data.filename, rawText: parsed.data.text });
    void extractDocument(extractionModel, req.userStore, doc);
    return { document: doc };
  });

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

    const doc = req.userStore.createDocument({ filename, rawText });
    void extractDocument(extractionModel, req.userStore, doc);
    return { document: doc };
  });

  app.delete("/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = req.userStore.deleteDocument(id);
    if (!deleted) return reply.code(404).send({ error: "document not found" });
    return { document: deleted };
  });

  app.post("/documents/:id/retry-extraction", async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = req.userStore.getDocument(id);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    req.userStore.setDocumentExtractionStatus(id, "pending");
    void extractDocument(extractionModel, req.userStore, { id: doc.id, filename: doc.filename, rawText: doc.rawText });
    return { document: req.userStore.getDocument(id) };
  });

  app.get("/activity", async (req) => ({ activity: req.userStore.listActivity() }));

  // ---- builder tools ----
  const toolView = (t: ReturnType<ScopedStore["getTool"]>) =>
    t && {
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      status: t.status,
      error: t.error,
      createdAt: t.createdAt,
      path: t.status === "ready" ? `/${t.id}/` : null,
    };

  app.get("/tools", async (req) => ({ tools: req.userStore.listTools().map(toolView) }));

  app.get("/tools/:id", async (req, reply) => {
    const view = toolView(req.userStore.getTool((req.params as { id: string }).id));
    if (!view) return reply.code(404).send({ error: "tool not found" });
    return { tool: view };
  });

  const BuildToolBody = z.object({ prompt: z.string().min(3).max(600) });
  app.post("/tools", async (req, reply) => {
    if (!config.toolsEnabled) return reply.code(403).send({ error: "Tool building is disabled." });
    const parsed = BuildToolBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const prompt = parsed.data.prompt;
    void buildTool(extractionModel, req.userStore, supervisor, prompt).catch((e) =>
      console.error("tool build crashed:", e)
    );
    return reply.code(202).send({ building: true, prompt });
  });

  app.delete("/tools/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    supervisor.stop(id);
    await rm(join(toolsDir(), id), { recursive: true, force: true }).catch(() => {});
    req.userStore.deleteTool(id);
    return { deleted: true };
  });

  app.get("/ollama/models", async () => {
    const models = await listOllamaModels();
    return { models: models ?? [], reachable: models !== null };
  });

  // ---- settings ----
  // model / ollamaBaseUrl / ocrModel / serverName are machine-wide (admin
  // only). inboxDir is this user's own watched folder.
  const settingsPayload = (user: UserRecord) => ({
    inboxDir: userInboxDir(user),
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ocrModel: config.ocrModel,
    serverName: config.serverName,
    isAdmin: user.role === "admin",
    envLocked,
  });

  app.get("/settings", async (req) => settingsPayload(req.authUser));

  const UpdateSettingsBody = z.object({
    inboxDir: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    ollamaBaseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://")
      .optional(),
    ocrModel: z.string().optional(),
    serverName: z.string().trim().min(1).max(60).optional(),
  });
  app.put("/settings", async (req, reply) => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const patch = parsed.data;
    if (Object.values(patch).every((v) => v === undefined)) {
      return reply.code(400).send({ error: "Nothing to update." });
    }

    const adminFields = ["model", "ollamaBaseUrl", "ocrModel", "serverName"] as const;
    if (req.authUser.role !== "admin" && adminFields.some((f) => patch[f] !== undefined)) {
      return reply.code(403).send({ error: "Only an admin can change machine settings." });
    }

    for (const key of ["inboxDir", "model", "ollamaBaseUrl", "ocrModel", "serverName"] as const) {
      if (patch[key] !== undefined && envLocked[key]) {
        return reply.code(400).send({
          error: `"${key}" is pinned by an environment variable and can't be changed here.`,
        });
      }
    }

    // Validate model / ocrModel against the Ollama we'd be using *after* this
    // change, when that Ollama is reachable to check.
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

    const machinePatch = {
      model: patch.model,
      ollamaBaseUrl: patch.ollamaBaseUrl,
      ocrModel: patch.ocrModel,
      serverName: patch.serverName,
    };
    if (Object.values(machinePatch).some((v) => v !== undefined)) {
      persistSettings(config.dataDir, machinePatch);
    }

    const modelClientsChanged = patch.model !== undefined || patch.ollamaBaseUrl !== undefined;
    if (patch.ollamaBaseUrl !== undefined) config.ollamaBaseUrl = patch.ollamaBaseUrl;
    if (patch.model !== undefined) config.model = patch.model;
    if (patch.ocrModel !== undefined) config.ocrModel = patch.ocrModel;
    if (patch.serverName !== undefined) config.serverName = patch.serverName;

    if (patch.inboxDir !== undefined) {
      store.updateUser(req.authUser.id, { inboxDir: patch.inboxDir });
      req.authUser.inboxDir = patch.inboxDir;
      await hooks.onUserInboxChange?.(req.authUser.id, patch.inboxDir);
    }
    if (modelClientsChanged) {
      rebuildModelClients();
      await hooks.onModelChange?.();
    }
    if (patch.serverName !== undefined) await hooks.onServerNameChange?.(patch.serverName);

    for (const [msg, changed] of [
      [`Watched folder changed to "${patch.inboxDir}"`, patch.inboxDir !== undefined],
      [`Chat model set to "${patch.model}"`, patch.model !== undefined],
      [`Ollama address set to "${patch.ollamaBaseUrl}"`, patch.ollamaBaseUrl !== undefined],
      [`Server name set to "${patch.serverName}"`, patch.serverName !== undefined],
      [
        patch.ocrModel ? `OCR model set to "${patch.ocrModel}"` : "OCR model cleared — using the built-in engine",
        patch.ocrModel !== undefined,
      ],
    ] as const) {
      if (changed) req.userStore.logActivity("system", "settings.updated", msg);
    }

    return settingsPayload(req.authUser);
  });

  return app;
}

async function main() {
  const store = new Store(dbPath());
  let watcherModel = createLocalModel();
  const watchers = new Map<string, Awaited<ReturnType<typeof startInboxWatcher>>>();
  const supervisor = new ToolSupervisor();
  let toolsServer: Awaited<ReturnType<typeof startToolsServer>> | undefined;

  const startWatcherFor = async (userId: string) => {
    const user = store.getUser(userId);
    if (!user) return;
    await watchers.get(userId)?.close();
    watchers.set(userId, await startInboxWatcher(store.scoped(userId), watcherModel, userInboxDir(user)));
  };

  if (config.toolsEnabled) {
    const { resolveDenoPath } = await import("./tools/supervisor.js");
    try {
      toolsServer = await startToolsServer(store, supervisor);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    }
    console.log(
      `tools server on http://127.0.0.1:${config.toolsPort}` +
        (resolveDenoPath() || supervisor.denoAvailable() ? " (Deno backend available)" : " (static tools only — Deno not found)")
    );
  }

  // mDNS: advertise this node so the Android app can discover it. Dynamic
  // import + try/catch so a missing optional dep or a locked-down network
  // just means "no discovery", never a crash.
  let mdns: { unpublishAll: () => void; destroy: () => void } | undefined;
  const publishMdns = async () => {
    if (!config.mdnsEnabled) return;
    try {
      const { Bonjour } = await import("bonjour-service");
      mdns?.destroy();
      const instance = new Bonjour();
      instance.publish({ name: config.serverName, type: "familyagent", port: config.port, txt: { v: "1" } });
      mdns = { unpublishAll: () => instance.unpublishAll(() => {}), destroy: () => instance.destroy() };
      console.log(`advertising "${config.serverName}" on the LAN as _familyagent._tcp`);
    } catch (err) {
      console.log(`mDNS advertising unavailable (${err instanceof Error ? err.message : err}) — Android will need a manual address`);
    }
  };

  const hooks = {
    onUserInboxChange: async (userId: string, dir: string) => {
      await startWatcherFor(userId);
      console.log(`now watching ${dir} for ${userId}`);
    },
    onModelChange: async () => {
      watcherModel = createLocalModel();
      for (const userId of [...watchers.keys()]) await startWatcherFor(userId);
      console.log(`model config changed — now using ${config.model} at ${config.ollamaBaseUrl}`);
    },
    onUserCreated: async (user: UserRecord) => {
      await startWatcherFor(user.id);
      console.log(`watching inbox for new account "${user.username}"`);
    },
    onUserDeleted: async (userId: string) => {
      await watchers.get(userId)?.close();
      watchers.delete(userId);
    },
    onServerNameChange: async () => {
      await publishMdns();
    },
  };

  const app = buildServer(store, hooks, supervisor);
  const listenDeadline = Date.now() + 8000;
  let listenWarned = false;
  for (;;) {
    try {
      await app.listen({ port: config.port, host: "0.0.0.0" });
      console.log(`agent-core listening on http://0.0.0.0:${config.port}`);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && Date.now() < listenDeadline) {
        if (!listenWarned) {
          console.log(
            `agent-core: port ${config.port} busy (a previous instance is shutting down) — retrying for up to 8s…`
          );
          listenWarned = true;
        }
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (code === "EADDRINUSE") {
        console.error(
          `agent-core: port ${config.port} is already in use and did not free up. ` +
            `Stop it with:  kill $(lsof -ti tcp:${config.port} tcp:${config.toolsPort})`
        );
      } else {
        console.error(err);
      }
      toolsServer?.close();
      process.exit(1);
    }
  }

  for (const user of store.listUsers()) await startWatcherFor(user.id);
  console.log(`watching ${watchers.size} account inbox folder(s)`);
  await publishMdns();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      mdns?.destroy();
      supervisor.stopAll();
      toolsServer?.close();
      for (const w of watchers.values()) await w.close();
      process.exit(0);
    });
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMain) {
  main();
}
