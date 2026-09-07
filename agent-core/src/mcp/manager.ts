import { config } from "../config.js";
import { McpConnection, type McpToolDef } from "./client.js";
import { getMcpServer, listMcpServers, mcpServersForUser, type McpServerConfig } from "./config.js";

// Owns one live MCP connection per configured, enabled server and aggregates
// their tools for the `connections-agent` subagent. Tool lists are cached and
// refreshed lazily; a failing server degrades to "no tools" rather than
// breaking the agent. Process-wide, like ToolSupervisor / RoutineScheduler.

export interface McpToolEntry {
  server: string;
  tool: McpToolDef;
}

interface Cached {
  conn: McpConnection;
  tools: McpToolDef[];
  fetchedAt: number;
  error?: string;
}

const TTL_MS = 5 * 60_000;

export class McpManager {
  private byServer = new Map<string, Cached>();

  enabled(): boolean {
    return config.mcpEnabled;
  }

  /** All server configs, for /health and the admin UI (unredacted — the route redacts). */
  servers(): McpServerConfig[] {
    return listMcpServers();
  }

  private async ensure(cfg: McpServerConfig, force = false): Promise<Cached> {
    const existing = this.byServer.get(cfg.name);
    if (existing && !force && Date.now() - existing.fetchedAt < TTL_MS && !existing.error) return existing;
    if (existing) existing.conn.close();
    const conn = new McpConnection(cfg);
    const entry: Cached = { conn, tools: [], fetchedAt: Date.now() };
    try {
      entry.tools = await conn.listTools();
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    this.byServer.set(cfg.name, entry);
    return entry;
  }

  /** Tools from every enabled server visible to this user. Best-effort — a
   *  server that won't connect contributes nothing. */
  async toolsForUser(userId: string): Promise<McpToolEntry[]> {
    if (!config.mcpEnabled) return [];
    const out: McpToolEntry[] = [];
    await Promise.all(
      mcpServersForUser(userId)
        .filter((s) => s.enabled)
        .map(async (cfg) => {
          const c = await this.ensure(cfg);
          for (const t of c.tools) out.push({ server: cfg.name, tool: t });
        })
    );
    return out;
  }

  async callTool(
    userId: string,
    server: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    if (!config.mcpEnabled) return { ok: false, error: "MCP is turned off on this server." };
    const cfg = mcpServersForUser(userId).find((s) => s.name === server && s.enabled);
    if (!cfg) return { ok: false, error: `No connected MCP server called "${server}".` };
    const c = await this.ensure(cfg);
    const raw = await c.conn.callTool(tool, args);
    if (!raw.ok) return raw;
    return { ok: true, value: clamp(raw.value) };
  }

  /** Connect + list once, for a "test this server" button / startup probe. */
  async probe(name: string): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const cfg = getMcpServer(name);
    if (!cfg) return { ok: false, error: "no such server" };
    const c = await this.ensure(cfg, true);
    return c.error ? { ok: false, error: c.error } : { ok: true, toolCount: c.tools.length };
  }

  /** Drop cached connections so the next call reconnects (config changed). */
  invalidate(name?: string): void {
    if (name) {
      this.byServer.get(name)?.conn.close();
      this.byServer.delete(name);
    } else {
      for (const c of this.byServer.values()) c.conn.close();
      this.byServer.clear();
    }
  }

  stopAll(): void {
    this.invalidate();
  }
}

function clamp(value: unknown): unknown {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "(result could not be serialised)";
  }
  if (text.length <= config.mcpMaxResultChars) return value;
  return text.slice(0, config.mcpMaxResultChars) + "\n…(truncated)";
}
