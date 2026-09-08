import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// HTTP contract for /vault. No live model — the "/vault" chat turn (which needs
// Ollama) is not exercised here; the crypto + service are in vault.test.ts.
describe("HTTP API — /vault", () => {
  let app: FastifyInstance;
  let store: Store;
  let alice: SeededUser;
  let bob: SeededUser;
  let asAlice: ReturnType<typeof authInject>;
  let asBob: ReturnType<typeof authInject>;
  const wasEnabled = config.vaultEnabled;

  beforeEach(() => {
    config.vaultEnabled = true;
    config.vaultAiEnabled = true;
    store = new Store(":memory:");
    app = buildServer(store);
    alice = seedUser(store, { username: "alice", password: "alicepw123", role: "admin" });
    bob = seedUser(store, { username: "bob", password: "bobpw12345", role: "member" });
    asAlice = authInject(app, alice.token);
    asBob = authInject(app, bob.token);
  });

  afterEach(async () => {
    await app.close();
    config.vaultEnabled = wasEnabled;
  });

  const setup = (who: ReturnType<typeof authInject>, password: string) =>
    who({ method: "POST", url: "/vault/setup", payload: { password } });

  it("health advertises the vault, /vault/* 404s when the feature is off", async () => {
    const on = await app.inject("/health");
    expect(on.json().vault).toBe("on");

    config.vaultEnabled = false;
    const res = await asAlice({ method: "GET", url: "/vault/entries" });
    expect(res.statusCode).toBe(404);
    const health = await app.inject("/health");
    expect(health.json().vault).toBe("off");
  });

  it("setup returns a one-time recovery code and unlocks the vault", async () => {
    const res = await setup(asAlice, "alicepw123");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(body.status.unlocked).toBe(true);

    // Wrong account password is refused.
    const wrong = await setup(asBob, "not-bobs-password");
    expect(wrong.statusCode).toBe(401);
  });

  it("locks, then unlock requires the account password", async () => {
    await setup(asAlice, "alicepw123");
    await asAlice({ method: "POST", url: "/vault/lock" });
    expect((await asAlice({ method: "GET", url: "/vault/status" })).json().unlocked).toBe(false);

    const bad = await asAlice({ method: "POST", url: "/vault/unlock", payload: { password: "nope" } });
    expect(bad.statusCode).toBe(401);
    const good = await asAlice({ method: "POST", url: "/vault/unlock", payload: { password: "alicepw123" } });
    expect(good.statusCode).toBe(200);
    expect(good.json().status.unlocked).toBe(true);
  });

  it("creates, reads, updates and deletes a private entry", async () => {
    await setup(asAlice, "alicepw123");
    const created = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "private", title: "Netflix", username: "a@x.com", password: "s3cret", url: "https://netflix.com" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().entry.id;
    expect(created.json().entry.hasTotp).toBe(false);

    const list = await asAlice({ method: "GET", url: "/vault/entries" });
    expect(list.json().entries).toHaveLength(1);
    expect(list.json().entries[0]).not.toHaveProperty("secret");

    const detail = await asAlice({ method: "GET", url: `/vault/entries/${id}` });
    expect(detail.json().entry.secret.password).toBe("s3cret");

    const patched = await asAlice({
      method: "PATCH",
      url: `/vault/entries/${id}`,
      payload: { password: "rotated-pw", notes: "shared with kids" },
    });
    expect(patched.statusCode).toBe(200);
    const after = await asAlice({ method: "GET", url: `/vault/entries/${id}` });
    expect(after.json().entry.secret.password).toBe("rotated-pw");
    expect(after.json().entry.secret.notes).toBe("shared with kids");

    const del = await asAlice({ method: "DELETE", url: `/vault/entries/${id}` });
    expect(del.statusCode).toBe(200);
    expect((await asAlice({ method: "GET", url: "/vault/entries" })).json().entries).toHaveLength(0);
  });

  it("does not leak one member's private entry to another", async () => {
    await setup(asAlice, "alicepw123");
    await setup(asBob, "bobpw12345");
    const created = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "private", title: "Alice bank", password: "x" },
    });
    const id = created.json().entry.id;
    expect((await asBob({ method: "GET", url: `/vault/entries/${id}` })).statusCode).toBe(403);
    expect((await asBob({ method: "GET", url: "/vault/entries" })).json().entries).toHaveLength(0);
  });

  it("returns 423 for vault operations while locked", async () => {
    await setup(asAlice, "alicepw123");
    await asAlice({ method: "POST", url: "/vault/lock" });
    const res = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "private", title: "x", password: "y" },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json().locked).toBe(true);
  });

  it("stores a TOTP secret and serves a ticking code (the polled GET is not logged)", async () => {
    await setup(asAlice, "alicepw123");
    const created = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: {
        scope: "private",
        title: "GitHub",
        totpInput: "otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      },
    });
    expect(created.json().entry.hasTotp).toBe(true);
    const id = created.json().entry.id;

    const totp = await asAlice({ method: "GET", url: `/vault/entries/${id}/totp` });
    expect(totp.statusCode).toBe(200);
    expect(totp.json().code).toMatch(/^\d{6}$/);
    expect(totp.json().expiresInSeconds).toBeGreaterThan(0);

    // The Vault screen polls /totp once a second — that must NOT flood the
    // audit log. Only the assistant path (get_totp_code) records a reveal.
    const log = await asAlice({ method: "GET", url: "/vault/access-log" });
    expect(log.json().entries.some((e: any) => e.action === "reveal_totp")).toBe(false);
    expect(log.json().entries.some((e: any) => e.action === "create" && e.entryTitle === "GitHub")).toBe(true);
  });

  it("rejects a malformed TOTP input with 400", async () => {
    await setup(asAlice, "alicepw123");
    const res = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "private", title: "x", totpInput: "not a real secret !!!" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("grants shared-vault access via /vault/family/sync (and opportunistically at setup)", async () => {
    await setup(asAlice, "alicepw123"); // mints the family key
    await asAlice({ method: "POST", url: "/vault/lock" }); // no admin unlocked now

    await setup(asBob, "bobpw12345");
    // No admin was unlocked, so Bob has no shared access yet.
    expect((await asBob({ method: "GET", url: "/vault/status" })).json().hasSharedAccess).toBe(false);
    const before = await asBob({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "shared", title: "Wi-Fi", password: "p" },
    });
    expect(before.statusCode).toBe(403);

    const memberSync = await asBob({ method: "POST", url: "/vault/family/sync" });
    expect(memberSync.statusCode).toBe(403); // admin only

    await asAlice({ method: "POST", url: "/vault/unlock", payload: { password: "alicepw123" } });
    const sync = await asAlice({ method: "POST", url: "/vault/family/sync" });
    expect(sync.json().granted).toBe(1);

    await asBob({ method: "POST", url: "/vault/unlock", payload: { password: "bobpw12345" } });
    const shared = await asAlice({
      method: "POST",
      url: "/vault/entries",
      payload: { scope: "shared", title: "Home Wi-Fi", password: "correcthorse" },
    });
    const id = shared.json().entry.id;
    const bobRead = await asBob({ method: "GET", url: `/vault/entries/${id}` });
    expect(bobRead.json().entry.secret.password).toBe("correcthorse");
  });

  it("opportunistically grants shared access at setup when an admin is unlocked", async () => {
    await setup(asAlice, "alicepw123"); // admin stays unlocked
    await setup(asBob, "bobpw12345");
    expect((await asBob({ method: "GET", url: "/vault/status" })).json().hasSharedAccess).toBe(true);
  });

  it("recovers via recovery code after a simulated admin password reset", async () => {
    const s = await setup(asBob, "bobpw12345");
    const code = s.json().recoveryCode;
    await asBob({ method: "POST", url: "/vault/entries", payload: { scope: "private", title: "x", password: "keep" } });

    // Admin resets Bob's password (this severs the login KEK).
    await asAlice({ method: "PATCH", url: `/users/${bob.user.id}`, payload: { password: "reset-by-admin" } });
    const bob2 = authInject(app, store.createSession(bob.user.id, "test2").token);
    const stillLocked = await bob2({ method: "GET", url: "/vault/status" });
    expect(stillLocked.json().unlocked).toBe(false);

    const rec = await bob2({
      method: "POST",
      url: "/vault/recover",
      payload: { recoveryCode: code, password: "reset-by-admin" },
    });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().status.unlocked).toBe(true);
    const entries = await bob2({ method: "GET", url: "/vault/entries" });
    expect(entries.json().entries[0].title).toBe("x");
  });
});
