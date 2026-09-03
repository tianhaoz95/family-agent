import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toolsDir } from "../config.js";

// Read-only inspector for a "server"-kind tool's private SQLite database.
//
// Every server tool persists to exactly one file — `<dataDir>/tools/<id>/data/
// tool.db` (see tools/harness.ts) — always with the same baseline shape (a
// `_kv` table plus whatever the handler's own `CREATE TABLE`s made). agent-core
// runs as a normal Node process with full disk access (the deny-by-default
// sandbox only constrains the *Deno* backend), so it can open that file
// directly rather than proxying through the tool's HTTP server.
//
// The one hard safety rule: the connection is opened `readOnly`, so nothing
// here — not a browsed table, not an ad-hoc query — can ever mutate a tool's
// data. The SQL allow-list in `query()` is defence-in-depth on top of that,
// mostly so a rejected write gets a friendly error instead of a raw SQLITE_*.

const DEFAULT_LIMIT = 50;
const MAX_ROWS = 500;
/** Longest BLOB prefix rendered as hex before it's just reported by size. */
const BLOB_PREVIEW_BYTES = 24;

export class ToolDbMissing extends Error {
  constructor() {
    super("this tool has no database yet");
    this.name = "ToolDbMissing";
  }
}

export class BadIdentifier extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadIdentifier";
  }
}

export class NotReadOnlySql extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotReadOnlySql";
  }
}

export interface ColumnInfo {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
}

export interface TableSummary {
  name: string;
  type: "table" | "view";
  rowCount: number | null;
  columns: ColumnInfo[];
  sql: string | null;
}

export interface StateEntry {
  key: string;
  bytes: number;
}

export interface DbOverview {
  exists: boolean;
  sizeBytes: number | null;
  tables: TableSummary[];
  /** Static tools only — one entry per `data/<key>.json` state blob. */
  stateEntries: StateEntry[];
}

export interface RowPage {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export function toolDbPath(toolId: string): string {
  return join(toolsDir(), toolId, "data", "tool.db");
}

export function toolDbExists(toolId: string): boolean {
  return existsSync(toolDbPath(toolId));
}

function open(toolId: string): DatabaseSync {
  const path = toolDbPath(toolId);
  if (!existsSync(path)) throw new ToolDbMissing();
  const db = new DatabaseSync(path, { readOnly: true });
  // A running tool backend may briefly hold a write lock; wait it out rather
  // than failing the request with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

/** `"` + escaped identifier — makes interpolation into SQL injection-safe. */
function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Turn a raw SQLite value into something that survives JSON.stringify. */
function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value.subarray(0, BLOB_PREVIEW_BYTES)).toString("hex");
    return {
      __blob: true,
      bytes: value.byteLength,
      preview: hex + (value.byteLength > BLOB_PREVIEW_BYTES ? "…" : ""),
    };
  }
  return value;
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = serialize(v);
  return out;
}

