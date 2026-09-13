import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// A /chat turn's HTTP request must always terminate — see config.chatTimeoutMs
// and docs/DECISIONS.md → "Chat never hangs forever: a whole-turn timeout".
// This never happened in practice before that guard (nothing upstream of the
// route enforces a ceiling on the model/tool call chain), which is the
// suspected root cause behind reports of Chat getting stuck on "…" forever.
describe("chat — a turn always terminates (config.chatTimeoutMs)", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;
  let realTimeout: number;

  beforeEach(() => {
    realDataDir = config.dataDir;
    realTimeout = config.chatTimeoutMs;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-chattimeout-"));
    config.chatTimeoutMs = 30;
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    inject = authInject(app, admin.token);
  });

  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
    config.chatTimeoutMs = realTimeout;
    vi.restoreAllMocks();
  });

  it("returns a clean 504 instead of hanging when the model call never resolves", async () => {
    const idx = await import("../src/agents/index.js");
    vi.spyOn(idx, "buildFamilyAgent").mockImplementation(
      () => ({ invoke: () => new Promise(() => {}) }) as any
    );
    // askFamilyAgent itself awaits agent.invoke(), which never resolves —
    // standing in for a genuinely stuck Ollama call, a stuck web fetch, or a
    // small-model tool-call loop. The request must still come back.
    const res = await inject({ method: "POST", url: "/chat", payload: { message: "restaurants near me" } });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatch(/taking much longer than usual/i);
  });
});
