import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { config } from "../src/config.js";
import {
  isValidMcpName,
  upsertMcpServer,
  listMcpServers,
  mcpServersForUser,
  setMcpServerEnabled,
  deleteMcpServer,
  redactMcpServer,
  type McpServerConfig,
} from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

let realDataDir: string;
let realMcpEnabled: boolean;

beforeEach(() => {
  realDataDir = config.dataDir;
  realMcpEnabled = config.mcpEnabled;
  config.dataDir = mkdtempSync(join(tmpdir(), "fa-mcp-"));
  config.mcpEnabled = true;
});
afterEach(() => {
  rmSync(config.dataDir, { recursive: true, force: true });
  config.dataDir = realDataDir;
  config.mcpEnabled = realMcpEnabled;
});

// ---- a tiny in-process MCP server (Streamable HTTP, direct JSON responses) ----

interface FakeOpts {
  tools?: { name: string; description?: string; inputSchema?: object; annotations?: object }[];
  onCall?: (name: string, args: Record<string, unknown>) => { text?: string; isError?: boolean };
}

function startFakeMcp(opts: FakeOpts = {}): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const tools = opts.tools ?? [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }];
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      hits.push(msg.method);
      const reply = (result: unknown) =>
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } });
      if (msg.method === "tools/list") return reply({ tools });
      if (msg.method === "tools/call") {
        const r = opts.onCall?.(msg.params.name, msg.params.arguments ?? {}) ?? { text: `called ${msg.params.name}` };
        return reply({ content: [{ type: "text", text: r.text ?? "" }], isError: !!r.isError });
      }
      res.writeHead(400).end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("mcp/config", () => {
  it("isValidMcpName", () => {
    expect(isValidMcpName("github-issues")).toBe(true);
    for (const bad of ["Bad Name", "under_score", "-x", ""]) expect(isValidMcpName(bad), bad).toBe(false);
  });

  it("upsert validates transport requirements", () => {
    expect(() => upsertMcpServer({ name: "h", transport: "http", enabled: true } as McpServerConfig)).toThrow(/URL/i);
    expect(() => upsertMcpServer({ name: "s", transport: "stdio", enabled: true } as McpServerConfig)).toThrow(/command/i);
    const ok = upsertMcpServer({ name: "h", transport: "http", enabled: true, url: "https://example.com/mcp" } as McpServerConfig);
    expect(ok.url).toBe("https://example.com/mcp");
    expect(listMcpServers().map((s) => s.name)).toEqual(["h"]);
  });

  it("upsert replaces by name; enable + delete", () => {
    upsertMcpServer({ name: "h", transport: "http", enabled: true, url: "https://a.test/mcp" } as McpServerConfig);
    upsertMcpServer({ name: "h", transport: "http", enabled: true, url: "https://b.test/mcp" } as McpServerConfig);
    expect(listMcpServers()).toHaveLength(1);
    expect(listMcpServers()[0].url).toBe("https://b.test/mcp");
    expect(setMcpServerEnabled("h", false)?.enabled).toBe(false);
    expect(deleteMcpServer("h")).toBe(true);
    expect(deleteMcpServer("h")).toBe(false);
  });

  it("scope filtering: family vs user", () => {
    upsertMcpServer({ name: "shared", transport: "http", enabled: true, url: "https://x.test/mcp", scope: "family" } as McpServerConfig);
    upsertMcpServer({ name: "mine", transport: "http", enabled: true, url: "https://y.test/mcp", scope: "user:u1" } as McpServerConfig);
    upsertMcpServer({ name: "theirs", transport: "http", enabled: true, url: "https://z.test/mcp", scope: "user:u2" } as McpServerConfig);
    expect(mcpServersForUser("u1").map((s) => s.name).sort()).toEqual(["mine", "shared"]);
    expect(mcpServersForUser("u2").map((s) => s.name).sort()).toEqual(["shared", "theirs"]);
  });

  it("redactMcpServer scrubs secret-looking headers and env", () => {
    const red = redactMcpServer({
      name: "h",
      transport: "http",
      enabled: true,
      url: "https://x.test/mcp",
      headers: { Authorization: "Bearer abc", "X-Client": "nana" },
      env: { API_TOKEN: "shh", DEBUG: "1" },
    });
    expect(red.headers?.Authorization).toBe("••••");
    expect(red.headers?.["X-Client"]).toBe("nana");
    expect(red.env?.API_TOKEN).toBe("••••");
    expect(red.env?.DEBUG).toBe("1");
  });

  it("seeds from FAMILY_AGENT_MCP_SERVERS on first run", () => {
    const prev = config.mcpServersSeed;
    config.mcpServersSeed = JSON.stringify([{ name: "seeded", transport: "http", url: "https://s.test/mcp" }]);
    try {
      expect(listMcpServers().map((s) => s.name)).toEqual(["seeded"]);
    } finally {
      config.mcpServersSeed = prev;
    }
  });
});