function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  try {
    const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
      name: string;
      type: string | null;
      pk: number;
      notnull: number;
    }>;
    return info.map((c) => ({
      name: c.name,
      type: (c.type ?? "").toUpperCase(),
      pk: !!c.pk,
      notNull: !!c.notnull,
    }));
  } catch {
    return [];
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Schema + row counts for every user table and view in the tool's database. */
export function overview(toolId: string): DbOverview {
  const path = toolDbPath(toolId);
  if (!existsSync(path)) return { exists: false, sizeBytes: null, tables: [], stateEntries: [] };
  const db = open(toolId);
  try {
    const master = db
      .prepare(
        "SELECT name, type, sql FROM sqlite_master " +
          "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' " +
          "ORDER BY type = 'view', name",
      )
      .all() as Array<{ name: string; type: "table" | "view"; sql: string | null }>;

    const tables: TableSummary[] = master.map((m) => {
      const columns = columnsOf(db, m.name);
      let rowCount: number | null = null;
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(m.name)}`).get() as { n: number };
        rowCount = Number(r.n);
      } catch {
        rowCount = null;
      }
      return { name: m.name, type: m.type, rowCount, columns, sql: m.sql };
    });

    return { exists: true, sizeBytes: sizeOf(path), tables, stateEntries: [] };
  } finally {
    db.close();
  }
}

/** The `data/` dir where a static tool's `/__state` blobs are kept as JSON. */
function staticDataDir(toolId: string): string {
  return join(toolsDir(), toolId, "data");
}

/**
 * A static (non-server) tool has no SQLite db — it persists through
 * `GET/PUT /<id>/__state`, which the tools server writes as one
 * `data/<key>.json` file per key (see tools/server.ts). List them so the same
 * "Inspect data" view works for every tool, not just server ones.
 */
export function staticOverview(toolId: string): DbOverview {
  const dir = staticDataDir(toolId);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    /* no data/ dir — tool never saved anything */
  }
  const stateEntries: StateEntry[] = names
    .map((n) => ({ key: n.slice(0, -5), bytes: sizeOf(join(dir, n)) ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const sizeBytes = stateEntries.reduce((sum, e) => sum + e.bytes, 0);
  return { exists: stateEntries.length > 0, sizeBytes: stateEntries.length ? sizeBytes : null, tables: [], stateEntries };
}

/** The parsed JSON value of one static-tool state key. */
export function staticStateValue(toolId: string, key: string): unknown {
  const safe = String(key).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "state";
  const file = join(staticDataDir(toolId), `${safe}.json`);
  if (!existsSync(file)) throw new BadIdentifier(`no such state key: ${key}`);
  try {
    return JSON.parse(readFileSync(file, "utf8") || "null");
  } catch {
    // A malformed blob — hand back the raw text rather than 500.
    return readFileSync(file, "utf8");
  }
}

/** One page of rows from a single table, with an optional sort. */
export function page(
  toolId: string,
  table: string,
  opts: { limit?: number; offset?: number; orderBy?: string; dir?: "asc" | "desc" } = {},
): RowPage {
  const db = open(toolId);
  try {
    const columns = columnsOf(db, table);
    if (columns.length === 0) throw new BadIdentifier(`no such table: ${table}`);

    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_ROWS);
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

    let orderSql = "";
    if (opts.orderBy) {
      if (!columns.some((c) => c.name === opts.orderBy)) {
        throw new BadIdentifier(`no such column: ${opts.orderBy}`);
      }
      orderSql = ` ORDER BY ${quoteIdent(opts.orderBy)} ${opts.dir === "desc" ? "DESC" : "ASC"}`;
    }

    const total = Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n,
    );
    const rows = (
      db.prepare(`SELECT * FROM ${quoteIdent(table)}${orderSql} LIMIT ? OFFSET ?`).all(limit, offset) as Array<
        Record<string, unknown>
      >
    ).map(mapRow);

    return { table, columns, rows, total, limit, offset };
  } finally {
    db.close();
  }
}

/** Run a single read-only statement typed by the user. */
export function query(toolId: string, sql: string): QueryResult {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with|explain|pragma)\b/i.test(trimmed)) {
    throw new NotReadOnlySql("only SELECT / WITH / EXPLAIN / PRAGMA queries are allowed");
  }
  if (trimmed.includes(";")) {
    throw new NotReadOnlySql("only a single statement is allowed");
  }

  const db = open(toolId);
  try {
    const stmt = db.prepare(trimmed);
    let all: Array<Record<string, unknown>>;
    try {
      all = stmt.all() as Array<Record<string, unknown>>;
    } catch (e) {
      // A syntax error, or a write blocked by the read-only connection.
      throw new NotReadOnlySql(e instanceof Error ? e.message : String(e));
    }
    const truncated = all.length > MAX_ROWS;
    const rows = all.slice(0, MAX_ROWS).map(mapRow);

    let columns: string[] = [];
    try {
      columns = (stmt.columns() as Array<{ name: string | null }>).map((c, i) => c.name ?? `col${i + 1}`);
    } catch {
      columns = rows.length ? Object.keys(rows[0]) : [];
    }

    return { columns, rows, rowCount: rows.length, truncated };
  } finally {
    db.close();
  }
}
