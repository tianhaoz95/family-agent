import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// The desktop Settings "Model provider" control drives config.modelProvider
// (+ its per-provider companion fields) through PUT /settings. ADDITIVE, not
// exclusive: switching this never touches ocrModel/embedModel, which stay on
// their own Ollama-only settings regardless — see config.ts and
// mistralrs/README-shaped comments there.
describe("HTTP API — model provider setting", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  const saved = {
    modelProvider: config.modelProvider,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiApiKey: config.openaiApiKey,
    openaiModel: config.openaiModel,
    mistralrsModelId: config.mistralrsModelId,
    mistralrsGgufFile: config.mistralrsGgufFile,
    mistralrsIsqBits: config.mistralrsIsqBits,
  };

  beforeEach(() => {
    config.modelProvider = "ollama";
    config.openaiBaseUrl = "";
    config.openaiApiKey = "";
    config.openaiModel = "";
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    config.modelProvider = saved.modelProvider;
    config.openaiBaseUrl = saved.openaiBaseUrl;
    config.openaiApiKey = saved.openaiApiKey;
    config.openaiModel = saved.openaiModel;
    config.mistralrsModelId = saved.mistralrsModelId;
    config.mistralrsGgufFile = saved.mistralrsGgufFile;
    config.mistralrsIsqBits = saved.mistralrsIsqBits;
  });

  it("GET /settings and /health report ollama as the default; no key is echoed", async () => {
    const s = (await authInject(app, admin.token)("/settings")).json();
    expect(s.modelProvider).toBe("ollama");
    expect(s.openaiApiKeySet).toBe(false);
    expect(s).not.toHaveProperty("openaiApiKey");
    expect((await app.inject("/health")).json().modelProvider).toBe("ollama");
  });

  it("an admin can switch to the openai-compatible provider once a base URL is given", async () => {
    const put = authInject(app, admin.token);
    const rejected = await put({ method: "PUT", url: "/settings", payload: { modelProvider: "openai" } });
    expect(rejected.statusCode).toBe(400);

    const ok = await put({
      method: "PUT",
      url: "/settings",
      payload: { modelProvider: "openai", openaiBaseUrl: "http://localhost:8000/v1", openaiModel: "local-model" },
    });
    expect(ok.statusCode).toBe(200);
    expect(config.modelProvider).toBe("openai");
    expect(config.openaiBaseUrl).toBe("http://localhost:8000/v1");
  });

  it("a member cannot change it", async () => {
    const res = await authInject(app, member.token)({
      method: "PUT",
      url: "/settings",
      payload: { modelProvider: "mistralrs" },
    });
    expect(res.statusCode).toBe(403);
    expect(config.modelProvider).toBe("ollama");
  });

  it("stores an OpenAI-compatible API key but only reports that one is set", async () => {
    const put = authInject(app, admin.token);
    const ok = await put({
      method: "PUT",
      url: "/settings",
      payload: { modelProvider: "openai", openaiBaseUrl: "http://localhost:8000/v1", openaiApiKey: "secret-456" },
    });
    expect(ok.statusCode).toBe(200);
    expect(config.openaiApiKey).toBe("secret-456");
    const s = (await put("/settings")).json();
    expect(s.openaiApiKeySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain("secret-456");
  });

  it("switching to mistralrs reports a status object in /settings and /health", async () => {
    const put = authInject(app, admin.token);
    const ok = await put({ method: "PUT", url: "/settings", payload: { modelProvider: "mistralrs" } });
    expect(ok.statusCode).toBe(200);
    const s = (await put("/settings")).json();
    expect(s.modelProvider).toBe("mistralrs");
    expect(s.mistralrsStatus).toBeDefined();
    expect(["unavailable", "idle", "loading", "ready", "error"]).toContain(s.mistralrsStatus.status);
    const health = (await app.inject("/health")).json();
    expect(health.mistralrs).toBeDefined();
  });
});
