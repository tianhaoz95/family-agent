import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { config } from "../config.js";
import { sandboxAvailable } from "../shell/sandbox.js";
import { existsSync } from "node:fs";
import type { McpServerConfig } from "./config.js";

// A minimal Model Context Protocol client — hand-rolled JSON-RPC 2.0, same as
// tools/toolMcp.ts does for the family's own generated tools. Two transports:
//
//  http  — Streamable HTTP (spec 2025-06-18): POST the request, read either a
//          direct application/json response or a text/event-stream carrying
//          the response. An Mcp-Session-Id from initialize rides along after.
//          This is a NEW egress point (an admin-configured URL) — see
//          docs/DECISIONS.md → "Skills and MCP".
//  stdio — spawn the command inside the bubblewrap sandbox (network blocked
//          except allowHosts), speak newline-delimited JSON-RPC over its pipes.

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "family-agent", version: "1" };

// ---- shared ------------------------------------------------------------

interface Transport {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export class McpConnection {
  private transport: Transport | null = null;
  private initialised = false;

  constructor(private cfg: McpServerConfig) {}

  private async ensure(): Promise<Transport> {
    if (this.transport && this.initialised) return this.transport;
    this.transport = this.cfg.transport === "stdio" ? new StdioTransport(this.cfg) : new HttpTransport(this.cfg);
    await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // The spec wants an "initialized" notification; most servers tolerate its
    // absence, and our transports don't model notifications. Skip it.
    this.initialised = true;
    return this.transport;
  }

  async listTools(): Promise<McpToolDef[]> {
    const t = await this.ensure();
    const res = (await t.request("tools/list", {})) as { tools?: McpToolDef[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    try {
      const t = await this.ensure();
      const res = (await t.request("tools/call", { name, arguments: args })) as {
        content?: { type: string; text?: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text = (res.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      const value = res.structuredContent ?? text ?? res.content ?? null;
      return res.isError ? { ok: false, error: text || "the tool reported an error" } : { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
    this.initialised = false;
  }
}

// ---- HTTP transport --------------------------------------------------

class HttpTransport implements Transport {
  private seq = 0;
  private sessionId: string | null = null;
  constructor(private cfg: McpServerConfig) {
    if (!/^https?:\/\//i.test(cfg.url ?? "")) throw new Error("MCP http server has no URL");
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
      signal: AbortSignal.timeout(config.mcpCallTimeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} from ${this.cfg.name}`);

    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = ctype.includes("text/event-stream")
      ? await parseSseForId(await res.text(), id)
      : ((await res.json()) as JsonRpcResponse);
    if (!body) throw new Error(`no JSON-RPC response for ${method} from ${this.cfg.name}`);
    if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
    return body.result;
  }
  close(): void {
    /* stateless per request; nothing to tear down */
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

async function parseSseForId(sse: string, id: number): Promise<JsonRpcResponse | null> {
  for (const block of sse.split(/\n\n+/)) {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    try {
      const msg = JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      if (msg.id === id) return msg;
    } catch {
      /* not JSON — skip */
    }
  }
  return null;
}

// ---- stdio transport (sandboxed) ------------------------------------

function resolveBwrap(): string | null {
  for (const c of [config.bwrapPath, "/usr/bin/bwrap", "/bin/bwrap"].filter(Boolean)) {
    if (existsSync(c)) return c;
  }
  return null;
}

class StdioTransport implements Transport {
  private proc: ChildProcessWithoutNullStreams;
  private seq = 0;
  private buf = "";
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(cfg: McpServerConfig) {
    const sb = sandboxAvailable();
    if (!sb.ok) throw new Error(`stdio MCP needs the bubblewrap sandbox (${sb.reason})`);
    const bin = resolveBwrap()!;
    // No network at all unless allowHosts is set — then a slirp-less bwrap
    // can't do per-host filtering, so we fall back to sharing the net namespace
    // ONLY when the admin opted in with allowHosts. Otherwise --unshare-all.
    const netArgs = (cfg.allowHosts?.length ?? 0) > 0 ? ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"] : ["--unshare-all"];
    const roBinds = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/ssl", "/etc/ca-certificates", "/etc/resolv.conf", "/etc/hosts", "/opt"];
    const bwrapArgs = [...netArgs, "--die-with-parent", "--new-session"];
    for (const p of roBinds) if (existsSync(p)) bwrapArgs.push("--ro-bind", p, p);
    bwrapArgs.push(
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--tmpfs", "/work",
      "--chdir", "/work",
      "--clearenv",
      "--setenv", "PATH", "/usr/bin:/bin:/usr/local/bin",
      "--setenv", "HOME", "/work",
    );
    for (const [k, v] of Object.entries(cfg.env ?? {})) bwrapArgs.push("--setenv", k, String(v));
    bwrapArgs.push("--", cfg.command!, ...(cfg.args ?? []));

    this.proc = spawn(bin, bwrapArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (c: Buffer) => this.onData(c));
    this.proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("MCP stdio process exited"));
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
      } catch {
        /* not a JSON-RPC line (log noise) — ignore */
      }
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio timeout for ${method}`));
      }, config.mcpCallTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    });
  }

  close(): void {
    try {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
