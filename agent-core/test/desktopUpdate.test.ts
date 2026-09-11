import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";
import { resetDesktopUpdateStatus } from "../src/desktopUpdate.js";

// A phone triggers an update-and-restart of the desktop app hosting this
// server; the desktop's own frontend polls the same status and reports
// progress back. See desktopUpdate.ts for the full shape.
describe("remote update-and-restart of the host desktop app", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let adminInject: ReturnType<typeof authInject>;
  let memberInject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-update-"));
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
    adminInject = authInject(app, admin.token);
    memberInject = authInject(app, member.token);
    resetDesktopUpdateStatus();
  });
  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
    resetDesktopUpdateStatus();
  });

  it("starts idle", async () => {
    const res = await memberInject("/system/update-status");
    expect(res.json()).toEqual({ state: "idle" });
  });

  it("only an admin can trigger it; a member gets 403", async () => {
    const res = await memberInject({ method: "POST", url: "/system/update-request" });
    expect(res.statusCode).toBe(403);
    expect((await memberInject("/system/update-status")).json().state).toBe("idle");
  });

  it("an admin's trigger is visible to every signed-in client, including a non-admin one", async () => {
    const triggered = await adminInject({ method: "POST", url: "/system/update-request" });
    expect(triggered.statusCode).toBe(200);
    expect(triggered.json()).toMatchObject({ state: "requested", requestedBy: admin.user.displayName });

    const seen = await memberInject("/system/update-status");
    expect(seen.json()).toMatchObject({ state: "requested", requestedBy: admin.user.displayName });
  });

  it("the desktop (any signed-in user) can report progress without being an admin", async () => {
    await adminInject({ method: "POST", url: "/system/update-request" });

    const checking = await memberInject({ method: "POST", url: "/system/update-report", payload: { state: "checking" } });
    expect(checking.json().state).toBe("checking");
    // requestedBy/requestedAt survive through the run, so a client polling
    // mid-flight still sees who asked for this.
    expect(checking.json().requestedBy).toBe(admin.user.displayName);

    const downloading = await memberInject({
      method: "POST",
      url: "/system/update-report",
      payload: { state: "downloading", percent: 42 },
    });
    expect(downloading.json()).toMatchObject({ state: "downloading", percent: 42, requestedBy: admin.user.displayName });

    const failed = await memberInject({
      method: "POST",
      url: "/system/update-report",
      payload: { state: "error", message: "network unreachable" },
    });
    expect(failed.json()).toMatchObject({ state: "error", message: "network unreachable" });
  });

  it("rejects a report with a bad state", async () => {
    const res = await memberInject({ method: "POST", url: "/system/update-report", payload: { state: "bogus" } });
    expect(res.statusCode).toBe(400);
  });
});
