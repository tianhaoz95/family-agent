import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// QR pairing: the desktop mints a single-use token bound to its own account,
// the phone redeems it for a real session with no password.
describe("phone pairing (QR auto sign-in)", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-pair-"));
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    inject = authInject(app, admin.token);
  });

  afterEach(async () => {
    await app.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("POST /auth/pair/start needs a signed-in caller", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/pair/start" });
    expect(res.statusCode).toBe(401);
  });

  it("redeems a started token for a working session bound to the same account", async () => {
    const start = await inject({ method: "POST", url: "/auth/pair/start" });
    expect(start.statusCode).toBe(200);
    const { token } = start.json() as { token: string };
    expect(token).toBeTruthy();

    const redeem = await app.inject({
      method: "POST",
      url: "/auth/pair/redeem",
      payload: { token },
    });
    expect(redeem.statusCode).toBe(200);
    const body = redeem.json() as { token: string; user: { id: string; username: string } };
    expect(body.user.username).toBe("owner");
    expect(body.user.id).toBe(admin.user.id);

    // The handed-back session token actually authenticates.
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { user: { username: string } }).user.username).toBe("owner");
  });

  it("is single-use — a second redeem of the same token fails", async () => {
    const { token } = (await inject({ method: "POST", url: "/auth/pair/start" })).json() as { token: string };
    const first = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token } });
    expect(second.statusCode).toBe(401);
  });

  it("rejects an unknown / garbage token", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token: "not-a-real-token" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { token } = store.createPairingToken(admin.user.id);
    // Fast-forward past the TTL by rewriting the row's expiry.
    (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE pairing_tokens SET expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());
    const res = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token } });
    expect(res.statusCode).toBe(401);
  });

  it("only the most recent token for a user stays live", async () => {
    const first = (await inject({ method: "POST", url: "/auth/pair/start" })).json() as { token: string };
    const second = (await inject({ method: "POST", url: "/auth/pair/start" })).json() as { token: string };
    expect(first.token).not.toBe(second.token);

    const stale = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token: first.token } });
    expect(stale.statusCode).toBe(401);
    const live = await app.inject({ method: "POST", url: "/auth/pair/redeem", payload: { token: second.token } });
    expect(live.statusCode).toBe(200);
  });
});