describe("McpManager (against a fake server)", () => {
  it("lists tools and calls one, clamping oversized results", async () => {
    const fake = await startFakeMcp({
      tools: [{ name: "weather", description: "get weather", annotations: { readOnlyHint: true } }],
      onCall: (name) => ({ text: name === "weather" ? "x".repeat(50_000) : "?" }),
    });
    const prevMax = config.mcpMaxResultChars;
    config.mcpMaxResultChars = 1000;
    try {
      upsertMcpServer({ name: "svc", transport: "http", enabled: true, url: fake.url } as McpServerConfig);
      const mgr = new McpManager();
      const tools = await mgr.toolsForUser("u1");
      expect(tools.map((t) => t.tool.name)).toEqual(["weather"]);

      const res = await mgr.callTool("u1", "svc", "weather", {});
      expect(res.ok).toBe(true);
      expect(String(res.value).length).toBeLessThan(1100);
      expect(String(res.value)).toContain("truncated");

      mgr.stopAll();
    } finally {
      config.mcpMaxResultChars = prevMax;
      await fake.close();
    }
  });

  it("a disabled server contributes no tools", async () => {
    const fake = await startFakeMcp();
    try {
      upsertMcpServer({ name: "svc", transport: "http", enabled: false, url: fake.url } as McpServerConfig);
      const mgr = new McpManager();
      expect(await mgr.toolsForUser("u1")).toEqual([]);
      mgr.stopAll();
    } finally {
      await fake.close();
    }
  });

  it("an unreachable server degrades instead of throwing", async () => {
    upsertMcpServer({ name: "dead", transport: "http", enabled: true, url: "http://127.0.0.1:1/mcp" } as McpServerConfig);
    const mgr = new McpManager();
    await expect(mgr.toolsForUser("u1")).resolves.toEqual([]);
    const probe = await mgr.probe("dead");
    expect(probe.ok).toBe(false);
    mgr.stopAll();
  });

  it("a stdio server with a missing command degrades instead of throwing", async () => {
    upsertMcpServer({
      name: "stdio-broken",
      transport: "stdio",
      enabled: true,
      command: "definitely-not-a-real-binary-xyz",
    } as McpServerConfig);
    const mgr = new McpManager();
    await expect(mgr.toolsForUser("u1")).resolves.toEqual([]);
    expect((await mgr.probe("stdio-broken")).ok).toBe(false);
    mgr.stopAll();
  });

  it("returns nothing when MCP is disabled globally", async () => {
    config.mcpEnabled = false;
    const mgr = new McpManager();
    expect(mgr.enabled()).toBe(false);
    expect(await mgr.toolsForUser("u1")).toEqual([]);
  });
});

describe("mcp routes", () => {
  let app: FastifyInstance;
  let store: Store;
  let admin: SeededUser;
  let member: SeededUser;
  let asAdmin: ReturnType<typeof authInject>;
  let asMember: ReturnType<typeof authInject>;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
    admin = seedUser(store, { username: "owner", role: "admin" });
    member = seedUser(store, { username: "kid", role: "member" });
    asAdmin = authInject(app, admin.token);
    asMember = authInject(app, member.token);
  });
  afterEach(async () => {
    await app.close();
  });

  it("server CRUD is admin-only and redacts secrets", async () => {
    const fake = await startFakeMcp();
    try {
      const create = await asAdmin({
        method: "POST",
        url: "/mcp/servers",
        payload: { name: "svc", transport: "http", url: fake.url, headers: { Authorization: "Bearer sekret" } },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json().server.headers.Authorization).toBe("••••");
      expect(create.json().probe.ok).toBe(true);

      const list = await asAdmin("/mcp/servers");
      expect(list.json().servers.map((s: { name: string }) => s.name)).toEqual(["svc"]);
      expect(list.json().servers[0].headers.Authorization).toBe("••••");

      expect((await asMember("/mcp/servers")).statusCode).toBe(403);
      expect(
        (await asMember({ method: "POST", url: "/mcp/servers", payload: { name: "x", transport: "http", url: "https://x.test/mcp" } })).statusCode
      ).toBe(403);

      const toggle = await asAdmin({ method: "PATCH", url: "/mcp/servers/svc", payload: { enabled: false } });
      expect(toggle.statusCode).toBe(200);

      expect((await asAdmin({ method: "DELETE", url: "/mcp/servers/svc" })).statusCode).toBe(200);
      expect((await asAdmin("/mcp/servers")).json().servers).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("GET /mcp/tools returns this user's connected tools", async () => {
    const fake = await startFakeMcp({ tools: [{ name: "search", description: "search things" }] });
    try {
      await asAdmin({ method: "POST", url: "/mcp/servers", payload: { name: "svc", transport: "http", url: fake.url } });
      const tools = await asMember("/mcp/tools");
      expect(tools.statusCode).toBe(200);
      expect(tools.json().tools).toEqual([{ server: "svc", name: "search", description: "search things" }]);
    } finally {
      await fake.close();
    }
  });

  it("rejects an http server with no URL (400)", async () => {
    const res = await asAdmin({ method: "POST", url: "/mcp/servers", payload: { name: "bad", transport: "http" } });
    expect(res.statusCode).toBe(400);
  });

  it("routes 404 when MCP is off", async () => {
    config.mcpEnabled = false;
    expect((await asAdmin("/mcp/servers")).statusCode).toBe(404);
    expect((await asAdmin("/mcp/tools")).json().tools).toEqual([]);
  });

  it("/health reports the mcp capability", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().mcp).toBe("no-servers");
    const fake = await startFakeMcp();
    try {
      await asAdmin({ method: "POST", url: "/mcp/servers", payload: { name: "svc", transport: "http", url: fake.url } });
      expect((await app.inject({ method: "GET", url: "/health" })).json().mcp).toBe("on");
    } finally {
      await fake.close();
    }
    config.mcpEnabled = false;
    expect((await app.inject({ method: "GET", url: "/health" })).json().mcp).toBe("off");
  });
});
