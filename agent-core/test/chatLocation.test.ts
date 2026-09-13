import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// A /chat turn's location lives in server.ts's chatLocations map, read
// through a closure (deps.getLocation) bound once when the user's planner
// agent is built — the agent itself is cached and reused across many turns,
// so this is the same "fresh per-call, closed over by a long-lived object"
// shape as chatRefs/onReference. Verified here by capturing that closure
// (via a spy on buildFamilyAgent) and calling it from inside a mocked
// askFamilyAgent, which is what a real get_current_location tool call
// would do mid-turn.
describe("chat — per-turn device location", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-chatloc-"));
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    inject = authInject(app, admin.token);
  });

  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
    vi.restoreAllMocks();
  });

  it("reaches get_current_location's closure for the turn that sent it, and is gone afterward", async () => {
    const idx = await import("../src/agents/index.js");
    let capturedGetLocation: (() => unknown) | undefined;
    vi.spyOn(idx, "buildFamilyAgent").mockImplementation((_store, deps) => {
      capturedGetLocation = deps?.getLocation;
      return { invoke: async () => ({ messages: [{ content: "ok" }] }) } as any;
    });
    const seenAtInvokeTime: unknown[] = [];
    vi.spyOn(idx, "askFamilyAgent").mockImplementation(async () => {
      seenAtInvokeTime.push(capturedGetLocation?.());
      return "ok";
    });

    await inject({
      method: "POST",
      url: "/chat",
      payload: {
        message: "parks near me",
        location: { latitude: 37.3688, longitude: -122.0363, accuracyMeters: 15 },
      },
    });
    // A second, plain turn with no location — must not see the first turn's.
    await inject({ method: "POST", url: "/chat", payload: { message: "hi again" } });

    expect(seenAtInvokeTime).toEqual([
      { latitude: 37.3688, longitude: -122.0363, accuracyMeters: 15 },
      undefined,
    ]);
  });

  it("keeps two concurrent turns for the SAME user from seeing each other's location", async () => {
    // Regression test for the bug behind "opening a new chat session showed
    // the other session's 'generating' state" — server.ts used to keep this
    // in a plain Map<userId, …>, which a second overlapping turn for the
    // same user (two of their own chat sessions, or two devices) would race:
    // turn A's location could leak into turn B's get_current_location call.
    // AsyncLocalStorage (chatTurnContext) scopes it to each call's own async
    // chain instead. Turn A's askFamilyAgent call pauses mid-flight —
    // standing in for a real slow model call — until turn B's own /chat
    // request has started *and finished* entirely inside that pause, so the
    // two genuinely overlap rather than merely running back-to-back.
    const idx = await import("../src/agents/index.js");
    let capturedGetLocation: (() => unknown) | undefined;
    vi.spyOn(idx, "buildFamilyAgent").mockImplementation((_store, deps) => {
      capturedGetLocation = deps?.getLocation;
      return { invoke: async () => ({ messages: [{ content: "ok" }] }) } as any;
    });
    let releaseA: () => void = () => {};
    const aPaused = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const seen: Record<string, unknown> = {};
    vi.spyOn(idx, "askFamilyAgent").mockImplementation(async (_agent, message: unknown) => {
      if (message === "restaurants near turn A") {
        await aPaused;
        seen.a = capturedGetLocation?.();
        return "ok a";
      }
      seen.b = capturedGetLocation?.();
      return "ok b";
    });

    const reqA = inject({
      method: "POST",
      url: "/chat",
      payload: { message: "restaurants near turn A", location: { latitude: 1, longitude: 1 } },
    });
    await new Promise((r) => setTimeout(r, 10)); // let turn A reach `await aPaused`
    await inject({
      method: "POST",
      url: "/chat",
      payload: { message: "restaurants near turn B", location: { latitude: 2, longitude: 2 } },
    });
    releaseA();
    await reqA;

    expect(seen.a).toEqual({ latitude: 1, longitude: 1 });
    expect(seen.b).toEqual({ latitude: 2, longitude: 2 });
  });

  it("rejects an out-of-range coordinate", async () => {
    const res = await inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi", location: { latitude: 999, longitude: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });
});
