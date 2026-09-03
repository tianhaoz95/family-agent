// On-disk storage for uploaded document originals.
//
// Uploads keep their bytes so the client can preview the real file (PDF
// viewer / image), not just the extracted text. Those bytes live at
// `<dataDir>/documents/<userId>/<name>` where `<name>` is the document's own
// filename — sanitized to one safe path segment, extension kept, with a
// " (2)" suffix when another file in the folder already has that name. The
// chosen basename is stored in `documents.original_disk_name` because it can't
// be derived from the id anymore.
//
// Watched-folder documents are NOT handled here — they're served straight from
// their `source_path` in the user's inbox and never copied. Pasted-text
// documents have no original at all.

import { readdir, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { documentsDir } from "./config.js";
import type { Store } from "./db.js";

export function userDocumentsDir(userId: string): string {
  return join(documentsDir(), userId);
}

/** Reduce an in-app filename to something usable as a single path segment:
 *  drop directory parts and characters that break a filesystem, collapse
 *  whitespace, strip leading/trailing dots (no hidden files, no ".."), keep a
 *  plausible extension, and cap the length. Never returns "". */
export function sanitizeDiskName(filename: string): string {
  const flat = basename(String(filename)).replace(/[\\/]+/g, "_");
  let ext = extname(flat).toLowerCase();
  // A long "extension" is really just a dot inside the name (e.g. "v1.2 notes").
  if (ext.length > 12 || !/^\.[a-z0-9]+$/.test(ext)) ext = "";
  let stem = (ext ? flat.slice(0, -ext.length) : flat)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!stem) stem = "document";
  if (stem.length > 120) stem = stem.slice(0, 120).trim();
  return stem + ext;
}

/** A basename inside `dir` that no existing file uses, appending " (2)",
 *  " (3)", … before the extension. `keep`, if given, is a basename to treat as
 *  free — the file that's about to be moved out of the way. */
async function uniqueInDir(dir: string, desired: string, keep?: string): Promise<string> {
  let taken: Set<string>;
  try {
    taken = new Set(await readdir(dir));
  } catch {
    return desired; // folder doesn't exist yet → nothing to collide with
  }
  if (keep) taken.delete(keep);
  if (!taken.has(desired)) return desired;
  const ext = extname(desired);
  const stem = ext ? desired.slice(0, -ext.length) : desired;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Write an uploaded original under documents/<userId>/, named after the
 *  document's filename (collision-suffixed if needed). Returns the on-disk
 *  basename to persist in `original_disk_name`. */
export async function storeOriginalUpload(
  userId: string,
  filename: string,
  bytes: Buffer
): Promise<string> {
  const dir = userDocumentsDir(userId);
  await mkdir(dir, { recursive: true });
  const name = await uniqueInDir(dir, sanitizeDiskName(filename));
  await writeFile(join(dir, name), bytes);
  return name;
}

/** Move a document's stored original so its name tracks a rename. `currentName`
 *  is what's in `original_disk_name` (or the doc id, for a not-yet-migrated
 *  legacy upload). Returns the new basename, or null when there was no file on
 *  disk to move (pasted text, watched-folder doc, or a failed earlier write). */
export async function renameOriginal(
  userId: string,
  currentName: string,
  newFilename: string
): Promise<string | null> {
  const dir = userDocumentsDir(userId);
  const from = join(dir, currentName);
  try {
    if (!(await stat(from)).isFile()) return null;
  } catch {
    return null;
  }
  const target = await uniqueInDir(dir, sanitizeDiskName(newFilename), currentName);
  if (target === currentName) return currentName;
  await rename(from, join(dir, target));
  return target;
}

/** Best-effort delete of a stored original (called when the document is
 *  deleted). A null/missing name is a no-op. */
export async function deleteOriginal(userId: string, name: string | null): Promise<void> {
  if (!name) return;
  await rm(join(userDocumentsDir(userId), name), { force: true }).catch(() => {});
}

/** Resolve where a document's original bytes are: the tracked disk name first,
 *  then the legacy documents/<userId>/<docId> path, then the watched-folder
 *  source. null when none of those is a real file (e.g. pasted text). */
export async function resolveOriginalPath(
  userId: string,
  docId: string,
  diskName: string | null,
  sourcePath: string | null
): Promise<string | null> {
  const dir = userDocumentsDir(userId);
  const candidates = [
    diskName ? join(dir, diskName) : null,
    join(dir, docId),
    sourcePath || null,
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** One-time backfill: rename every legacy `<docId>` original to the document's
 *  real filename and record it in `original_disk_name`, so an operator
 *  browsing the documents folder sees recognizable files. Idempotent — it only
 *  touches uploads still sitting at the old `<docId>` path. Runs at startup. */
export async function backfillOriginalDiskNames(store: Store): Promise<void> {
  for (const user of store.listUsers()) {
    const scoped = store.scoped(user.id);
    const dir = userDocumentsDir(user.id);
    for (const doc of scoped.listDocuments()) {
      if (doc.originalDiskName) continue;
      const legacy = join(dir, doc.id);
      try {
        if (!(await stat(legacy)).isFile()) continue;
      } catch {
        continue;
      }
      try {
        const name = await uniqueInDir(dir, sanitizeDiskName(doc.filename), doc.id);
        if (name !== doc.id) await rename(legacy, join(dir, name));
        scoped.setDocumentOriginalDiskName(doc.id, name);
      } catch {
        // Leave it at <docId>; resolveOriginalPath() still finds it there.
      }
    }
  }
}
