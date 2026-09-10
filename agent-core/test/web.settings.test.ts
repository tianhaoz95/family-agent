import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// The desktop/Android/iOS "Internet access" control drives config.webSearchProvider
// through PUT /settings. See docs/DECISIONS.md → "Web access".
describe("HTTP API — internet-access toggle", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  const saved = {
    provider: config.webSearchProvider,
    url: config.webSearchUrl,
    key: config.webSearchApiKey,
  };

  beforeEach(() => {
    config.webSearchProvider = "none";
    config.webSearchUrl = "";
    config.webSearchApiKey = "";
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    config.webSearchProvider = saved.provider;
    config.webSearchUrl = saved.url;
    config.webSearchApiKey = saved.key;
  });

  it("GET /settings and /health report the off state; the key is never echoed", async () => {
    const s = (await authInject(app, admin.token)("/settings")).json();
    expect(s.webEnabled).toBe(false);
    expect(s.webSearchProvider).toBe("none");
    expect(s.webSearchApiKeySet).toBe(false);
    expect(s).not.toHaveProperty("webSearchApiKey");
    expect((await app.inject("/health")).json().web).toBe("off");
  });

  it("an admin can turn it on with the keyless ddg provider", async () => {
    const res = await authInject(app, admin.token)({
      method: "PUT",
      url: "/settings",
      payload: { webSearchProvider: "ddg" },
    });
    expect(res.statusCode).toBe(200);
    expect(config.webSearchProvider).toBe("ddg");
    expect((await app.inject("/health")).json().web).toBe("on");
  });

  it("a member cannot flip it", async () => {
    const res = await authInject(app, member.token)({
      method: "PUT",
      url: "/settings",
      payload: { webSearchProvider: "ddg" },
    });
    expect(res.statusCode).toBe(403);
    expect(config.webSearchProvider).toBe("none");
  });

  it("rejects a provider whose companion setting is missing, accepts it once provided", async () => {
    const put = authInject(app, admin.token);
    expect((await put({ method: "PUT", url: "/settings", payload: { webSearchProvider: "searxng" } })).statusCode).toBe(400);
    expect((await put({ method: "PUT", url: "/settings", payload: { webSearchProvider: "tavily" } })).statusCode).toBe(400);

    const ok = await put({
      method: "PUT",
      url: "/settings",
      payload: { webSearchProvider: "searxng", webSearchUrl: "http://searx.local" },
    });
    expect(ok.statusCode).toBe(200);
    expect(config.webSearchUrl).toBe("http://searx.local");

    const s = (await put("/settings")).json();
    expect(s.webSearchProvider).toBe("searxng");
    expect(s.webSearchUrl).toBe("http://searx.local");
  });

  it("stores an API key but only reports that one is set", async () => {
    const put = authInject(app, admin.token);
    const ok = await put({
      method: "PUT",
      url: "/settings",
      payload: { webSearchProvider: "brave", webSearchApiKey: "secret-123" },
    });
    expect(ok.statusCode).toBe(200);
    expect(config.webSearchApiKey).toBe("secret-123");
    const s = (await put("/settings")).json();
    expect(s.webSearchApiKeySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain("secret-123");
  });
});
