import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// A document attached to a /chat turn (uploaded via /documents/upload, its id
// passed as documentIds) must have its extracted text reach the model, while
// the stored transcript keeps the user's own words.
describe("chat — attached documents", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let inject: ReturnType<typeof authInject>;
  let realDataDir: string;

  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "family-agent-chatatt-"));
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

  it("prepends the doc's text to the model message, keeps the transcript clean, returns a chip", async () => {
    const idx = await import("../src/agents/index.js");
    const seen: string[] = [];
    vi.spyOn(idx, "askFamilyAgent").mockImplementation(async (_agent, message) => {
      seen.push(message as string);
      return "The lease ends in June.";
    });

    const doc = store.scoped(admin.user.id).createDocument({
      filename: "lease.pdf",
      rawText: "APARTMENT LEASE AGREEMENT. Term: 12 months ending 2026-06-30. Rent $2,100/mo.",
    });

    const res = await inject({
      method: "POST",
      url: "/chat",
      payload: { message: "when does our lease end?", documentIds: [doc.id] },
    });
    expect(res.statusCode).toBe(200);

    // the model saw the document body …
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("APARTMENT LEASE AGREEMENT");
    expect(seen[0]).toContain("lease.pdf");
    expect(seen[0]).toContain("when does our lease end?");

    // … the reply carries a chip back to the document …
    expect(res.json().references).toContainEqual({ type: "document", id: doc.id, label: "lease.pdf" });

    // … and the stored user turn is just what they typed, plus an image/doc note in activity.
    const msgs = (await inject({ method: "GET", url: `/chat/sessions/${res.json().sessionId}/messages` })).json()
      .messages;
    expect(msgs[0].body).toBe("when does our lease end?");
  });

  it("ignores an unknown document id without failing the turn", async () => {
    const idx = await import("../src/agents/index.js");
    vi.spyOn(idx, "askFamilyAgent").mockResolvedValue("ok");
    const res = await inject({
      method: "POST",
      url: "/chat",
      payload: { message: "hi", documentIds: ["deadbeef"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().references ?? []).not.toContainEqual(expect.objectContaining({ id: "deadbeef" }));
  });

  it("another user's document id is not readable", async () => {
    const kid = seedUser(store, { username: "kid", role: "member" });
    const secret = store.scoped(kid.user.id).createDocument({ filename: "diary.txt", rawText: "TOP SECRET" });

    const idx = await import("../src/agents/index.js");
    const seen: string[] = [];
    vi.spyOn(idx, "askFamilyAgent").mockImplementation(async (_a, m) => {
      seen.push(m as string);
      return "ok";
    });

    await inject({ method: "POST", url: "/chat", payload: { message: "read it", documentIds: [secret.id] } });
    expect(seen[0]).not.toContain("TOP SECRET");
  });
});
