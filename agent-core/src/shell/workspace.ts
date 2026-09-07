import { mkdirSync, readdirSync, statSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { config, workspaceDir } from "../config.js";

// The per-user scratch directory the workshop agent's CLI tools operate in.
// Nothing outside it is writable by a sandboxed command, and imports are
// explicit — the model can't reach the document store or the inbox directly,
// only files it asked to bring in.

export interface WorkspaceFile {
  name: string;
  bytes: number;
  modifiedMs: number;
}

export function ensureWorkspace(userId: string): string {
  const dir = workspaceDir(userId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reject anything that isn't a plain filename (or `sub/dir/file`) inside the
 *  workspace — no `..`, no absolute paths, no leading dot. */
export function safeName(name: string): string {
  const n = name.trim();
  if (
    !n ||
    n.startsWith("/") ||
    n.startsWith("~") ||
    n.includes("..") ||
    n.includes("\0") ||
    n.includes("\\") ||
    n.split("/").some((p) => p.startsWith(".") || p === "")
  ) {
    throw new Error(`"${name}" is not a valid workspace file name.`);
  }
  return n;
}

export function listWorkspace(userId: string): WorkspaceFile[] {
  const dir = ensureWorkspace(userId);
  const out: WorkspaceFile[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(r);
      else {
        const st = statSync(join(dir, r));
        out.push({ name: r, bytes: st.size, modifiedMs: st.mtimeMs });
      }
    }
  };
  walk("");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function workspaceUsage(userId: string): number {
  return listWorkspace(userId).reduce((n, f) => n + f.bytes, 0);
}

export function readWorkspaceText(userId: string, name: string, maxChars = 20_000): string {
  const path = join(ensureWorkspace(userId), safeName(name));
  const buf = readFileSync(path);
  const text = buf.toString("utf8");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}

export function clearWorkspace(userId: string): void {
  rmSync(workspaceDir(userId), { recursive: true, force: true });
  ensureWorkspace(userId);
}

/** Copy an external file (a document's original, or an inbox file) in. Refuses
 *  once the workspace is over its size budget. Returns the name it landed as. */
export function importFile(userId: string, srcPath: string, preferredName?: string): string {
  const dir = ensureWorkspace(userId);
  if (workspaceUsage(userId) > config.workspaceMaxBytes) {
    throw new Error("The workspace is full — clear it before importing more files.");
  }
  let name = safeName(preferredName || basename(srcPath));
  let dest = join(dir, name);
  let i = 2;
  while (safeExists(dest)) {
    const ext = extname(name);
    name = `${name.slice(0, name.length - ext.length)} (${i})${ext}`;
    dest = join(dir, name);
    i++;
  }
  copyFileSync(srcPath, dest);
  return name;
}

export function writeWorkspaceText(userId: string, name: string, content: string): string {
  const dir = ensureWorkspace(userId);
  const n = safeName(name);
  writeFileSync(join(dir, n), content);
  return n;
}

/** Absolute path of a workspace file, verified to exist. */
export function workspacePath(userId: string, name: string): string {
  const p = join(ensureWorkspace(userId), safeName(name));
  if (!safeExists(p)) throw new Error(`"${name}" is not in the workspace.`);
  return p;
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
