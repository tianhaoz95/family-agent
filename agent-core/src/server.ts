import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import {
  Store,
  ScopedStore,
  AGENT_SENDER_ID,
  type UserRecord,
  type RoutineRecord,
  type ArtifactRecord,
} from "./db.js";
import { config, dbPath, envLocked, userInboxDir } from "./config.js";
import { webEnabled } from "./web/search.js";
import { sandboxAvailable } from "./shell/sandbox.js";
import { installedTools } from "./shell/executor.js";
import {
  listSkills,
  getSkill,
  saveSkill,
  setSkillEnabled,
  deleteSkill,
  isValidSkillName,
} from "./skills/skills.js";
import { skillScriptsRunnable } from "./skills/runScript.js";
import { generateSkillMarkdown } from "./agents/skillgen.js";
import { McpManager } from "./mcp/manager.js";
import {
  listMcpServers,
  upsertMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
  redactMcpServer,
  type McpServerConfig,
} from "./mcp/config.js";
import {
  RoutineScheduler,
  parseTriggerInput,
  nextRunAt,
  describeTrigger,
  type RoutineAction,
} from "./routines.js";
import {
  buildFamilyAgent,
  buildFamilyToolsAgent,
  buildFamilyTaskAgent,
  buildFamilyDocumentAgent,
  buildFamilyBuilderAgent,
  buildFamilyNotesAgent,
  buildFamilyRoutineAgent,
  buildFamilyResearchAgent,
  buildFamilyWorkshopAgent,
  buildFamilyCalcAgent,
  buildFamilySkillAgent,
  buildFamilyConnectionsAgent,
  buildFamilyVaultAgent,
  StepRecorder,
  type AgentStep,
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
import { lanAddrs } from "./lan.js";
import { warmCompute } from "./compute/run.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { persistSettings } from "./settingsFile.js";
import { getDesktopUpdateStatus, requestDesktopUpdate, reportDesktopUpdateStatus } from "./desktopUpdate.js";
import { verifyPassword, bearerToken } from "./auth.js";
import { wrapCard, type CardRecord, type RenderedCard } from "./cards/wrap.js";
import { wrapArtifact, toAnchor } from "./artifacts/wrap.js";
import { resolveArtifactComments } from "./artifacts/resolve.js";
import type { ReferenceHint } from "./agents/references.js";
import { VaultKeyring } from "./vault/keyring.js";
import {
  VaultService,
  VaultLockedError,
  VaultAccessError,
  VaultDisabledError,
} from "./vault/service.js";
import { rm, readFile, mkdir, writeFile as writeFileAsync } from "node:fs/promises";
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
import { synthesizeSpeech, listVoices } from "./tts.js";
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
  interface FastifyInstance {
    /** The scheduled-routines loop. Only .start()ed by main() (opts below). */
    routineScheduler: RoutineScheduler;
    /** Live MCP connections — main() drains these on shutdown. */
    mcpManager: McpManager;
    /** The password vault (crypto + in-memory unlock state). Tests drive it. */
    vault: VaultService;
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
const PUBLIC_ROUTES = new Set([
  "/health",
  "/_diag",
  "/auth/status",
  "/auth/login",
  "/auth/bootstrap",
  "/auth/pair/redeem",
]);

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
  supervisor: ToolSupervisor = new ToolSupervisor(),
  // main() passes { startRoutineScheduler: true } to run the live tick loop;
  // tests leave it off and drive app.routineScheduler by hand.
  opts: { startRoutineScheduler?: boolean } = {}
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
  const chatRefs = new Map<
    string,
    (
      | { type: "document" | "task" | "tool" | "artifact"; id: string }
      | { type: "link"; id: string; label: string }
    )[]
  >();
  // Generated HTML cards the model rendered this turn (render_card). One
  // collector array per in-flight turn, keyed by user (a set of them, so two
  // concurrent turns for one user can't stomp each other — same shape as the
  // vault-reveal collector). See docs/DECISIONS.md → "AI-generated HTML cards".
  const chatCards = new Map<string, Set<CardRecord[]>>();
  const addCardCollector = (userId: string, c: CardRecord[]) => {
    (chatCards.get(userId) ?? chatCards.set(userId, new Set()).get(userId)!).add(c);
  };
  const removeCardCollector = (userId: string, c: CardRecord[]) => {
    const set = chatCards.get(userId);
    set?.delete(c);
    if (set && set.size === 0) chatCards.delete(userId);
  };
  const cardDeps = (userId: string) => ({
    onCard: (card: CardRecord) => {
      for (const c of chatCards.get(userId) ?? []) c.push(card);
    },
    logActivity: (a: string, ac: string, d: string) => store.scoped(userId).logActivity(a, ac, d),
  });
  // `render_artifact` deps — persist the fragment straight to the user's store
  // and push an `artifact` reference so the reply carries a chip that opens it.
  const artifactDeps = (userId: string) => ({
    saveArtifact: ({ title, html }: { title: string; html: string }) => {
      const a = store.scoped(userId).createArtifact({ title, html, source: "chat" });
      return { id: a.id, title: a.title };
    },
    onReference: (ref: ReferenceHint) => chatRefs.get(userId)?.push(ref),
    logActivity: (a: string, ac: string, d: string) => store.scoped(userId).logActivity(a, ac, d),
  });
  // Live tool-call visibility: a turn's steps, keyed by a client-supplied
  // turnId (1:1 chat) or the pending agent message id (family channel). The
  // client polls GET /chat/turns/:id while the reply is in flight. Entries are
  // swept ~5 min after they finish. See docs/DECISIONS.md → "Tool-call visibility".
  interface TurnEntry {
    userId: string;
    steps: AgentStep[];
    done: boolean;
    finishedAt?: number;
  }
  const agentTurns = new Map<string, TurnEntry>();
  const startTurn = (turnId: string, userId: string): StepRecorder => {
    const entry: TurnEntry = { userId, steps: [], done: false };
    agentTurns.set(turnId, entry);
    return new StepRecorder((steps) => {
      entry.steps = steps;
    });
  };
  const finishTurn = (turnId: string): void => {
    const entry = agentTurns.get(turnId);
    if (entry) {
      entry.done = true;
      entry.finishedAt = Date.now();
    }
  };
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, e] of agentTurns) {
      if (e.done && (e.finishedAt ?? 0) < cutoff) agentTurns.delete(id);
    }
  }, 60_000).unref?.();

  const familyToolsDeps = (userId: string) => ({
    getCatalog: () => familyToolCatalog(userId),
    callOperation: (toolId: string, operation: string, args: Record<string, unknown>) =>
      callOperation(toolId, operation, args, supervisor),
  });

  // Web access — one `logActivity` closure per user for the research agent.
  const webDeps = (userId: string) =>
    webEnabled()
      ? { logActivity: (actor: string, action: string, detail: string) => store.scoped(userId).logActivity(actor, action, detail) }
      : undefined;

  // File-processing — probe the sandbox + installed tools once. Off unless
  // FAMILY_AGENT_SHELL=1 AND bubblewrap can actually sandbox here.
  const shellReady =
    config.shellEnabled &&
    (() => {
      const sb = sandboxAvailable();
      if (!sb.ok) {
        console.warn(`shell/file-processing requested but ${sb.reason} — the workshop agent is off`);
        return false;
      }
      if (installedTools().length === 0) {
        console.warn("shell/file-processing on, but no curated CLI tools are installed — the workshop agent is off");
        return false;
      }
      return true;
    })();

  // Drop a finished workspace file into a user's watched folder (the inbox
  // watcher then files it as a document).
  const saveWorkspaceToInbox = async (userId: string, filename: string, bytes: Buffer) => {
    const user = store.getUser(userId);
    if (!user) throw new Error("user not found");
    const dir = userInboxDir(user);
    await mkdir(dir, { recursive: true });
    await writeFileAsync(join(dir, filename.replace(/[/\\]/g, "_")), bytes);
  };

  // Promote a finished workspace file into the document store (same pipeline
  // as POST /documents/upload).
  const saveWorkspaceAsDocument = async (userId: string, filename: string, bytes: Buffer) => {
    const scoped = store.scoped(userId);
    let rawText = "";
    try {
      rawText = await extractText(filename, bytes);
    } catch {
      rawText = `(binary file "${filename}" — ${bytes.length} bytes; no text extracted)`;
    }
    const doc = scoped.createDocument({ filename, rawText: rawText || `(empty)` });
    try {
      const diskName = await storeOriginalUpload(userId, doc.filename, bytes);
      scoped.setDocumentOriginalDiskName(doc.id, diskName);
      scoped.setDocumentOriginalMime(doc.id, mimeFromFilename(filename));
    } catch {
      /* no preview — the document row is already saved */
    }
    void extractDocument(extractionModel, scoped, doc);
    void embedDocumentSafely(embedder, scoped, doc);
    return { id: doc.id, filename: doc.filename };
  };

  const shellDeps = (userId: string) =>
    shellReady
      ? {
          userId,
          store: store.scoped(userId),
          logActivity: (actor: string, action: string, detail: string) =>
            store.scoped(userId).logActivity(actor, action, detail),
          saveAsDocument: (filename: string, bytes: Buffer) => saveWorkspaceAsDocument(userId, filename, bytes),
          saveToInbox: (filename: string, bytes: Buffer) => saveWorkspaceToInbox(userId, filename, bytes),
        }
      : undefined;

  // Skills — leaf tools on the planner (list_skills / use_skill / run_skill_script).
  const skillsDeps = (userId: string) =>
    config.skillsEnabled
      ? { logActivity: (a: string, ac: string, d: string) => store.scoped(userId).logActivity(a, ac, d) }
      : undefined;

  // External MCP servers — one process-wide manager; a per-user deps closure
  // for the connections-agent subagent (scoped so a user only sees family +
  // their own connections).
  const mcpManager = new McpManager();
  const mcpDeps = (userId: string) =>
    mcpManager.enabled() && mcpManager.servers().some((s) => s.enabled)
      ? {
          userId,
          manager: mcpManager,
          logActivity: (a: string, ac: string, d: string) => store.scoped(userId).logActivity(a, ac, d),
        }
      : undefined;

  // ---- password vault ----
  // One keyring + service for the whole process (like ToolSupervisor /
  // RoutineScheduler / McpManager). The vault-agent is NOT a planner subagent
  // and is never reachable from a family channel — only the "/vault" forced
  // turn in private 1:1 chat. Secrets it hands back are collected per-turn in
  // `vaultReveals` so the chat route can redact them out of stored history.
  const vaultKeyring = new VaultKeyring(config.vaultIdleMs);
  const vault = new VaultService(store, vaultKeyring);
  app.decorate("vault", vault);
  // A vault-agent turn's revealed secrets, so the chat route can redact them
  // from the stored transcript. One collector Set per in-flight /chat request
  // (keyed by user, but a *set of* collectors) so two concurrent turns for the
  // same user can't stomp each other's — a reveal in any active turn is added
  // to every collector for that user (a no-op split/join for a turn whose
  // reply doesn't contain that string, safe).
  const vaultReveals = new Map<string, Set<Set<string>>>();
  const addRevealCollector = (userId: string, c: Set<string>) => {
    (vaultReveals.get(userId) ?? vaultReveals.set(userId, new Set()).get(userId)!).add(c);
  };
  const removeRevealCollector = (userId: string, c: Set<string>) => {
    const set = vaultReveals.get(userId);
    set?.delete(c);
    if (set && set.size === 0) vaultReveals.delete(userId);
  };
  const vaultAgents = makeAgentCache((userId) =>
    buildFamilyVaultAgent({
      vault,
      userId,
      onReveal: (secret) => {
        for (const c of vaultReveals.get(userId) ?? []) c.add(secret);
      },
    })
  );
  const vaultAgentFor = (userId: string) => vaultAgents.get(userId);

  const plannerAgents = makeAgentCache<FamilyAgent>((userId) =>
    buildFamilyAgent(store.scoped(userId), {
      startToolBuild: (p) => startToolBuild(userId, p),
      startToolIterate: (toolId, instruction) => startToolIterate(userId, toolId, instruction),
      listTools: () => toolsBrief(userId),
      onReference: (ref) => chatRefs.get(userId)?.push(ref),
      getEmbedder: () => embedder,
      familyTools: config.toolsEnabled ? familyToolsDeps(userId) : undefined,
      web: webDeps(userId),
      shell: shellDeps(userId),
      skills: skillsDeps(userId),
      mcp: mcpDeps(userId),
      cards: config.cardsEnabled ? cardDeps(userId) : undefined,
      artifacts: config.artifactsEnabled ? artifactDeps(userId) : undefined,
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
  const routineAgents = makeAgentCache((userId) => buildFamilyRoutineAgent(store.scoped(userId)));
  const researchAgents = makeAgentCache((userId) =>
    buildFamilyResearchAgent({
      logActivity: (a, ac, d) => store.scoped(userId).logActivity(a, ac, d),
      onReference: (ref) => chatRefs.get(userId)?.push(ref),
    })
  );
  const workshopAgents = makeAgentCache((userId) =>
    buildFamilyWorkshopAgent({ ...shellDeps(userId)!, onReference: (ref) => chatRefs.get(userId)?.push(ref) })
  );
  const calcAgents = makeAgentCache((userId) => buildFamilyCalcAgent(store.scoped(userId)));
  const skillAgents = makeAgentCache((userId) => buildFamilySkillAgent(skillsDeps(userId)!));
  const connectAgents = makeAgentCache((userId) => buildFamilyConnectionsAgent(mcpDeps(userId)!));

  // A tool build/improve/delete (or a model-client rebuild) invalidates every
  // one of the caches above in lockstep — miss one and a stale agent lingers.
  const dropAgents = (userId: string) => {
    plannerAgents.delete(userId);
    toolsAgents.delete(userId);
    taskAgents.delete(userId);
    documentAgents.delete(userId);
    builderAgents.delete(userId);
    notesAgents.delete(userId);
    routineAgents.delete(userId);
    researchAgents.delete(userId);
    workshopAgents.delete(userId);
    calcAgents.delete(userId);
    skillAgents.delete(userId);
    connectAgents.delete(userId);
    vaultAgents.delete(userId);
  };
  const dropAllAgents = () => {
    plannerAgents.clear();
    toolsAgents.clear();
    taskAgents.clear();
    documentAgents.clear();
    builderAgents.clear();
    notesAgents.clear();
    routineAgents.clear();
    researchAgents.clear();
    workshopAgents.clear();
    calcAgents.clear();
    skillAgents.clear();
    connectAgents.clear();
    vaultAgents.clear();
  };
  const agentFor = (userId: string) => plannerAgents.get(userId);
  const toolsAgentFor = (userId: string) => toolsAgents.get(userId);
  const taskAgentFor = (userId: string) => taskAgents.get(userId);
  const documentAgentFor = (userId: string) => documentAgents.get(userId);
  const builderAgentFor = (userId: string) => builderAgents.get(userId);
  const notesAgentFor = (userId: string) => notesAgents.get(userId);
  const routineAgentFor = (userId: string) => routineAgents.get(userId);
  const researchAgentFor = (userId: string) => researchAgents.get(userId);
  const workshopAgentFor = (userId: string) => workshopAgents.get(userId);
  const calcAgentFor = (userId: string) => calcAgents.get(userId);
  const skillAgentFor = (userId: string) => skillAgents.get(userId);
  const connectAgentFor = (userId: string) => connectAgents.get(userId);
  // Resolve collected hints to {type, id, label}, deduped and capped.
  const resolveReferences = (userStore: ScopedStore, userId: string) => {
    const collected = chatRefs.get(userId) ?? [];
    chatRefs.delete(userId);
    const seen = new Set<string>();
    const out: { type: "document" | "task" | "tool" | "link" | "artifact"; id: string; label: string }[] = [];
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
      } else if (r.type === "artifact") {
        const a = userStore.getArtifact(r.id);
        if (a) out.push({ type: "artifact", id: r.id, label: a.title });
      } else if (r.type === "link") {
        // A web page the research agent opened — id is the URL, label the title.
        out.push({ type: "link", id: r.id, label: r.label || r.id });
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

  // ---- scheduled routines ----
  // The scheduler runs a routine's instruction through the same per-user agent
  // caches a chat turn uses. "planner" is the full assistant; the others are
  // one scoped-down specialist. "builder" is not reachable — a routine never
  // generates or rewrites code unattended.
  const runRoutineAction = async (userId: string, action: RoutineAction): Promise<string> => {
    let agent: InvokableAgent;
    switch (action.agent) {
      case "task":
        agent = taskAgentFor(userId);
        break;
      case "document":
        agent = documentAgentFor(userId);
        break;
      case "notes":
        agent = notesAgentFor(userId);
        break;
      case "tools":
        if (!config.toolsEnabled) return "The Tools feature is turned off on this server.";
        agent = toolsAgentFor(userId);
        break;
      case "research":
        if (!webEnabled()) return "Web access is turned off on this server.";
        agent = researchAgentFor(userId);
        break;
      case "connect":
        if (!mcpHasServers()) return "No external services are connected on this server.";
        agent = connectAgentFor(userId);
        break;
      default:
        agent = agentFor(userId);
    }
    const instruction =
      action.agent === "planner"
        ? `${action.instruction}\n\n(This is an automated scheduled run with no one to answer follow-up questions — carry out the task and report the result concisely.)`
        : action.instruction;
    return askFamilyAgent(agent, instruction);
  };

  // ---- forced "/" agent turns (shared by 1:1 chat and family channels) ----
  // A leading "/" skips the planner's own (unreliable, on a small model)
  // delegation decision and runs one specialist directly. Used by POST /chat
  // and POST /channels/:id/messages so the assistant behaves the same whether
  // you talk to it privately or @-mention it in a conversation.
  const forcedAgentFor: Record<ForcedAgentKind, (userId: string) => InvokableAgent> = {
    tools: toolsAgentFor,
    task: taskAgentFor,
    document: documentAgentFor,
    builder: builderAgentFor,
    notes: notesAgentFor,
    routine: routineAgentFor,
    research: researchAgentFor,
    workshop: workshopAgentFor,
    calc: calcAgentFor,
    skill: skillAgentFor,
    connect: connectAgentFor,
    vault: vaultAgentFor,
  };
  const forcedFallback: Record<ForcedAgentKind, string> = {
    tools: "What can you do?",
    task: "List my tasks.",
    document: "What documents do I have?",
    builder: "What tools do we have, and what can be built?",
    notes: "What's on the sticky notes?",
    routine: "List my scheduled routines.",
    research: "What can you look up for me?",
    workshop: "What files can you help me process?",
    calc: "What can you calculate for me?",
    skill: "What skills do we have?",
    connect: "What connected services can you use?",
    vault: "List the vault entries I have.",
  };
  const mcpHasServers = () => mcpManager.enabled() && mcpManager.servers().some((s) => s.enabled);
  const forcedKindOffReason = (kind: ForcedAgentKind): string | null => {
    if (kind === "tools" && !config.toolsEnabled) return "Tools aren't turned on for this server.";
    if (kind === "research" && !webEnabled()) return "Web access isn't turned on for this server.";
    if (kind === "workshop" && !shellReady) return "File processing isn't turned on for this server.";
    if (kind === "calc" && !config.computeEnabled) return "The calculator is turned off on this server.";
    if (kind === "skill" && !config.skillsEnabled) return "Skills are turned off on this server.";
    if (kind === "connect" && !mcpHasServers())
      return "No external services are connected on this server.";
    if (kind === "vault") {
      if (!config.vaultEnabled) return "The password vault isn't turned on for this server.";
      if (!vault.aiEnabled)
        return "The assistant isn't allowed to read the password vault on this server.";
    }
    return null;
  };

  /** Run a "/" forced command. `message` is the raw text (already known to
   *  start with "/"); returns the assistant's reply. `inChannel` is true for a
   *  family-channel turn — the vault is private-chat only and refuses there. */
  const runForcedAgentTurn = async (
    userId: string,
    forced: { kind: ForcedAgentKind; text: string },
    images: string[],
    history: { role: "user" | "assistant"; content: string }[],
    inChannel = false,
    recorder?: StepRecorder
  ): Promise<string> => {
    if (forced.kind === "vault" && inChannel) {
      return "The password vault is only available in a private chat with the assistant, not in a family conversation.";
    }
    const off = forcedKindOffReason(forced.kind);
    if (off) return off;
    const agent = forcedAgentFor[forced.kind](userId);
    // Never record steps for a vault lookup — a step's output would carry the
    // password / 2FA code, defeating the transcript redaction.
    const rec = forced.kind === "vault" ? undefined : recorder;
    return askFamilyAgent(agent, forced.text || forcedFallback[forced.kind], images, history, rec);
  };

  const routineScheduler = new RoutineScheduler(store, {
    runAction: runRoutineAction,
    tickMs: config.routineTickMs,
    catchUpGraceMs: config.routineCatchUpGraceMs,
  });
  app.decorate("routineScheduler", routineScheduler);
  app.decorate("mcpManager", mcpManager);
  if (opts.startRoutineScheduler && config.routinesEnabled) routineScheduler.start();

  /** 404 body for a routine route when the feature is disabled server-wide. */
  const routinesOff = (reply: FastifyReply) =>
    reply.code(404).send({ error: "Scheduled routines are turned off on this server." });

  const routineView = (r: RoutineRecord) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    triggerText: describeTrigger(r.trigger),
    action: r.action,
    deliverChannelId: r.deliverChannelId,
    catchUp: r.catchUp,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastStatus: r.lastStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  // Rows left mid-flight by a previous run will never finish on their own —
  // mark them failed so the UI offers a retry instead of a stuck spinner.
  store.failStalePendingExtractions();
  store.failStaleBuildingTools();
  store.failStalePendingMessages();
  store.failStaleRoutineRuns();
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
  app.get("/health", async () => {
    // This machine's reachable base URLs — the desktop "Pair a phone" panel
    // shows a QR of the first so a phone can scan its way in without mDNS.
    // `lanAddrs` carries the kind (tailscale / lan / other); `lanUrls` is the
    // plain ordered list kept for older clients.
    const addrs = lanAddrs(config.port);
    return {
    ok: true,
    model: config.model,
    ollamaBaseUrl: config.ollamaBaseUrl,
    serverName: config.serverName,
    lanUrls: addrs.map((a) => a.url),
    lanAddrs: addrs,
    // The desktop shows a first-run setup wizard when this is true.
    needsSetup: store.countUsers() === 0,
    toolsPort: config.toolsPort,
    toolsEnabled: config.toolsEnabled && supervisor.denoAvailable() ? "full" : config.toolsEnabled ? "static-only" : "off",
    // Both chat UIs hide the mic button when this is false.
    asrEnabled: config.asrEnabled,
    // Both chat UIs hide the "read aloud" button when this is false.
    ttsEnabled: config.ttsEnabled,
    // "on" once a model is configured; actual reachability is checked lazily
    // and search falls back to keyword + fuzzy if it's down.
    semanticSearch: embeddingsEnabled() ? "on" : "off",
    // Both clients hide the Routines screen when this is false.
    routinesEnabled: config.routinesEnabled,
    // "on" when an admin has configured a web search provider.
    web: webEnabled() ? "on" : "off",
    // "on" when file processing is enabled AND the sandbox works here.
    shell: shellReady ? "on" : config.shellEnabled ? "unavailable" : "off",
    // The stateless code sandbox (run_code). On by default — it's a pure function.
    compute: config.computeEnabled,
    // Family skills (playbooks). On by default; "scripts" true when skill
    // helper scripts can also run (needs the bubblewrap sandbox).
    skills: config.skillsEnabled ? (skillScriptsRunnable().ok ? "full" : "docs-only") : "off",
    // External MCP connections. "on" only when enabled AND at least one server.
    mcp: mcpManager.enabled() ? (mcpHasServers() ? "on" : "no-servers") : "off",
    // Password vault. "on" when FAMILY_AGENT_VAULT=1; both clients show/hide
    // the Vault screen off this. `vaultAi` = whether "/vault" chat lookups work.
    vault: config.vaultEnabled ? "on" : "off",
    vaultAi: vault.aiEnabled,
    // AI-generated HTML cards (render_card). Admin-toggleable in Settings;
    // clients hide the card render path when "off".
    cards: config.cardsEnabled ? "on" : "off",
    // AI-generated full-page artifacts (render_artifact + the Artifacts tab).
    // Clients hide the tab and the open-artifact chip when "off".
    artifacts: config.artifactsEnabled ? "on" : "off",
    };
  });

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
    // Best-effort: unlock this user's vault for the session (no-op if the vault
    // feature is off or they haven't set one up). After an admin password
    // reset the KEK won't fit — the vault then stays locked until they unlock
    // it explicitly or use their recovery code.
    if (config.vaultEnabled) vault.autoUnlock(user.id, password);
    return { token, user: publicUser(user) };
  });

  app.post("/auth/logout", async (req) => {
    const token = bearerToken(req.headers.authorization);
    if (token) store.deleteSession(token);
    if (req.authUser) vault.lock(req.authUser.id);
    return { ok: true };
  });

  // ---- phone pairing (QR auto sign-in) ----
  // The desktop "Pair a phone" panel can bake a token into its QR so a phone
  // signs straight into the scanning-desktop's own account, no password. The
  // token is bound to req.authUser, single-use, and expires in minutes — a
  // stale photo of the QR is worthless. Authed route: only a signed-in desktop
  // can mint one, and only for itself.
  app.post("/auth/pair/start", async (req) => {
    const { token, expiresAt } = store.createPairingToken(req.authUser.id);
    return { token, expiresAt };
  });

  const PairRedeemBody = z.object({
    token: z.string().min(1),
    deviceLabel: z.string().trim().max(80).optional(),
  });
  app.post("/auth/pair/redeem", async (req, reply) => {
    const parsed = PairRedeemBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const user = store.redeemPairingToken(parsed.data.token);
    if (!user) {
      return reply
        .code(401)
        .send({ error: "This pairing code has expired or was already used — generate a new one on the computer." });
    }
    const { token } = store.createSession(user.id, parsed.data.deviceLabel ?? "Paired phone");
    // No vault auto-unlock: pairing carries no password (same as after an admin
    // password reset — the vault stays locked until the user unlocks it).
    return { token, user: publicUser(user) };
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
    if (patch.password !== undefined && !isSelf) {
      store.deleteSessionsForUser(id);
      // Their vault can't be re-wrapped without their old password or an
      // unlocked session — it stays encrypted under the old key until they
      // sign in and use their recovery code.
      vault.lock(id);
    }
    // Self-service password change: re-wrap the vault under the new password
    // if it's currently unlocked (otherwise the recovery code is the way back).
    if (patch.password !== undefined && isSelf && config.vaultEnabled) {
      const rewrapped = vault.rewrapForNewPassword(id, patch.password);
      if (!rewrapped && vault.status(id).exists) {
        req.userStore.logActivity(
          "system",
          "vault.locked",
          "Password changed while the vault was locked — unlock it with your recovery code, then it re-secures under the new password"
        );
      }
    }
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
    vaultKeyring.lock(id);
    store.scoped(req.authUser.id).logActivity("user", "user.deleted", `Deleted account "${target.username}"`);
    await hooks.onUserDeleted?.(id);
    return { deleted: true };
  });

  // Replace any secret string the vault-agent revealed this turn with a
  // placeholder, so it isn't written into chat_messages / replayed as history.
  const redactSecrets = (text: string, secrets: Set<string> | undefined): string => {
    if (!secrets || secrets.size === 0) return text;
    let out = text;
    for (const s of secrets) {
      if (!s || s.length < 3) continue;
      out = out.split(s).join("‹hidden — open the Vault to see it›");
    }
    return out;
  };

  // ---- chat ----
  // A "session" is this user's own persisted conversation with the assistant
  // (chat_sessions/chat_messages, ScopedStore — not the cross-account
  // channels/messages behind family chat). POST /chat lazily creates one on
  // the first turn (no sessionId in the body) and hands its id back; the
  // client holds onto it for the rest of that conversation.
  const ChatBody = z.object({
    message: z.string().min(1),
    images: z.array(z.string().regex(/^data:image\/[a-z+.-]+;base64,/i)).max(4).optional(),
    /** Ids of documents attached to this turn (uploaded via /documents/upload
     *  by the composer). Their extracted text is prepended to the model's copy
     *  of the message so the assistant can actually read a PDF/scan/doc. */
    documentIds: z.array(z.string().min(1)).max(5).optional(),
    sessionId: z.string().min(1).optional(),
    /** Client-generated id so it can poll GET /chat/turns/:turnId for live
     *  tool-call visibility while this request is in flight. */
    turnId: z.string().min(1).max(80).optional(),
  });
  app.post("/chat", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { message, images = [], documentIds = [], sessionId, turnId } = parsed.data;

    let session = sessionId ? req.userStore.getChatSession(sessionId) : undefined;
    if (sessionId && !session) return reply.code(404).send({ error: "No such chat session." });
    if (!session) session = req.userStore.createChatSession(message);

    // Attached documents: pull each one's extracted text and build the block
    // the model actually sees. The stored transcript keeps the user's original
    // wording plus a short "[+N document(s)]" note (same shape as images).
    const attachedDocs = documentIds
      .map((id) => req.userStore.getDocument(id))
      .filter((d): d is NonNullable<typeof d> => !!d);
    const PER_DOC_CHARS = 8000;
    const docBlock = attachedDocs.length
      ? "The user attached the following document(s) to this message — use them to answer:\n\n" +
        attachedDocs
          .map((d) => {
            const body = (d.rawText || "").trim();
            const clipped = body.length > PER_DOC_CHARS ? body.slice(0, PER_DOC_CHARS) + "\n…(truncated)" : body;
            return `===== ${d.filename} =====\n${clipped || "(no readable text was extracted)"}\n===== end of ${d.filename} =====`;
          })
          .join("\n\n") +
        "\n\n"
      : "";
    const modelMessage = docBlock + message;

    // Prior turns of this session, as context for the model — captured before
    // this turn's own message is stored, so it isn't echoed back to itself.
    const priorMessages = req.userStore.listChatMessages(session.id).slice(-20);
    req.userStore.addChatMessage(session.id, "user", message, images);
    const attachNote = [
      images.length ? `+${images.length} image${images.length > 1 ? "s" : ""}` : "",
      attachedDocs.length ? `+${attachedDocs.length} document${attachedDocs.length > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    req.userStore.logActivity("user", "chat.message", attachNote ? `${message}  [${attachNote}]` : message);
    const revealCollector = new Set<string>();
    const cardCollector: CardRecord[] = [];
    const recorder = turnId ? startTurn(turnId, req.authUser.id) : undefined;
    try {
      chatRefs.set(req.authUser.id, []);
      addRevealCollector(req.authUser.id, revealCollector);
      addCardCollector(req.authUser.id, cardCollector);
      const history = priorMessages.map((m) => ({ role: m.role, content: m.body }));
      // Attached documents show up as chips under the reply, like a retrieval hit.
      for (const d of attachedDocs) chatRefs.get(req.authUser.id)?.push({ type: "document", id: d.id });
      // A leading "/" (typed by hand, or via the client's command/tool
      // autocomplete) skips the planner's own delegation decision — unreliable
      // on a small model — and runs one specialist agent directly.
      const forced = parseForcedAgentCommand(message);
      if (forced && docBlock) forced.text = docBlock + forced.text;
      const responseText = forced
        ? await runForcedAgentTurn(req.authUser.id, forced, images, history, false, recorder)
        : await askFamilyAgent(agentFor(req.authUser.id), modelMessage, images, history, recorder);
      const references = resolveReferences(req.userStore, req.authUser.id);
      const steps = recorder?.steps ?? [];
      if (turnId) finishTurn(turnId);
      // A "/vault" turn may put a real password or 2FA code in `responseText`.
      // The live reply keeps it; the copy written to chat_messages (and later
      // replayed as history) has it redacted — a secret must not linger in a
      // persisted transcript. See docs/DECISIONS.md → "Password vault".
      removeRevealCollector(req.authUser.id, revealCollector);
      removeCardCollector(req.authUser.id, cardCollector);
      const storedText = redactSecrets(responseText, revealCollector);
      const cards = cardCollector.slice(0, 2); // cap per reply
      req.userStore.addChatMessage(session.id, "assistant", storedText, [], references, steps, cards);
      req.userStore.logActivity(
        "family-planner",
        "chat.reply",
        storedText === responseText ? responseText : "(a vault lookup — the answer isn't stored)"
      );
      return {
        reply: responseText,
        references,
        steps,
        cards: cards.map(wrapCard),
        sessionId: session.id,
      };
    } catch (err) {
      chatRefs.delete(req.authUser.id);
      removeRevealCollector(req.authUser.id, revealCollector);
      removeCardCollector(req.authUser.id, cardCollector);
      if (turnId) finishTurn(turnId);
      req.log?.error?.(err);
      const detail = err instanceof Error ? err.message : String(err);
      // Only blame Ollama when the failure actually looks like a connection /
      // model problem — otherwise the message misdirects (a bug in a tool, a
      // bad delegation, an out-of-memory in the sandbox, …).
      const looksLikeModel =
        /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|ollama|model|not found.*pull|load model|status (?:5\d\d|429)|aborted|timeout/i.test(
          detail
        );
      return reply.code(502).send({
        error: looksLikeModel
          ? "The local model could not be reached. Is Ollama running with the configured model pulled?"
          : "The assistant hit an error on that request. Try rephrasing, or check /activity for what it attempted.",
        detail,
      });
    }
  });

  // Live tool-call visibility: the client polls this while a /chat request (or
  // a family-channel @agent reply) is in flight, passing the turnId it sent /
  // the pending message id. Returns whatever tool calls have run so far.
  app.get("/chat/turns/:turnId", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const entry = agentTurns.get(turnId);
    if (!entry || entry.userId !== req.authUser.id) {
      return reply.code(404).send({ error: "No such turn.", steps: [], done: true });
    }
    return { steps: entry.steps, done: entry.done };
  });

  // Stored messages carry only the card *fragment* (small); wrap each into the
  // full sandboxed document the clients render, at read time — so the wrapper
  // (CSP, house style, runtime) can change without re-storing old cards.
  const withRenderedCards = <T extends { cards: CardRecord[] }>(m: T): Omit<T, "cards"> & { cards: RenderedCard[] } => ({
    ...m,
    cards: m.cards.map(wrapCard),
  });

  app.get("/chat/sessions", async (req) => ({ sessions: req.userStore.listChatSessions() }));

  app.get("/chat/sessions/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!req.userStore.getChatSession(id)) return reply.code(404).send({ error: "No such chat session." });
    return { messages: req.userStore.listChatMessages(id).map(withRenderedCards) };
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

  // ---- voice output ----
  // Read an assistant reply aloud. Body { text, voice? } → an audio/wav
  // response. Kokoro runs in-process (tts.ts) and never touches the planner.
  // The first call downloads the model (~86 MB) so it can take ~20 s; every
  // one after is a couple of seconds on CPU.
  app.post("/speak", async (req, reply) => {
    if (!config.ttsEnabled) {
      return reply.code(403).send({ error: "Voice output is turned off on this server." });
    }
    const parsed = z
      .object({ text: z.string().min(1).max(20_000), voice: z.string().trim().max(40).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      const wav = await synthesizeSpeech(parsed.data.text, parsed.data.voice);
      reply.header("content-type", "audio/wav");
      reply.header("cache-control", "no-store");
      return reply.send(wav);
    } catch (err) {
      req.log?.error?.(err);
      return reply.code(502).send({
        error: "Could not synthesize speech.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // The voice ids the loaded TTS model offers — for the Settings dropdown.
  // Empty until the model has loaded once (first /speak).
  app.get("/tts/voices", async (_req, reply) => {
    if (!config.ttsEnabled) return reply.code(403).send({ error: "Voice output is turned off on this server." });
    return { voices: await listVoices(), current: config.ttsVoice };
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

  // ---- skills ----
  // A skill is a folder of instructions (+ optional sandboxed scripts) the
  // family teaches the agent. Read for any user, write for admins.
  const skillsOff = (reply: FastifyReply) =>
    reply.code(404).send({ error: "Skills are turned off on this server." });

  app.get("/skills", async (_req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    return {
      skills: listSkills().map((s) => ({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse ?? null,
        enabled: s.enabled,
        scripts: s.scripts,
        updatedAt: s.updatedAt,
      })),
      scriptsRunnable: skillScriptsRunnable().ok,
    };
  });

  app.get("/skills/:name", async (req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    const s = getSkill((req.params as { name: string }).name);
    if (!s) return reply.code(404).send({ error: "skill not found" });
    return { skill: s };
  });

  const SkillBody = z.object({
    name: z.string().trim().min(1).max(48),
    description: z.string().trim().max(300).optional(),
    whenToUse: z.string().trim().max(300).optional(),
    enabled: z.boolean().optional(),
    markdown: z.string().min(1).max(20_000),
  });
  app.post("/skills", { preHandler: requireAdmin }, async (req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    const parsed = SkillBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    if (!isValidSkillName(parsed.data.name.toLowerCase())) {
      return reply.code(400).send({ error: "Skill name: lowercase letters, digits and hyphens only." });
    }
    try {
      const s = saveSkill({ ...parsed.data, name: parsed.data.name.toLowerCase() });
      req.userStore.logActivity("skills", "skill.saved", `Saved the "${s.name}" skill`);
      return reply.code(201).send({ skill: s });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/skills/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    const { name } = req.params as { name: string };
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const s = setSkillEnabled(name, parsed.data.enabled);
    if (!s) return reply.code(404).send({ error: "skill not found" });
    dropAllAgents(); // the planner prompt / tool set doesn't change, but be safe
    return { skill: s };
  });

  app.delete("/skills/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    const { name } = req.params as { name: string };
    if (!deleteSkill(name)) return reply.code(404).send({ error: "skill not found" });
    req.userStore.logActivity("skills", "skill.deleted", `Deleted the "${name}" skill`);
    return { deleted: true };
  });

  // Draft a SKILL.md from a description — one model call, result is returned for
  // the user to review/edit before POSTing it.
  app.post("/skills/draft", { preHandler: requireAdmin }, async (req, reply) => {
    if (!config.skillsEnabled) return skillsOff(reply);
    const parsed = z
      .object({ name: z.string().trim().min(1).max(48), description: z.string().trim().min(3).max(600) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const md = await generateSkillMarkdown(extractionModel, parsed.data);
    if (!md) return reply.code(502).send({ error: "The model didn't produce a usable draft — try again or write it yourself." });
    return { markdown: md };
  });

  // ---- MCP connections (admin) ----
  const mcpOff = (reply: FastifyReply) =>
    reply.code(404).send({ error: "MCP connections are turned off on this server (FAMILY_AGENT_MCP=1)." });

  app.get("/mcp/servers", { preHandler: requireAdmin }, async (_req, reply) => {
    if (!mcpManager.enabled()) return mcpOff(reply);
    return { servers: listMcpServers().map(redactMcpServer) };
  });

  const McpServerBody = z.object({
    name: z.string().trim().min(1).max(48),
    transport: z.enum(["http", "stdio"]),
    enabled: z.boolean().optional(),
    url: z.string().trim().max(400).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().trim().max(200).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    allowHosts: z.array(z.string()).optional(),
    scope: z.string().trim().max(48).optional(),
    note: z.string().trim().max(300).optional(),
  });
  app.post("/mcp/servers", { preHandler: requireAdmin }, async (req, reply) => {
    if (!mcpManager.enabled()) return mcpOff(reply);
    const parsed = McpServerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      const saved = upsertMcpServer({ ...parsed.data, enabled: parsed.data.enabled ?? true } as McpServerConfig);
      mcpManager.invalidate(saved.name);
      req.userStore.logActivity("connections-agent", "mcp.server.saved", `Configured MCP server "${saved.name}"`);
      const probe = saved.enabled ? await mcpManager.probe(saved.name) : { ok: true, toolCount: 0 };
      return reply.code(201).send({ server: redactMcpServer(saved), probe });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch("/mcp/servers/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!mcpManager.enabled()) return mcpOff(reply);
    const { name } = req.params as { name: string };
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const s = setMcpServerEnabled(name, parsed.data.enabled);
    if (!s) return reply.code(404).send({ error: "server not found" });
    mcpManager.invalidate(name);
    dropAllAgents();
    return { server: redactMcpServer(s) };
  });

  app.delete("/mcp/servers/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!mcpManager.enabled()) return mcpOff(reply);
    const { name } = req.params as { name: string };
    if (!deleteMcpServer(name)) return reply.code(404).send({ error: "server not found" });
    mcpManager.invalidate(name);
    dropAllAgents();
    req.userStore.logActivity("connections-agent", "mcp.server.deleted", `Removed MCP server "${name}"`);
    return { deleted: true };
  });

  app.post("/mcp/servers/:name/probe", { preHandler: requireAdmin }, async (req, reply) => {
    if (!mcpManager.enabled()) return mcpOff(reply);
    return mcpManager.probe((req.params as { name: string }).name);
  });

  // The tools every connected server exposes to THIS user — for the UI.
  app.get("/mcp/tools", async (req) => {
    if (!mcpManager.enabled()) return { tools: [] };
    const tools = await mcpManager.toolsForUser(req.authUser.id);
    return { tools: tools.map((t) => ({ server: t.server, name: t.tool.name, description: t.tool.description ?? "" })) };
  });

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
    return {
      messages: store.listMessages(id, req.authUser.id, { afterTs: after || null }).map(withRenderedCards),
    };
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

    // The assistant chimes in on an @agent mention OR a leading "/" command —
    // same triggers as the 1:1 chat, so it behaves the same wherever you talk
    // to it. A "/" command runs one specialist directly (no planner routing).
    const forced = parseForcedAgentCommand(body);
    if (parsed.data.mentionAgent || mentionsAgent(body) || forced) {
      const pending = store.insertPendingAgentMessage(id);
      // The pending message id doubles as the turnId — clients poll
      // GET /chat/turns/:id for live tool-call visibility until it resolves.
      const recorder = startTurn(pending.id, req.authUser.id);
      const cardCollector: CardRecord[] = [];
      addCardCollector(req.authUser.id, cardCollector);
      // Fire-and-forget: the client polls for the pending row to fill in.
      void (async () => {
        try {
          let replyText: string;
          if (forced) {
            replyText = await runForcedAgentTurn(req.authUser.id, forced, images, [], true, recorder);
          } else {
            const recent = store.listMessages(id, req.authUser.id, { limit: 20 });
            const nameFor = (senderId: string) =>
              senderId === AGENT_SENDER_ID
                ? "Assistant"
                : store.getUser(senderId)?.displayName ?? "Someone";
            const transcript = recent
              .filter((m) => !m.pending)
              .map((m) => `${nameFor(m.senderId)}: ${m.body}`)
              .join("\n");
            replyText = await askFamilyAgentInChannel(agentFor(req.authUser.id), transcript, body, images, recorder);
          }
          finishTurn(pending.id);
          removeCardCollector(req.authUser.id, cardCollector);
          store.resolvePendingAgentMessage(pending.id, replyText, recorder.steps, cardCollector.slice(0, 2));
          store.scoped(req.authUser.id).logActivity("family-planner", "chat.reply", replyText);
        } catch (err) {
          console.error("in-channel agent reply failed:", err);
          finishTurn(pending.id);
          removeCardCollector(req.authUser.id, cardCollector);
          store.resolvePendingAgentMessage(
            pending.id,
            "Sorry — I couldn't reach the local model just now.",
            recorder.steps
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

  // ---- password vault ----
  // Metadata (title/username/url) is stored plaintext; the secret is AES-GCM
  // encrypted under a key held only in memory while the user is unlocked. See
  // agent-core/src/vault/ and docs/DECISIONS.md → "Password vault".

  /** Map a VaultService throw to the right HTTP status. */
  const vaultErr = (reply: FastifyReply, err: unknown) => {
    if (err instanceof VaultDisabledError) return reply.code(404).send({ error: err.message });
    if (err instanceof VaultLockedError) return reply.code(423).send({ error: err.message, locked: true });
    if (err instanceof VaultAccessError) return reply.code(403).send({ error: err.message });
    app.log?.error?.(err);
    return reply.code(500).send({ error: (err as Error)?.message ?? "Vault error." });
  };

  /** 404 unless the vault feature is on — mirrors routineDisabled(). */
  const vaultGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.vaultEnabled) {
      return reply.code(404).send({ error: "The password vault isn't turned on for this server." });
    }
  };

  const userPasswordOk = (userId: string, password: string): boolean => {
    const hash = store.getPasswordHash(userId);
    return !!hash && verifyPassword(password, hash);
  };

  // Status is safe to call even when the feature is off (clients use it to
  // decide whether to show the Vault screen at all).
  app.get("/vault/status", async (req) => vault.status(req.authUser.id));

  const VaultPasswordBody = z.object({ password: z.string().min(1) });

  app.post("/vault/setup", { preHandler: vaultGuard }, async (req, reply) => {
    const parsed = VaultPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    if (!userPasswordOk(req.authUser.id, parsed.data.password)) {
      return reply.code(401).send({ error: "That's not your account password." });
    }
    if (vault.status(req.authUser.id).exists) {
      return reply.code(409).send({ error: "Your vault is already set up." });
    }
    try {
      const { recoveryCode } = vault.provision(req.authUser.id, parsed.data.password);
      // Opportunistically hand the new member the shared family key if an admin
      // is unlocked right now.
      for (const admin of store.listUsers().filter((u) => u.role === "admin")) {
        if (vaultKeyring.isUnlocked(admin.id)) {
          try {
            vault.syncFamilyKeys(admin.id);
          } catch {
            /* not fatal */
          }
          break;
        }
      }
      req.userStore.logActivity("user", "vault.setup", "Set up the password vault");
      return { ok: true, recoveryCode, status: vault.status(req.authUser.id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  app.post("/vault/unlock", { preHandler: vaultGuard }, async (req, reply) => {
    const parsed = VaultPasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      const r = vault.unlock(req.authUser.id, parsed.data.password);
      if (!r.ok) {
        return reply
          .code(r.reason === "not-set-up" ? 409 : 401)
          .send({ error: r.reason === "not-set-up" ? "Your vault isn't set up yet." : "Wrong password." });
      }
      return { ok: true, status: vault.status(req.authUser.id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  app.post("/vault/lock", { preHandler: vaultGuard }, async (req) => {
    vault.lock(req.authUser.id);
    return { ok: true, status: vault.status(req.authUser.id) };
  });

  const VaultRecoverBody = z.object({
    recoveryCode: z.string().min(1),
    password: z.string().min(1),
  });
  app.post("/vault/recover", { preHandler: vaultGuard }, async (req, reply) => {
    const parsed = VaultRecoverBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    if (!userPasswordOk(req.authUser.id, parsed.data.password)) {
      return reply.code(401).send({ error: "That's not your current account password." });
    }
    try {
      const r = vault.recover(req.authUser.id, parsed.data.recoveryCode, parsed.data.password);
      if (!r.ok) {
        return reply
          .code(r.reason === "no-recovery" ? 409 : 401)
          .send({ error: r.reason === "no-recovery" ? "This vault has no recovery code on file." : "That recovery code isn't right." });
      }
      return { ok: true, recoveryCode: r.recoveryCode, status: vault.status(req.authUser.id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  app.post("/vault/family/sync", { preHandler: [requireAdmin, vaultGuard] }, async (req, reply) => {
    try {
      const granted = vault.syncFamilyKeys(req.authUser.id);
      req.userStore.logActivity("user", "vault.family.sync", `Granted shared-vault access to ${granted} member(s)`);
      return { ok: true, granted };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  app.get("/vault/entries", { preHandler: vaultGuard }, async (req, reply) => {
    try {
      return { entries: vault.listEntries(req.authUser.id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  const VaultFieldsSchema = z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        value: z.string().max(4000),
        secret: z.boolean().optional(),
      })
    )
    .max(20)
    .optional();
  const CreateVaultEntryBody = z.object({
    scope: z.enum(["private", "shared"]).default("private"),
    folder: z.string().trim().max(80).nullish(),
    title: z.string().trim().min(1).max(160),
    username: z.string().trim().max(320).nullish(),
    url: z.string().trim().max(2000).nullish(),
    password: z.string().max(4000).nullish(),
    totpInput: z.string().trim().max(4000).nullish(),
    notes: z.string().max(8000).nullish(),
    fields: VaultFieldsSchema,
  });
  app.post("/vault/entries", { preHandler: vaultGuard }, async (req, reply) => {
    const parsed = CreateVaultEntryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      return { entry: vault.createEntry(req.authUser.id, parsed.data) };
    } catch (err) {
      if (err instanceof Error && /base32|otpauth|two-factor/i.test(err.message)) {
        return reply.code(400).send({ error: err.message });
      }
      return vaultErr(reply, err);
    }
  });

  app.get("/vault/entries/:id", { preHandler: vaultGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { entry: vault.getEntry(req.authUser.id, id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  const UpdateVaultEntryBody = z
    .object({
      folder: z.string().trim().max(80).nullish(),
      title: z.string().trim().min(1).max(160).optional(),
      username: z.string().trim().max(320).nullish(),
      url: z.string().trim().max(2000).nullish(),
      password: z.string().max(4000).nullish(),
      totpInput: z.string().trim().max(4000).nullish(),
      clearTotp: z.boolean().optional(),
      notes: z.string().max(8000).nullish(),
      fields: VaultFieldsSchema,
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to update." });
  app.patch("/vault/entries/:id", { preHandler: vaultGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateVaultEntryBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    try {
      return { entry: vault.updateEntry(req.authUser.id, id, parsed.data) };
    } catch (err) {
      if (err instanceof Error && /base32|otpauth|two-factor/i.test(err.message)) {
        return reply.code(400).send({ error: err.message });
      }
      return vaultErr(reply, err);
    }
  });

  app.delete("/vault/entries/:id", { preHandler: vaultGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { deleted: true, entry: vault.deleteEntry(req.authUser.id, id) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  // The current TOTP code for an entry — the Vault screen polls this once a
  // second to show the ticking code, so `actor: "user"` reads are NOT written
  // to the access log (only the assistant's get_totp_code is).
  app.get("/vault/entries/:id/totp", { preHandler: vaultGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const t = vault.currentTotp(req.authUser.id, id, { actor: "user" });
      return { code: t.code, expiresInSeconds: t.expiresInSeconds };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  app.get("/vault/access-log", { preHandler: vaultGuard }, async (req, reply) => {
    try {
      return { entries: vault.accessLog(req.authUser.id, 200) };
    } catch (err) {
      return vaultErr(reply, err);
    }
  });

  // ---- scheduled routines ----
  const TriggerInputBody = z.object({
    cron: z.string().trim().max(120).optional(),
    dailyAt: z.string().trim().max(8).optional(),
    weeklyOn: z.string().trim().max(12).optional(),
    weeklyAt: z.string().trim().max(8).optional(),
    monthlyDay: z.number().int().min(1).max(28).optional(),
    monthlyAt: z.string().trim().max(8).optional(),
    onceAt: z.string().trim().max(40).optional(),
    everyMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  });
  const RoutineActionBody = z.object({
    agent: z.enum(["planner", "task", "document", "notes", "tools", "research"]).default("planner"),
    instruction: z.string().trim().min(1).max(4000),
  });
  const CreateRoutineBody = z.object({
    name: z.string().trim().min(1).max(120),
    trigger: TriggerInputBody,
    action: RoutineActionBody,
    deliverChannelId: z.string().trim().max(40).nullish(),
    catchUp: z.enum(["skip", "run"]).optional(),
    enabled: z.boolean().optional(),
  });
  const UpdateRoutineBody = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      trigger: TriggerInputBody.optional(),
      action: RoutineActionBody.optional(),
      deliverChannelId: z.string().trim().max(40).nullish(),
      catchUp: z.enum(["skip", "run"]).optional(),
    })
    .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "Nothing to update." });

  /** Recompute + persist next_run_at right after a create/update, so the client
   *  shows a real "next run" without waiting for the scheduler's next tick. */
  const primeSchedule = (userStore: ScopedStore, routine: RoutineRecord) => {
    if (!routine.enabled) {
      userStore.setRoutineSchedule(routine.id, { nextRunAt: null });
      return;
    }
    try {
      const next = nextRunAt(routine.trigger, new Date());
      userStore.setRoutineSchedule(routine.id, { nextRunAt: next ? next.toISOString() : null });
    } catch {
      userStore.setRoutineSchedule(routine.id, { nextRunAt: null });
    }
  };

  app.get("/routines", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    return { routines: req.userStore.listRoutines().map(routineView) };
  });

  app.post("/routines", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const parsed = CreateRoutineBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    let trigger;
    try {
      trigger = parseTriggerInput(parsed.data.trigger);
    } catch (err) {
      return reply.code(400).send({ error: `Schedule: ${(err as Error).message}` });
    }
    if (trigger.kind === "once" && !nextRunAt(trigger, new Date())) {
      return reply.code(400).send({ error: "That time is already in the past." });
    }
    const routine = req.userStore.createRoutine({
      name: parsed.data.name,
      trigger,
      action: parsed.data.action,
      deliverChannelId: parsed.data.deliverChannelId ?? null,
      catchUp: parsed.data.catchUp,
      enabled: parsed.data.enabled,
    });
    primeSchedule(req.userStore, routine);
    return reply.code(201).send({ routine: routineView(req.userStore.getRoutine(routine.id)!) });
  });

  app.get("/routines/:id", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const routine = req.userStore.getRoutine((req.params as { id: string }).id);
    if (!routine) return reply.code(404).send({ error: "routine not found" });
    return { routine: routineView(routine), runs: req.userStore.listRoutineRuns(routine.id, 20) };
  });

  app.patch("/routines/:id", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const parsed = UpdateRoutineBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { id } = req.params as { id: string };
    if (!req.userStore.getRoutine(id)) return reply.code(404).send({ error: "routine not found" });
    const patch: Parameters<ScopedStore["updateRoutine"]>[1] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.action !== undefined) patch.action = parsed.data.action;
    if (parsed.data.deliverChannelId !== undefined) patch.deliverChannelId = parsed.data.deliverChannelId ?? null;
    if (parsed.data.catchUp !== undefined) patch.catchUp = parsed.data.catchUp;
    if (parsed.data.trigger !== undefined) {
      try {
        patch.trigger = parseTriggerInput(parsed.data.trigger);
      } catch (err) {
        return reply.code(400).send({ error: `Schedule: ${(err as Error).message}` });
      }
      if (patch.trigger.kind === "once" && !nextRunAt(patch.trigger, new Date())) {
        return reply.code(400).send({ error: "That time is already in the past." });
      }
    }
    const routine = req.userStore.updateRoutine(id, patch)!;
    primeSchedule(req.userStore, routine);
    return { routine: routineView(req.userStore.getRoutine(id)!) };
  });

  app.delete("/routines/:id", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const routine = req.userStore.deleteRoutine((req.params as { id: string }).id);
    if (!routine) return reply.code(404).send({ error: "routine not found" });
    return { deleted: true };
  });

  app.get("/routines/:id/runs", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const { id } = req.params as { id: string };
    if (!req.userStore.getRoutine(id)) return reply.code(404).send({ error: "routine not found" });
    const limit = Number((req.query as any)?.limit) || 20;
    return { runs: req.userStore.listRoutineRuns(id, limit) };
  });

  // Run a routine right now. Serialized through the scheduler's queue (the model
  // is single-threaded and slow), so this awaits until the run finishes — the
  // same synchronous shape as POST /chat.
  app.post("/routines/:id/run", async (req, reply) => {
    if (!config.routinesEnabled) return routinesOff(reply);
    const { id } = req.params as { id: string };
    if (!req.userStore.getRoutine(id)) return reply.code(404).send({ error: "routine not found" });
    const result = await app.routineScheduler.runNow(req.authUser.id, id);
    return {
      status: result.status,
      output: result.output ?? null,
      error: result.error ?? null,
      run: req.userStore.listRoutineRuns(id, 1)[0] ?? null,
    };
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

  // ---- AI-generated full-page artifacts (render_artifact) ----
  // Per-user, browsable in the Artifacts tab. The list omits the (large) html;
  // GET /:id returns both the raw fragment and the wrapped sandboxed document.
  const artifactSummary = (a: ArtifactRecord, openComments = 0) => ({
    id: a.id,
    title: a.title,
    source: a.source,
    sourceId: a.sourceId,
    revision: a.revision,
    canRevert: a.canRevert,
    openComments,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });

  const artifactsGate = (reply: FastifyReply) =>
    config.artifactsEnabled ? null : reply.code(404).send({ error: "Artifacts are disabled." });

  app.get("/artifacts", async (req, reply) => {
    if (artifactsGate(reply)) return;
    return {
      artifacts: req.userStore
        .listArtifacts()
        .map((a) => artifactSummary(a, req.userStore.openArtifactCommentCount(a.id))),
    };
  });

  app.get("/artifacts/:id", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    const a = req.userStore.getArtifact(id);
    if (!a) return reply.code(404).send({ error: "artifact not found" });
    const comments = req.userStore.listArtifactComments(id);
    return { artifact: wrapArtifact(a, comments.map(toAnchor)), comments };
  });

  app.patch("/artifacts/:id", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    const parsed = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const a = req.userStore.renameArtifact(id, parsed.data.title);
    if (!a) return reply.code(404).send({ error: "artifact not found" });
    return { artifact: artifactSummary(a, req.userStore.openArtifactCommentCount(id)) };
  });

  app.delete("/artifacts/:id", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    const a = req.userStore.deleteArtifact(id);
    if (!a) return reply.code(404).send({ error: "artifact not found" });
    return { deleted: true };
  });

  app.post("/artifacts/:id/revert", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    const before = req.userStore.getArtifact(id);
    if (!before) return reply.code(404).send({ error: "artifact not found" });
    if (!before.canRevert) return reply.code(409).send({ error: "There's no earlier version to revert to." });
    const a = req.userStore.revertArtifact(id);
    const comments = req.userStore.listArtifactComments(id);
    return { artifact: wrapArtifact(a!, comments.map(toAnchor)), comments };
  });

  // ---- artifact comments (highlight + leave a note; the assistant addresses it) ----

  app.get("/artifacts/:id/comments", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    if (!req.userStore.getArtifact(id)) return reply.code(404).send({ error: "artifact not found" });
    return { comments: req.userStore.listArtifactComments(id) };
  });

  app.post("/artifacts/:id/comments", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        body: z.string().trim().min(1).max(2000),
        quote: z.string().max(1000).optional(),
        prefix: z.string().max(80).optional(),
        suffix: z.string().max(80).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const c = req.userStore.addArtifactComment({ artifactId: id, ...parsed.data });
    if (!c) return reply.code(404).send({ error: "artifact not found" });
    return { comment: c };
  });

  app.patch("/artifacts/:id/comments/:cid", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id, cid } = req.params as { id: string; cid: string };
    const parsed = z
      .object({ body: z.string().trim().min(1).max(2000).optional(), status: z.enum(["open"]).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    let c = parsed.data.status === "open" ? req.userStore.reopenArtifactComment(id, cid) : undefined;
    if (parsed.data.body) c = req.userStore.updateArtifactComment(id, cid, parsed.data.body);
    c ??= req.userStore.getArtifactComment(id, cid);
    if (!c) return reply.code(404).send({ error: "comment not found" });
    return { comment: c };
  });

  app.delete("/artifacts/:id/comments/:cid", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id, cid } = req.params as { id: string; cid: string };
    if (!req.userStore.deleteArtifactComment(id, cid)) return reply.code(404).send({ error: "comment not found" });
    return { deleted: true };
  });

  // Manual resolve — the human marks a comment done without asking the
  // assistant to touch the page. Distinct from resolve-comments below (which
  // is AI-driven and may also edit the artifact); this is a plain status
  // change, available on every open comment regardless of AI involvement.
  app.post("/artifacts/:id/comments/:cid/resolve", async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id, cid } = req.params as { id: string; cid: string };
    if (!req.userStore.getArtifact(id)) return reply.code(404).send({ error: "artifact not found" });
    const parsed = z.object({ resolution: z.string().trim().max(2000).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const c = req.userStore.resolveArtifactComment(id, cid, {
      resolution: parsed.data.resolution || "Marked resolved.",
      resolvedBy: "user",
    });
    if (!c) return reply.code(404).send({ error: "comment not found" });
    return { comment: c };
  });

  // Run the assistant over the open comments: it edits the artifact and/or
  // replies to each. Awaited like POST /chat (a planner turn is slow).
  app.post("/artifacts/:id/resolve-comments", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (artifactsGate(reply)) return;
    const { id } = req.params as { id: string };
    if (!req.userStore.getArtifact(id)) return reply.code(404).send({ error: "artifact not found" });
    const parsed = z
      .object({ commentIds: z.array(z.string()).max(20).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const result = await resolveArtifactComments(extractionModel, req.userStore, id, parsed.data.commentIds);
    if ("error" in result) return reply.code(502).send({ error: result.error });
    const a = req.userStore.getArtifact(id)!;
    const comments = req.userStore.listArtifactComments(id);
    return { artifact: wrapArtifact(a, comments.map(toAnchor)), comments, ...result };
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
    ttsEnabled: config.ttsEnabled,
    ttsVoice: config.ttsVoice,
    embedModel: config.embedModel,
    embedEnabled: config.embedEnabled,
    serverName: config.serverName,
    cardsEnabled: config.cardsEnabled,
    vaultEnabled: config.vaultEnabled,
    autoUpdateEnabled: config.autoUpdateEnabled,
    // Internet access (research agent). The key itself is never sent back —
    // only whether one is stored.
    webEnabled: webEnabled(),
    webSearchProvider: config.webSearchProvider,
    webSearchUrl: config.webSearchUrl,
    webSearchApiKeySet: config.webSearchApiKey.length > 0,
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
    ttsVoice: z.string().trim().max(40).optional(),
    embedModel: z.string().trim().max(120).optional(),
    serverName: z.string().trim().min(1).max(60).optional(),
    cardsEnabled: z.boolean().optional(),
    vaultEnabled: z.boolean().optional(),
    autoUpdateEnabled: z.boolean().optional(),
    webSearchProvider: z.enum(["searxng", "tavily", "brave", "ddg", "none"]).optional(),
    webSearchUrl: z.string().trim().max(300).optional(),
    webSearchApiKey: z.string().trim().max(400).optional(),
  });
  app.put("/settings", async (req, reply) => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const patch = parsed.data;
    if (Object.values(patch).every((v) => v === undefined)) {
      return reply.code(400).send({ error: "Nothing to update." });
    }

    const adminFields = ["model", "ollamaBaseUrl", "ocrModel", "asrModel", "ttsVoice", "embedModel", "serverName", "cardsEnabled", "vaultEnabled", "autoUpdateEnabled", "webSearchProvider", "webSearchUrl", "webSearchApiKey"] as const;
    if (req.authUser.role !== "admin" && adminFields.some((f) => patch[f] !== undefined)) {
      return reply.code(403).send({ error: "Only an admin can change machine settings." });
    }

    for (const key of ["inboxDir", "model", "ollamaBaseUrl", "ocrModel", "asrModel", "ttsVoice", "embedModel", "serverName", "cardsEnabled", "vaultEnabled", "autoUpdateEnabled"] as const) {
      if (patch[key] !== undefined && envLocked[key]) {
        return reply.code(400).send({
          error: `"${key}" is pinned by an environment variable and can't be changed here.`,
        });
      }
    }
    if ((patch.webSearchProvider !== undefined || patch.webSearchUrl !== undefined || patch.webSearchApiKey !== undefined) && envLocked.webSearchProvider) {
      return reply.code(400).send({
        error: "Internet access is pinned by a FAMILY_AGENT_WEB_SEARCH_* environment variable and can't be changed here.",
      });
    }

    // A provider needs its companion setting to actually work — validate against
    // the state *after* this patch so "set key, then switch provider" in either
    // order is fine.
    const nextProvider = patch.webSearchProvider ?? config.webSearchProvider;
    const nextUrl = patch.webSearchUrl ?? config.webSearchUrl;
    const nextKey = patch.webSearchApiKey ?? config.webSearchApiKey;
    if (nextProvider === "searxng" && !nextUrl) {
      return reply.code(400).send({ error: "The SearXNG provider needs a server URL." });
    }
    if ((nextProvider === "tavily" || nextProvider === "brave") && !nextKey) {
      return reply.code(400).send({ error: `The ${nextProvider} provider needs an API key.` });
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
      ttsVoice: patch.ttsVoice,
      embedModel: patch.embedModel,
      serverName: patch.serverName,
      cardsEnabled: patch.cardsEnabled,
      vaultEnabled: patch.vaultEnabled,
      autoUpdateEnabled: patch.autoUpdateEnabled,
      webSearchProvider: patch.webSearchProvider,
      webSearchUrl: patch.webSearchUrl,
      webSearchApiKey: patch.webSearchApiKey,
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
    if (patch.ttsVoice) config.ttsVoice = patch.ttsVoice; // per-call, no reload
    if (patch.serverName !== undefined) config.serverName = patch.serverName;
    if (patch.cardsEnabled !== undefined && patch.cardsEnabled !== config.cardsEnabled) {
      config.cardsEnabled = patch.cardsEnabled;
      dropAllAgents(); // re-wire render_card into (or out of) every agent
    }
    // No dropAllAgents() needed: vault-agent is forced-turn-only (/vault) and
    // never wired into the planner's cached subagents array or any other
    // cached agent's tool list, so there's no stale cache to invalidate.
    if (patch.vaultEnabled !== undefined) config.vaultEnabled = patch.vaultEnabled;
    // No dropAllAgents() here either — this flag is only ever read by the
    // desktop frontend's own periodic poll (GET /settings), not by anything
    // agent-core wires into a cached agent.
    if (patch.autoUpdateEnabled !== undefined) config.autoUpdateEnabled = patch.autoUpdateEnabled;
    const webWas = webEnabled();
    if (patch.webSearchProvider !== undefined) config.webSearchProvider = patch.webSearchProvider;
    if (patch.webSearchUrl !== undefined) config.webSearchUrl = patch.webSearchUrl;
    if (patch.webSearchApiKey !== undefined) config.webSearchApiKey = patch.webSearchApiKey;
    if (webEnabled() !== webWas) {
      dropAllAgents(); // wire research-agent + the planner's web section in/out
    }

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
      [`Voice-output voice set to "${config.ttsVoice}"`, patch.ttsVoice !== undefined],
      [
        patch.embedModel
          ? `Semantic-search model set to "${patch.embedModel}"`
          : "Semantic-search model cleared",
        patch.embedModel !== undefined,
      ],
      [
        `AI-generated cards turned ${patch.cardsEnabled ? "on" : "off"}`,
        patch.cardsEnabled !== undefined,
      ],
      [
        `Password vault turned ${patch.vaultEnabled ? "on" : "off"}`,
        patch.vaultEnabled !== undefined,
      ],
      [
        `Automatic desktop updates turned ${patch.autoUpdateEnabled ? "on" : "off"}`,
        patch.autoUpdateEnabled !== undefined,
      ],
      [
        config.webSearchProvider === "none"
          ? "Internet access turned off"
          : `Internet access turned on (${config.webSearchProvider})`,
        patch.webSearchProvider !== undefined,
      ],
    ] as const) {
      if (changed) req.userStore.logActivity("system", "settings.updated", msg);
    }

    return settingsPayload(req.authUser);
  });

  // ---- remote update-and-restart of the host desktop app ----
  // See desktopUpdate.ts for the full hand-off shape. Reading/reporting is
  // open to any signed-in user (the desktop's own webview may currently be
  // signed in as a non-admin family member and still needs to report
  // progress); only the trigger itself is admin-gated.
  app.get("/system/update-status", async () => getDesktopUpdateStatus());

  app.post("/system/update-request", { preHandler: requireAdmin }, async (req) => {
    return requestDesktopUpdate(req.authUser.displayName);
  });

  const UpdateReportBody = z.object({
    state: z.enum(["checking", "no-update", "downloading", "installing", "restarting", "error"]),
    message: z.string().trim().max(500).optional(),
    percent: z.number().min(0).max(100).optional(),
  });
  app.post("/system/update-report", async (req, reply) => {
    const parsed = UpdateReportBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    return reportDesktopUpdateStatus(parsed.data);
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

  const app = buildServer(store, hooks, supervisor, { startRoutineScheduler: true });
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
  // Pre-load the QuickJS wasm module so the first run_code isn't slow.
  void warmCompute();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      mdns?.destroy();
      app.routineScheduler.stop();
      supervisor.stopAll();
      app.mcpManager.stopAll();
      app.vault.keyring.lockAll();
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
