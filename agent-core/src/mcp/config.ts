import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, mcpConfigPath } from "../config.js";

// External MCP servers the family agent connects to. Config lives in
// <dataDir>/mcp.json; FAMILY_AGENT_MCP_SERVERS (a JSON array) seeds it on first
// run. Off entirely unless FAMILY_AGENT_MCP=1. See docs/DECISIONS.md → "Skills
// and MCP".

export type McpTransport = "http" | "stdio";

export interface McpServerConfig {
  /** Stable id / display name. Lowercase kebab. */
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** http: the server's single MCP endpoint URL. */
  url?: string;
  /** http: extra request headers (auth token, etc.). */
  headers?: Record<string, string>;
  /** stdio: the command + args to spawn (runs in the bwrap sandbox). */
  command?: string;
  args?: string[];
  /** stdio: environment for the child process. */
  env?: Record<string, string>;
  /** stdio: hostnames the sandboxed process may reach (network is otherwise
   *  fully blocked). e.g. ["api.github.com"]. */
  allowHosts?: string[];
  /** "family" (shared) or "user:<id>" — who sees this connection's tools. */
  scope?: string;
  /** Free-text note shown in the UI. */
  note?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
export function isValidMcpName(n: string): boolean {
  return NAME_RE.test(n);
}

interface McpFile {
  servers: McpServerConfig[];
}

function normalise(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "").trim().toLowerCase();
  if (!isValidMcpName(name)) return null;
  const transport = r.transport === "stdio" ? "stdio" : "http";
  const out: McpServerConfig = {
    name,
    transport,
    enabled: r.enabled === undefined ? true : !!r.enabled,
    scope: typeof r.scope === "string" ? r.scope : "family",
    note: typeof r.note === "string" ? r.note : undefined,
  };
  if (transport === "http") {
    out.url = typeof r.url === "string" ? r.url : "";
    if (r.headers && typeof r.headers === "object") out.headers = r.headers as Record<string, string>;
  } else {
    out.command = typeof r.command === "string" ? r.command : "";
    out.args = Array.isArray(r.args) ? r.args.map(String) : [];
    if (r.env && typeof r.env === "object") out.env = r.env as Record<string, string>;
    out.allowHosts = Array.isArray(r.allowHosts) ? r.allowHosts.map(String) : [];
  }
  return out;
}

function readFile(): McpFile {
  const path = mcpConfigPath();
  let servers: McpServerConfig[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed?.servers)) {
        servers = parsed.servers.map(normalise).filter((s: McpServerConfig | null): s is McpServerConfig => !!s);
      }
    } catch {
      /* corrupt file → treat as empty; a write will replace it */
    }
  }
  // First-run seed from the env var (does not overwrite an existing file).
  if (servers.length === 0 && config.mcpServersSeed) {
    try {
      const seed = JSON.parse(config.mcpServersSeed);
      if (Array.isArray(seed)) {
        servers = seed.map(normalise).filter((s: McpServerConfig | null): s is McpServerConfig => !!s);
      }
    } catch {
      /* bad seed → ignore */
    }
  }
  return { servers };
}

export function listMcpServers(): McpServerConfig[] {
  return readFile().servers;
}

/** Servers visible to a user: family-scoped + their own user-scoped ones. */
export function mcpServersForUser(userId: string): McpServerConfig[] {
  return listMcpServers().filter((s) => (s.scope ?? "family") === "family" || s.scope === `user:${userId}`);
}

export function getMcpServer(name: string): McpServerConfig | undefined {
  return listMcpServers().find((s) => s.name === name);
}

function write(servers: McpServerConfig[]): void {
  const path = mcpConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ servers }, null, 2));
}

export function upsertMcpServer(input: McpServerConfig): McpServerConfig {
  const clean = normalise(input);
  if (!clean) throw new Error(`Invalid MCP server config (name must be lowercase letters/digits/hyphens).`);
  if (clean.transport === "http" && !/^https?:\/\//i.test(clean.url ?? "")) {
    throw new Error("An http MCP server needs a full http(s) URL.");
  }
  if (clean.transport === "stdio" && !clean.command) {
    throw new Error("A stdio MCP server needs a command to run.");
  }
  const servers = listMcpServers();
  const i = servers.findIndex((s) => s.name === clean.name);
  if (i >= 0) servers[i] = clean;
  else servers.push(clean);
  write(servers);
  return clean;
}

export function setMcpServerEnabled(name: string, enabled: boolean): McpServerConfig | undefined {
  const servers = listMcpServers();
  const s = servers.find((x) => x.name === name);
  if (!s) return undefined;
  s.enabled = enabled;
  write(servers);
  return s;
}

export function deleteMcpServer(name: string): boolean {
  const servers = listMcpServers();
  const next = servers.filter((s) => s.name !== name);
  if (next.length === servers.length) return false;
  write(next);
  return true;
}

/** Config with secrets scrubbed — for the client / API. */
export function redactMcpServer(s: McpServerConfig): McpServerConfig {
  const red = { ...s };
  if (red.headers) {
    red.headers = Object.fromEntries(
      Object.keys(red.headers).map((k) => [k, /auth|key|token|secret/i.test(k) ? "••••" : red.headers![k]])
    );
  }
  if (red.env) {
    red.env = Object.fromEntries(
      Object.keys(red.env).map((k) => [k, /key|token|secret|password/i.test(k) ? "••••" : red.env![k]])
    );
  }
  return red;
}
