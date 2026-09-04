import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { Store, ScopedStore, AGENT_SENDER_ID, type UserRecord } from "./db.js";
import { config, dbPath, envLocked, userInboxDir } from "./config.js";
import {
  buildFamilyAgent,
  buildFamilyToolsAgent,
  buildFamilyTaskAgent,
  buildFamilyDocumentAgent,
  buildFamilyBuilderAgent,
  buildFamilyNotesAgent,
  askFamilyAgent,
  askFamilyAgentInChannel,
  mentionsAgent,
  parseForcedAgentCommand,
  type ForcedAgentKind,
  type FamilyAgent,
  type InvokableAgent,
} from "./agents/index.js";
import { extractDocument } from "./agents/extraction.js";
import { suggestDocumentName } from "./agents/rename.js";
import { createLocalModel } from "./model.js";
import {
  createEmbedder,
  embedDocumentSafely,
  embeddingsEnabled,
  backfillEmbeddings,
  searchDocumentsSmart,
  type Embedder,
  type SearchMode,
} from "./embeddings.js";
import { warmModel } from "./warmup.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { persistSettings } from "./settingsFile.js";
import { verifyPassword, bearerToken } from "./auth.js";
import { rm, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import {
  storeOriginalUpload,
  renameOriginal,
  deleteOriginal,
  resolveOriginalPath,
  backfillOriginalDiskNames,
} from "./documentFiles.js";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "./fileExtract.js";
import { transcribeWav, resetTranscriber } from "./transcribe.js";
import { listOllamaModels, ollamaListHasModel } from "./ollamaOcr.js";
import { toolsDir } from "./config.js";
import { ToolSupervisor } from "./tools/supervisor.js";
import { startToolsServer } from "./tools/server.js";
import { buildTool, iterateTool, revertTool, toolHasPreviousVersion } from "./tools/builder.js";
import * as dbInspect from "./tools/dbInspect.js";
import { readManifestCache, refreshManifest, callOperation } from "./tools/toolMcp.js";
import type { FamilyToolEntry } from "./agents/toolTools.js";

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

// Enough coverage for the file types this app ingests (see SUPPORTED_EXTENSIONS)
// — used for the Content-Type of a document's original-file preview.
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
function mimeFromFilename(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "";
}

// Routes reachable without a bearer token: discovery, and the auth handshake
// itself. Everything else 401s without a valid session.
const PUBLIC_ROUTES = new Set(["/health", "/_diag", "/auth/status", "/auth/login", "/auth/bootstrap"]);

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
  // Embedding client for semantic document search. Null when the feature is
  // off (config.embedEnabled / FAMILY_AGENT_EMBED=0). Rebuilt on a model /
  // Ollama-URL change, same as extractionModel.
  let embedder: Embedder | null = createEmbedder();

  const startToolBuild = (userId: string, prompt: string) => {
    if (!config.toolsEnabled) return;
    void buildTool(extractionModel, store.scoped(userId), supervisor, prompt)
      // buildTool caches the new tool's MCP manifest itself; just drop this
      // user's planner graphs so they rebuild and tools-agent sees the change.
      .then(() => dropAgents(userId))
      .catch((e) => console.error("tool build crashed:", e));
  };

  const startToolIterate = (userId: string, toolId: string, instruction: string) => {
    if (!config.toolsEnabled) return;
    void iterateTool(extractionModel, store.scoped(userId), supervisor, toolId, instruction)
      .then(() => dropAgents(userId))
      .catch((e) => console.error("tool improve crashed:", e));
  };

  // Name + status of this user's tools, for builder-agent to resolve "the X tool".
  const toolsBrief = (userId: string) =>
    store.scoped(userId).listTools().map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      status: t.status,
      revisionState: t.revisionState,
    }));

  // Every ready tool this user has, with its callable operations (empty for a
  // static / display-only tool). tools-agent needs to *see* those too so it can
  // tell the user a tool exists but can't do X yet — rather than "no such tool"
  // and offering to build a duplicate. Read fresh each call so an added /
  // rebuilt / removed tool shows up without reconstructing the planner graph.
  const familyToolCatalog = (userId: string): FamilyToolEntry[] => {
    if (!config.toolsEnabled) return [];
    const out: FamilyToolEntry[] = [];
    for (const t of store.scoped(userId).listTools()) {
      if (t.status !== "ready") continue;
      const manifest = t.kind === "server" ? readManifestCache(t.id) : null;
      out.push({
        id: t.id,
        name: t.name,
        description: t.description,
        kind: t.kind,
        operations: manifest?.operations ?? [],
      });
    }
    return out;
  };

  // One agent per user per "mode": the general planner, plus one scoped-down
  // ReAct loop per subagent for a "/" forced turn (parseForcedAgentCommand,
  // agents/index.ts) — each built lazily and cached, bound to that user's
  // scoped store so a subagent can never see another family member's data.
  function makeAgentCache<T>(build: (userId: string) => T) {
    const cache = new Map<string, T>();
    return {
      get(userId: string): T {
        let a = cache.get(userId);
        if (!a) {
          a = build(userId);
          cache.set(userId, a);
        }
        return a;
      },
      delete: (userId: string) => cache.delete(userId),
      clear: () => cache.clear(),
    };
  }
  // Per-user sink for "the agent looked this up" hints — a fresh array is set
  // just before each /chat turn and read back after, so the reply can carry
  // clickable task / document references. Declared before the caches below
  // since every builder's onReference closes over it.
  const chatRefs = new Map<string, { type: "document" | "task" | "tool"; id: string }[]>();
  const familyToolsDeps = (userId: string) => ({
    getCatalog: () => familyToolCatalog(userId),
    callOperation: (toolId: string, operation: string, args: Record<string, unknown>) =>
      callOperation(toolId, operation, args, supervisor),
  });

  const plannerAgents = makeAgentCache<FamilyAgent>((userId) =>
    buildFamilyAgent(store.scoped(userId), {
      startToolBuild: (p) => startToolBuild(userId, p),
      startToolIterate: (toolId, instruction) => startToolIterate(userId, toolId, instruction),
      listTools: () => toolsBrief(userId),
      onReference: (ref) => chatRefs.get(userId)?.push(ref),
      getEmbedder: () => embedder,
      familyTools: config.toolsEnabled ? familyToolsDeps(userId) : undefined,
    })
  );
  // The four "/<keyword>" caches only ever get built when that keyword was
  // actually used (lazy per-cache, not just per-user), so a family that never
  // types "/note" never pays for a notes-only agent.
  const toolsAgents = makeAgentCache((userId) =>
    buildFamilyToolsAgent(store.scoped(userId), {
      onReference: (ref) => chatRefs.get(userId)?.push(ref),
      familyTools: familyToolsDeps(userId),
    })
  );
  const taskAgents = makeAgentCache((userId) =>
    buildFamilyTaskAgent(store.scoped(userId), { onReference: (ref) => chatRefs.get(userId)?.push(ref) })
  );
  const documentAgents = makeAgentCache((userId) =>
    buildFamilyDocumentAgent(store.scoped(userId), {
      onReference: (ref) => chatRefs.get(userId)?.push(ref),
      getEmbedder: () => embedder,
    })
  );
  const builderAgents = makeAgentCache((userId) =>
    buildFamilyBuilderAgent(store.scoped(userId), {
      startToolBuild: (p) => startToolBuild(userId, p),
      startToolIterate: (toolId, instruction) => startToolIterate(userId, toolId, instruction),
      listTools: () => toolsBrief(userId),
    })
  );
  const notesAgents = makeAgentCache((userId) => buildFamilyNotesAgent(store.scoped(userId)));

  // A tool build/improve/delete (or a model-client rebuild) invalidates every
  // one of the caches above in lockstep — miss one and a stale agent lingers.
  const dropAgents = (userId: string) => {
    plannerAgents.delete(userId);
    toolsAgents.delete(userId);
    taskAgents.delete(userId);
    documentAgents.delete(userId);
    builderAgents.delete(userId);
    notesAgents.delete(userId);
  };
  const dropAllAgents = () => {
    plannerAgents.clear();
    toolsAgents.clear();
    taskAgents.clear();
    documentAgents.clear();
    builderAgents.clear();
    notesAgents.clear();
  };
  const agentFor = (userId: string) => plannerAgents.get(userId);
  const toolsAgentFor = (userId: string) => toolsAgents.get(userId);
  const taskAgentFor = (userId: string) => taskAgents.get(userId);
  const documentAgentFor = (userId: string) => documentAgents.get(userId);
  const builderAgentFor = (userId: string) => builderAgents.get(userId);
  const notesAgentFor = (userId: string) => notesAgents.get(userId);
  // Resolve collected hints to {type, id, label}, deduped and capped.
  const resolveReferences = (userStore: ScopedStore, userId: string) => {
    const collected = chatRefs.get(userId) ?? [];
    chatRefs.delete(userId);
    const seen = new Set<string>();
    const out: { type: "document" | "task" | "tool"; id: string; label: string }[] = [];
    for (const r of collected) {
      const key = `${r.type}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.type === "document") {
        const d = userStore.getDocument(r.id);
        if (d) out.push({ type: "document", id: r.id, label: d.filename });
      } else if (r.type === "tool") {
        const t = userStore.getTool(r.id);
        if (t) out.push({ type: "tool", id: r.id, label: t.name });
      } else {
        const t = userStore.getTask(r.id);
        if (t) out.push({ type: "task", id: r.id, label: t.title });
      }
      if (out.length >= 8) break;
    }
    return out;
  };
  const rebuildModelClients = () => {
    extractionModel = createLocalModel();
    embedder = createEmbedder();
    dropAllAgents();
  };
  // Just the embedder — for an embedModel change that leaves the chat model
  // (and its warmed prefix cache, watchers, planner graphs) untouched.
  const rebuildEmbedder = () => {
    embedder = createEmbedder();
  };

  // Rows left mid-flight by a previous run will never finish on their own —
  // mark them failed so the UI offers a retry instead of a stuck spinner.
  store.failStalePendingExtractions();
  store.failStaleBuildingTools();
  store.failStalePendingMessages();
  store.purgeExpiredSessions();

  // Build the semantic-search vector index for any document that predates the
  // feature (or a model change). Fire-and-forget and self-skipping when the
  // embedding model isn't reachable — never blocks startup or the API. No-op
  // when the feature is off (embedder is null).
  void backfillEmbeddings(store, () => embedder);

  // Cache the MCP operation list for any server tool that predates the feature
  // (or lost its cache). Fire-and-forget — boots each backend once, then stops
  // it. No-op when tools are disabled or Deno isn't available.
  if (config.toolsEnabled && supervisor.denoAvailable()) {
    void (async () => {
      for (const u of store.listUsers()) {
        for (const t of store.scoped(u.id).listTools()) {
          if (t.kind === "server" && t.status === "ready" && !readManifestCache(t.id)) {
            await refreshManifest(t.id, t.name, supervisor).catch(() => {});
            supervisor.stop(t.id);
          }
        }
      }
    })();
  }

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
    // Both chat UIs hide the mic button when this is false.
    asrEnabled: config.asrEnabled,
    // "on" once a model is configured; actual reachability is checked lazily
    // and search falls back to keyword + fuzzy if it's down.
    semanticSearch: embeddingsEnabled() ? "on" : "off",
  }));

  app.post("/_diag", async (req) => {
    console.log("[DIAG]", JSON.stringify(req.body));
    return { ok: true };
  });

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
    dropAgents(id);
    store.scoped(req.authUser.id).logActivity("user", "user.deleted", `Deleted account "${target.username}"`);
    await hooks.onUserDeleted?.(id);
    return { deleted: true };
  });

  // ---- chat ----
  // A "session" is this user's own persisted conversation with the assistant
  // (chat_sessions/chat_messages, ScopedStore — not the cross-account
  // channels/messages behind family chat). POST /chat lazily creates one on
  // the first turn (no sessionId in the body) and hands its id back; the
  // client holds onto it for the rest of that conversation.
  const ChatBody = z.object({
    message: z.string().min(1),
    images: z.array(z.string().regex(/^data:image\/[a-z+.-]+;base64,/i)).max(4).optional(),
    sessionId: z.string().min(1).optional(),
  });
  app.post("/chat", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { message, images = [], sessionId } = parsed.data;

    let session = sessionId ? req.userStore.getChatSession(sessionId) : undefined;
    if (sessionId && !session) return reply.code(404).send({ error: "No such chat session." });
    if (!session) session = req.userStore.createChatSession(message);

    // Prior turns of this session, as context for the model — captured before
    // this turn's own message is stored, so it isn't echoed back to itself.
    const priorMessages = req.userStore.listChatMessages(session.id).slice(-20);
    req.userStore.addChatMessage(session.id, "user", message, images);
    req.userStore.logActivity(
      "user",
      "chat.message",
      images.length ? `${message}  [+${images.length} image${images.length > 1 ? "s" : ""}]` : message
    );
    try {
      chatRefs.set(req.authUser.id, []);
      const history = priorMessages.map((m) => ({ role: m.role, content: m.body }));
      // A leading "/" (typed by hand, or via the client's command/tool
      // autocomplete) skips the planner's own delegation decision — unreliable
      // on a small model — and runs one specialist agent directly.
      let responseText: string;
      const forced = parseForcedAgentCommand(message);
      if (forced) {
        if (forced.kind === "tools" && !config.toolsEnabled) {
          responseText = "Tools aren't turned on for this server.";
        } else {
          const agentByKind: Record<ForcedAgentKind, (userId: string) => InvokableAgent> = {
            tools: toolsAgentFor,
            task: taskAgentFor,
            document: documentAgentFor,
            builder: builderAgentFor,
            notes: notesAgentFor,
          };
          const fallbackByKind: Record<ForcedAgentKind, string> = {
            tools: "What can you do?",
            task: "List my tasks.",
            document: "What documents do I have?",
            builder: "What tools do we have, and what can be built?",
            notes: "What's on the sticky notes?",
          };
          const agent = agentByKind[forced.kind](req.authUser.id);
          responseText = await askFamilyAgent(agent, forced.text || fallbackByKind[forced.kind], images, history);
        }
      } else {
        responseText = await askFamilyAgent(agentFor(req.authUser.id), message, images, history);
      }
      const references = resolveReferences(req.userStore, req.authUser.id);
      req.userStore.addChatMessage(session.id, "assistant", responseText, [], references);
      req.userStore.logActivity("family-planner", "chat.reply", responseText);
      return { reply: responseText, references, sessionId: session.id };
    } catch (err) {
      chatRefs.delete(req.authUser.id);
      req.log?.error?.(err);
      return reply.code(502).send({
        error: "The local model could not be reached. Is Ollama running with the configured model pulled?",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/chat/sessions", async (req) => ({ sessions: req.userStore.listChatSessions() }));

  app.get("/chat/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!req.userStore.getChatSession(id)) return reply.code(404).send({ error: "No such chat session." });
    return { messages: req.userStore.listChatMessages(id) };
  });

  const RenameChatSessionBody = z.object({ title: z.string().min(1).max(120) });
  app.patch("/chat/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RenameChatSessionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const session = req.userStore.renameChatSession(id, parsed.data.title);
    if (!session) return reply.code(404).send({ error: "No such chat session." });
    return { session };
  });

  app.delete("/chat/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!req.userStore.deleteChatSession(id)) return reply.code(404).send({ error: "No such chat session." });
    return { deleted: true };
  });

  // ---- voice input ----
  // Speech-to-text for the mic button in both chat composers. The client
  // records a clip and sends it as a WAV (multipart, field "audio"); we hand
  // back the transcript for the user to review and send. Whisper runs
  // in-process (transcribe.ts) and never touches the planner.
  app.post("/transcribe", async (req, reply) => {
    if (!config.asrEnabled) {
      return reply.code(403).send({ error: "Voice input is turned off on this server." });
    }
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "Send the recording as multipart/form-data (field \"audio\")." });
    }
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No audio uploaded." });
    const buffer = await data.toBuffer();
    if (buffer.length === 0) return reply.code(400).send({ error: "The audio clip is empty." });
    try {
      const { text } = await transcribeWav(buffer);
      req.userStore.logActivity("user", "voice.transcribed", text || "(no speech detected)");
      return { text };
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(502).send({
        error: "Could not transcribe the audio.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---- tasks ----
  app.get("/tasks", async (req) => {
    const status = (req.query as any)?.status;
    return { tasks: req.userStore.listTasks(status === "open" || status === "done" ? status : undefined) };
  });

  // Keyword search over this user's tasks. `q` empty + `status` set is just
  // "my open tasks" (see ScopedStore.searchTasks). Same shape as /documents/search.
  app.get("/tasks/search", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const status = q.status === "open" || q.status === "done" ? q.status : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    return {
      results: req.userStore.searchTasks(q.q ?? "", {
        status,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    };
  });

  app.get("/tasks/:id", async (req, reply) => {
    const task = req.userStore.getTask((req.params as { id: string }).id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return { task };
  });

  const CreateTaskBody = z.object({
    title: z.string().min(1),
    notes: z.string().optional(),
    dueDate: z.string().optional(),
    dueTime: z.string().optional(),
  });
  app.post("/tasks", async (req, reply) => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return { task: req.userStore.createTask(parsed.data) };
  });

  const UpdateTaskBody = z
    .object({
      status: z.enum(["open", "done"]).optional(),
      dueDate: z.string().nullable().optional(),
      dueTime: z.string().nullable().optional(),
    })
    .refine((b) => b.status !== undefined || "dueDate" in b || "dueTime" in b, {
      message: "provide status and/or dueDate and/or dueTime",
    });
  app.patch("/tasks/:id", async (req, reply) => {
    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { id } = req.params as { id: string };
    const updated = req.userStore.updateTask(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "task not found" });
    return { task: updated };
  });

  // ---- documents ----
  app.get("/documents", async (req) => ({ documents: req.userStore.listDocuments() }));

  // Document search (filename + full text + summary), ranked, with optional
  // category / important-date-range filters. `q` empty + a filter set is a
  // pure structured query, e.g. ?category=bill&dueBefore=2026-10-01.
  // `mode` (default "hybrid"): keyword | fuzzy | semantic | hybrid. hybrid
  // merges keyword + trigram-fuzzy + (when the embedding model is available)
  // semantic search by reciprocal-rank fusion. See embeddings.ts.
  const SEARCH_MODES: SearchMode[] = ["keyword", "fuzzy", "semantic", "hybrid"];
  app.get("/documents/search", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = q.limit ? Number(q.limit) : undefined;
    const mode = SEARCH_MODES.includes(q.mode as SearchMode) ? (q.mode as SearchMode) : undefined;
    return {
      results: await searchDocumentsSmart(embedder, req.userStore, q.q ?? "", {
        category: q.category || undefined,
        dueBefore: q.dueBefore || undefined,
        dueAfter: q.dueAfter || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        mode,
      }),
    };
  });

  app.get("/documents/:id", async (req, reply) => {
    const doc = req.userStore.getDocument((req.params as { id: string }).id);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    return { document: doc };
  });

  const IngestBody = z.object({ filename: z.string().min(1), text: z.string().min(1) });
  app.post("/documents/ingest", async (req, reply) => {
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const doc = req.userStore.createDocument({ filename: parsed.data.filename, rawText: parsed.data.text });
    void extractDocument(extractionModel, req.userStore, doc);
    void embedDocumentSafely(embedder, req.userStore, doc);
    return { document: doc };
  });

  app.post("/documents/upload", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "No file uploaded." });

    const filename = data.filename || "upload";
    const uploadMime = data.mimetype || "";
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
    // Keep the original bytes so the document can be previewed later (PDF
    // viewer / image), not just its extracted text — saved under the doc's own
    // filename so the documents folder stays browsable. Best-effort: a failed
    // write just means "no preview", the document itself is already saved.
    try {
      const diskName = await storeOriginalUpload(req.authUser.id, doc.filename, buffer);
      req.userStore.setDocumentOriginalDiskName(doc.id, diskName);
      req.userStore.setDocumentOriginalMime(doc.id, uploadMime || mimeFromFilename(filename));
    } catch (err) {
      req.log?.warn?.({ err }, "could not store original upload for preview");
    }
    void extractDocument(extractionModel, req.userStore, doc);
    void embedDocumentSafely(embedder, req.userStore, doc);
    return { document: req.userStore.getDocument(doc.id) ?? doc };
  });

  // Stream a document's original file for preview (PDF viewer / image). Comes
  // from the per-user store dir for uploads, or the watched-folder path for
  // inbox documents. 404 when neither exists (e.g. a pasted-text document).
  app.get("/documents/:id/original", async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = req.userStore.getDocument(id);
    if (!doc) return reply.code(404).send({ error: "document not found" });

    const path = await resolveOriginalPath(req.authUser.id, id, doc.originalDiskName, doc.sourcePath);
    if (!path) return reply.code(404).send({ error: "no original file for this document" });

    const buf = await readFile(path);
    return reply
      .header("Content-Type", doc.originalMime || mimeFromFilename(doc.filename) || "application/octet-stream")
      .header("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`)
      .header("Cache-Control", "private, max-age=60")
      .send(buf);
  });

  app.delete("/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = req.userStore.deleteDocument(id);
    if (!deleted) return reply.code(404).send({ error: "document not found" });
    // Drop the stored original too (never the watched-folder source). Cover
    // both the tracked filename and the legacy <docId> path.
    await deleteOriginal(req.authUser.id, deleted.originalDiskName);
    await deleteOriginal(req.authUser.id, id);
    return { document: deleted };
  });

  // Manual rename. The AI-rename flow uses this too: the client fetches a
  // suggestion from /suggest-name, shows it to the user, and only PATCHes here
  // once the user confirms — the model never renames anything on its own.
  const RenameBody = z.object({ filename: z.string().min(1).max(160) });
  app.patch("/documents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const by =
      (req.body as { by?: unknown }).by === "document-agent" ? "document-agent" : "user";
    const doc = req.userStore.renameDocument(id, parsed.data.filename, by);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    // Keep the on-disk original's name in step with the document's. Uploads
    // only — renameOriginal() no-ops when there's nothing in the user's
    // documents dir (watched-folder / pasted-text docs), and resolves a
    // collision with a " (2)" suffix rather than clobbering another file.
    try {
      const moved = await renameOriginal(req.authUser.id, doc.originalDiskName ?? id, doc.filename);
      if (moved && moved !== doc.originalDiskName) {
        req.userStore.setDocumentOriginalDiskName(id, moved);
      }
    } catch (err) {
      req.log?.warn?.({ err }, "could not rename stored original");
    }
    return { document: req.userStore.getDocument(id) ?? doc };
  });

  // Ask the local model for a better filename from the document's content.
  // Returns the suggestion WITHOUT applying it — the client asks the user to
  // confirm, then PATCHes /documents/:id.
  app.post("/documents/:id/suggest-name", async (req, reply) => {
    const doc = req.userStore.getDocument((req.params as { id: string }).id);
    if (!doc) return reply.code(404).send({ error: "document not found" });
    if (!doc.rawText.trim()) {
      return reply.code(422).send({ error: "This document has no readable text to name it from." });
    }
    const suggestion = await suggestDocumentName(extractionModel, {
      filename: doc.filename,
      rawText: doc.rawText,
      extracted: doc.extracted,
    });
    if (!suggestion) {
      return reply.code(422).send({ error: "Couldn't come up with a name for this document." });
    }
    return { suggestion, current: doc.filename };
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

  // ---- family directory ----
  // Every authenticated user can see who else has an account (name + username
  // only) so they can start a chat or @-mention someone. NOT the admin-only
  // /users route.
  app.get("/family/members", async () => ({ members: store.listFamilyMembers() }));

  // ---- family chat (DMs + group channels) ----
  // The first cross-account feature. Membership is the access control: each
  // handler passes req.authUser.id to a Store method that returns nothing when
  // the caller isn't in the channel.
  app.get("/channels", async (req) => ({
    channels: store.listChannelsForUser(req.authUser.id),
  }));

  const CreateChannelBody = z.object({
    kind: z.enum(["dm", "group"]),
    memberIds: z.array(z.string().min(1)).min(1),
    name: z.string().trim().min(1).max(60).optional(),
  });
  app.post("/channels", async (req, reply) => {
    const parsed = CreateChannelBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { kind, memberIds, name } = parsed.data;
    const others = memberIds.filter((id) => id !== req.authUser.id);
    for (const id of others) {
      if (!store.getUser(id)) return reply.code(400).send({ error: "One of those people isn't on this home." });
    }
    if (kind === "dm") {
      if (others.length !== 1) return reply.code(400).send({ error: "A direct message needs exactly one other person." });
      return { channel: store.findOrCreateDm(req.authUser.id, others[0]) };
    }
    if (!name) return reply.code(400).send({ error: "A group needs a name." });
    return { channel: store.createGroupChannel(req.authUser.id, name, others) };
  });

  app.get("/channels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = store.getChannelForUser(id, req.authUser.id);
    if (!channel) return reply.code(403).send({ error: "You're not in that conversation." });
    return { channel };
  });

  app.get("/channels/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.isChannelMember(id, req.authUser.id)) {
      return reply.code(403).send({ error: "You're not in that conversation." });
    }
    const after = (req.query as any)?.after as string | undefined;
    return { messages: store.listMessages(id, req.authUser.id, { afterTs: after || null }) };
  });

  const PostMessageBody = z.object({
    body: z.string().min(1).max(4000),
    mentionAgent: z.boolean().optional(),
    // Image attachments as data URIs — mirrors POST /chat. Capped to keep a
    // single row (and the multimodal planner turn) sane.
    images: z.array(z.string().startsWith("data:image/")).max(4).optional(),
  });
  app.post("/channels/:id/messages", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.isChannelMember(id, req.authUser.id)) {
      return reply.code(403).send({ error: "You're not in that conversation." });
    }
    const parsed = PostMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { body } = parsed.data;
    const images = parsed.data.images ?? [];
    const message = store.postMessage(id, req.authUser.id, body, images);
    req.userStore.logActivity("user", "chat.message", `${req.authUser.displayName} in a family chat: ${body}`);

    if (parsed.data.mentionAgent || mentionsAgent(body)) {
      const pending = store.insertPendingAgentMessage(id);
      // Fire-and-forget: the client polls for the pending row to fill in.
      void (async () => {
        try {
          const recent = store.listMessages(id, req.authUser.id, { limit: 20 });
          const nameFor = (senderId: string) =>
            senderId === AGENT_SENDER_ID
              ? "Assistant"
              : store.getUser(senderId)?.displayName ?? "Someone";
          const transcript = recent
            .filter((m) => !m.pending)
            .map((m) => `${nameFor(m.senderId)}: ${m.body}`)
            .join("\n");
          const replyText = await askFamilyAgentInChannel(agentFor(req.authUser.id), transcript, body, images);
          store.resolvePendingAgentMessage(pending.id, replyText);
          store.scoped(req.authUser.id).logActivity("family-planner", "chat.reply", replyText);
        } catch (err) {
          console.error("in-channel agent reply failed:", err);
          store.resolvePendingAgentMessage(
            pending.id,
            "Sorry — I couldn't reach the local model just now."
          );
        }
      })();
    }
    return { message };
  });

  const AddMembersBody = z.object({ memberIds: z.array(z.string().min(1)).min(1) });
  app.post("/channels/:id/members", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AddMembersBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const updated = store.addChannelMembers(id, req.authUser.id, parsed.data.memberIds);
    if (!updated) return reply.code(403).send({ error: "Can't add people to that conversation." });
    return { channel: updated };
  });

  const ReadBody = z.object({ ts: z.string().min(1) });
  app.post("/channels/:id/read", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.isChannelMember(id, req.authUser.id)) {
      return reply.code(403).send({ error: "You're not in that conversation." });
    }
    const parsed = ReadBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    store.markChannelRead(id, req.authUser.id, parsed.data.ts);
    return { ok: true };
  });

  app.delete("/channels/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteChannel(id, req.authUser.id)) {
      return reply.code(403).send({ error: "You're not in that conversation." });
    }
    req.userStore.logActivity("user", "chat.channel.delete", `${req.authUser.displayName} deleted a conversation`);
    return { deleted: true };
  });

  // ---- sticky notes ----
  app.get("/notes", async (req) => {
    const scope = (req.query as any)?.scope === "private" ? "private" : "shared";
    return { notes: req.userStore.listStickyNotes(scope) };
  });

  // A fresh "+ Add" note starts blank (text ""), so no min length here — the
  // note is a real object on the board the moment you add it, edited in place.
  const coord = z.number().finite().min(-2000).max(20000);
  const CreateNoteBody = z.object({
    scope: z.enum(["shared", "private"]),
    text: z.string().trim().max(2000).default(""),
    color: z.string().trim().max(24).optional(),
    x: coord.optional(),
    y: coord.optional(),
  });
  app.post("/notes", async (req, reply) => {
    const parsed = CreateNoteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    return { note: req.userStore.createStickyNote(parsed.data) };
  });

  const UpdateNoteBody = z
    .object({
      text: z.string().trim().max(2000).optional(),
      color: z.string().trim().max(24).optional(),
      x: coord.optional(),
      y: coord.optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to update." });
  app.patch("/notes/:id", async (req, reply) => {
    const parsed = UpdateNoteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { id } = req.params as { id: string };
    const note = req.userStore.updateStickyNote(id, parsed.data);
    if (!note) return reply.code(404).send({ error: "note not found" });
    return { note };
  });

  app.delete("/notes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = req.userStore.deleteStickyNote(id);
    if (!note) return reply.code(404).send({ error: "note not found" });
    return { note };
  });

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
      updatedAt: t.updatedAt,
      revisionCount: t.revisionCount,
      // null = idle · "revising" = an improve is running · else = why the last improve failed
      revisionState: t.revisionState,
      canRevert: toolHasPreviousVersion(t.id),
      path: t.status === "ready" ? `/${t.id}/` : null,
    };

  app.get("/tools", async (req) => ({ tools: req.userStore.listTools().map(toolView) }));

  app.get("/tools/:id", async (req, reply) => {
    const view = toolView(req.userStore.getTool((req.params as { id: string }).id));
    if (!view) return reply.code(404).send({ error: "tool not found" });
    return { tool: view };
  });

  // The operations this tool exposes to the chat assistant (its MCP tools/list,
  // cached at build time — see tools/toolMcp.ts). Empty for static tools and
  // for server tools built before the operations format.
  app.get("/tools/:id/operations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    const manifest = readManifestCache(id);
    return {
      operations: (manifest?.operations ?? []).map((o) => ({
        name: o.name,
        description: o.description,
        access: o.access,
        inputSchema: o.inputSchema,
      })),
    };
  });

  const BuildToolBody = z.object({ prompt: z.string().min(3).max(600) });
  app.post("/tools", async (req, reply) => {
    if (!config.toolsEnabled) return reply.code(403).send({ error: "Tool building is disabled." });
    const parsed = BuildToolBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const prompt = parsed.data.prompt;
    // Same path as a build kicked off from chat — refreshes the tool's MCP
    // manifest and busts the planner cache when it finishes.
    startToolBuild(req.authUser.id, prompt);
    return reply.code(202).send({ building: true, prompt });
  });

  const IterateToolBody = z.object({ instruction: z.string().min(3).max(600) });
  app.post("/tools/:id/iterate", async (req, reply) => {
    if (!config.toolsEnabled) return reply.code(403).send({ error: "Tool building is disabled." });
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    if (tool.revisionState === "revising") return reply.code(409).send({ error: "This tool is already being improved." });
    const parsed = IterateToolBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    startToolIterate(req.authUser.id, id, parsed.data.instruction);
    return reply.code(202).send({ improving: true, instruction: parsed.data.instruction });
  });

  app.post("/tools/:id/revert", async (req, reply) => {
    if (!config.toolsEnabled) return reply.code(403).send({ error: "Tool building is disabled." });
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    const result = await revertTool(req.userStore, supervisor, id);
    if (!result.ok) return reply.code(400).send({ error: result.note });
    dropAgents(req.authUser.id);
    return { tool: toolView(req.userStore.getTool(id)), note: result.note };
  });

  app.delete("/tools/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    supervisor.stop(id);
    await rm(join(toolsDir(), id), { recursive: true, force: true }).catch(() => {});
    req.userStore.deleteTool(id);
    // Drop the planner graphs so tools-agent stops offering the removed tool.
    dropAgents(req.authUser.id);
    return { deleted: true };
  });

  // ---- tool database inspector ----
  // Read-only browsing of a "server"-kind tool's private SQLite db
  // (<dataDir>/tools/<id>/data/tool.db — see tools/harness.ts and
  // tools/dbInspect.ts). Scoped to the caller's own tools via getTool().
  const ownedTool = (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const tool = req.userStore.getTool(id);
    if (!tool) {
      reply.code(404).send({ error: "tool not found" });
      return null;
    }
    return tool;
  };

  const sendDbError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof dbInspect.ToolDbMissing) return reply.code(404).send({ error: e.message });
    if (e instanceof dbInspect.BadIdentifier || e instanceof dbInspect.NotReadOnlySql) {
      return reply.code(400).send({ error: e.message });
    }
    return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
  };

  app.get("/tools/:id/db", async (req, reply) => {
    const tool = ownedTool(req, reply);
    if (!tool) return;
    const id = (req.params as { id: string }).id;
    try {
      return tool.kind === "server"
        ? { kind: "server", ...dbInspect.overview(id) }
        : { kind: "static", ...dbInspect.staticOverview(id) };
    } catch (e) {
      return sendDbError(reply, e);
    }
  });

  const DbStateQuery = z.object({ key: z.string().min(1).max(64) });

  app.get("/tools/:id/db/state", async (req, reply) => {
    const tool = ownedTool(req, reply);
    if (!tool) return;
    if (tool.kind === "server") {
      return reply.code(400).send({ error: "server tools keep state in the _kv table" });
    }
    const parsed = DbStateQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      return { key: parsed.data.key, value: dbInspect.staticStateValue((req.params as { id: string }).id, parsed.data.key) };
    } catch (e) {
      return sendDbError(reply, e);
    }
  });

  const DbRowsQuery = z.object({
    table: z.string().min(1).max(128),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    orderBy: z.string().max(128).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
  });

  app.get("/tools/:id/db/rows", async (req, reply) => {
    const tool = ownedTool(req, reply);
    if (!tool) return;
    if (tool.kind !== "server") return reply.code(400).send({ error: "this tool has no database" });
    const parsed = DbRowsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      return dbInspect.page((req.params as { id: string }).id, parsed.data.table, parsed.data);
    } catch (e) {
      return sendDbError(reply, e);
    }
  });

  const DbQueryBody = z.object({ sql: z.string().min(1).max(4000) });

  app.post("/tools/:id/db/query", async (req, reply) => {
    const tool = ownedTool(req, reply);
    if (!tool) return;
    if (tool.kind !== "server") return reply.code(400).send({ error: "this tool has no database" });
    const parsed = DbQueryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      return dbInspect.query((req.params as { id: string }).id, parsed.data.sql);
    } catch (e) {
      return sendDbError(reply, e);
    }
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
    asrModel: config.asrModel,
    asrEnabled: config.asrEnabled,
    embedModel: config.embedModel,
    embedEnabled: config.embedEnabled,
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
    asrModel: z.string().trim().max(120).optional(),
    embedModel: z.string().trim().max(120).optional(),
    serverName: z.string().trim().min(1).max(60).optional(),
  });
  app.put("/settings", async (req, reply) => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const patch = parsed.data;
    if (Object.values(patch).every((v) => v === undefined)) {
      return reply.code(400).send({ error: "Nothing to update." });
    }

    const adminFields = ["model", "ollamaBaseUrl", "ocrModel", "asrModel", "embedModel", "serverName"] as const;
    if (req.authUser.role !== "admin" && adminFields.some((f) => patch[f] !== undefined)) {
      return reply.code(403).send({ error: "Only an admin can change machine settings." });
    }

    for (const key of ["inboxDir", "model", "ollamaBaseUrl", "ocrModel", "asrModel", "embedModel", "serverName"] as const) {
      if (patch[key] !== undefined && envLocked[key]) {
        return reply.code(400).send({
          error: `"${key}" is pinned by an environment variable and can't be changed here.`,
        });
      }
    }

    // Validate model / ocrModel / embedModel against the Ollama we'd be using
    // *after* this change, when that Ollama is reachable to check.
    const effectiveBaseUrl = patch.ollamaBaseUrl ?? config.ollamaBaseUrl;
    const checkModels = [patch.model, patch.ocrModel, patch.embedModel].filter(
      (m): m is string => m !== undefined && m !== ""
    );
    if (checkModels.length > 0) {
      const available = await listOllamaModels(effectiveBaseUrl);
      if (available) {
        for (const m of checkModels) {
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
      asrModel: patch.asrModel,
      embedModel: patch.embedModel,
      serverName: patch.serverName,
    };
    if (Object.values(machinePatch).some((v) => v !== undefined)) {
      persistSettings(config.dataDir, machinePatch);
    }

    // The chat/planner + extraction + inbox-watcher clients only care about
    // model / ollamaBaseUrl. The embedder additionally cares about embedModel.
    const chatModelChanged = patch.model !== undefined || patch.ollamaBaseUrl !== undefined;
    const semanticIndexChanged = patch.embedModel !== undefined || patch.ollamaBaseUrl !== undefined;
    if (patch.ollamaBaseUrl !== undefined) config.ollamaBaseUrl = patch.ollamaBaseUrl;
    if (patch.model !== undefined) config.model = patch.model;
    if (patch.embedModel !== undefined) config.embedModel = patch.embedModel;
    if (patch.ocrModel !== undefined) config.ocrModel = patch.ocrModel;
    if (patch.asrModel !== undefined) {
      config.asrModel = patch.asrModel || "Xenova/whisper-base";
      resetTranscriber(); // next /transcribe rebuilds the pipeline on the new model
    }
    if (patch.serverName !== undefined) config.serverName = patch.serverName;

    if (patch.inboxDir !== undefined) {
      store.updateUser(req.authUser.id, { inboxDir: patch.inboxDir });
      req.authUser.inboxDir = patch.inboxDir;
      await hooks.onUserInboxChange?.(req.authUser.id, patch.inboxDir);
    }
    if (chatModelChanged) {
      rebuildModelClients();
      await hooks.onModelChange?.();
    } else if (semanticIndexChanged) {
      rebuildEmbedder();
    }
    if (semanticIndexChanged) {
      // Re-index from scratch on the new model / address — fire-and-forget,
      // self-skips if the embedding model isn't reachable.
      void backfillEmbeddings(store, () => embedder);
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
      [`Voice-input model set to "${config.asrModel}"`, patch.asrModel !== undefined],
      [
        patch.embedModel
          ? `Semantic-search model set to "${patch.embedModel}"`
          : "Semantic-search model cleared",
        patch.embedModel !== undefined,
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
  // Give any pre-existing uploads still named after their doc id their real
  // filename on disk, so the documents folder is browsable. One-time, idempotent.
  await backfillOriginalDiskNames(store).catch((err) =>
    console.error("could not backfill document filenames:", (err as Error)?.message ?? err)
  );
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
      console.log(
        `tools server on http://127.0.0.1:${config.toolsPort}` +
          (resolveDenoPath() || supervisor.denoAvailable() ? " (Deno backend available)" : " (static tools only — Deno not found)")
      );
    } catch (err) {
      // The tools server is a secondary feature; the core API on config.port is
      // what every client actually needs to function. A stale process holding
      // config.toolsPort (e.g. an unclean shutdown of a previous run) used to
      // take the whole process down with process.exit(1) here — which showed up
      // as a permanently blank desktop window, since the app can never reach
      // agent-core. Degrade instead: log it and keep serving the API.
      console.error(
        `tools server could not start (${(err as Error).message ?? err}) — ` +
          `continuing without the Tools feature. Free the port and restart to re-enable it.`
      );
      toolsServer = undefined;
    }
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
      void warmModel(); // re-prime: the new model is cold and its prefix uncached
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

  // Load + prefill the planner prompt now so the first chat turn is fast.
  // Fire-and-forget — startup must not block on Ollama being reachable.
  void warmModel();

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
