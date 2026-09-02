import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { startInboxWatcher } from "../src/inboxWatcher.js";
import { config } from "../src/config.js";

// The watcher takes a per-user scoped store — give each test a fresh one.
function scopedMem() {
  const raw = new Store(":memory:");
  return raw.scoped(raw.createUser({ username: "u", displayName: "U", password: "sekret123" }).id);
}

// Model behavior is covered by test/agents.integration.test.ts; this test
// only needs to prove the watcher notices files and creates document rows
// with the right dedup/skip behavior, so it stubs extraction out rather than
// waiting on a live model — keeps this fast and deterministic.
import * as extraction from "../src/agents/extraction.js";
import { vi } from "vitest";

describe("inbox watcher", () => {
  let dir: string;
  let watcher: Awaited<ReturnType<typeof startInboxWatcher>> | undefined;

  afterEach(async () => {
    await watcher?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("ingests a .txt file dropped into the folder, skips unsupported types, avoids double-ingest", async () => {
    dir = await mkdtemp(join(tmpdir(), "family-agent-inbox-"));
    const store = scopedMem();
    const extractSpy = vi.spyOn(extraction, "extractDocument").mockResolvedValue(undefined);

    watcher = await startInboxWatcher(store, {} as any, dir);

    const txtPath = join(dir, "bill.txt");
    await writeFile(txtPath, "Amount due: $40");
    // .docx isn't in SUPPORTED_EXTENSIONS at all — genuinely unsupported,
    // as opposed to "named like a supported type but not really one" (see
    // the fake-photo test below, a real bug this test used to mask).
    const binPath = join(dir, "resume.docx");
    await writeFile(binPath, "not really a docx");

    await vi.waitFor(
      () => {
        expect(store.listDocuments().some((d) => d.filename === "bill.txt")).toBe(true);
        expect(store.listActivity().some((a) => a.action === "document.skipped")).toBe(true);
      },
      { timeout: 5000, interval: 100 }
    );

    const docs = store.listDocuments();
    expect(docs).toHaveLength(1); // the .docx was skipped, not ingested
    expect(docs[0].sourcePath).toBe(txtPath);
    expect(extractSpy).toHaveBeenCalledTimes(1);

    const skipped = store.listActivity().find((a) => a.action === "document.skipped");
    expect(skipped?.detail).toContain("resume.docx");

    // Restarting the watcher against the same folder must not re-ingest.
    await watcher.close();
    watcher = await startInboxWatcher(store, {} as any, dir);
    await new Promise((r) => setTimeout(r, 800));
    expect(store.listDocuments()).toHaveLength(1);
  });

  it("logs a read error (doesn't crash) for a file named .jpg that isn't really a jpg", async () => {
    // Regression test: tesseract.js can crash the whole process — not just
    // reject one promise — when fed bytes that aren't a real image. A file
    // extension lies about content often enough (this exact case: a
    // plain-text file some app or OS named .jpg) that this had to be
    // handled before OCR support could ship at all. See fileExtract.ts's
    // looksLikeImage magic-byte check.
    dir = await mkdtemp(join(tmpdir(), "family-agent-inbox-"));
    const store = scopedMem();
    vi.spyOn(extraction, "extractDocument").mockResolvedValue(undefined);

    watcher = await startInboxWatcher(store, {} as any, dir);
    await writeFile(join(dir, "fake-photo.jpg"), "not really a jpg, just text with a lying extension");

    await vi.waitFor(
      () => {
        expect(store.listActivity().some((a) => a.action === "document.read_error")).toBe(true);
      },
      { timeout: 5000, interval: 100 }
    );

    expect(store.listDocuments()).toHaveLength(0);
    const errorEntry = store.listActivity().find((a) => a.action === "document.read_error");
    expect(errorEntry?.detail).toContain("fake-photo.jpg");
  });

  it("creates the inbox directory if it doesn't exist yet", async () => {
    dir = join(await mkdtemp(join(tmpdir(), "family-agent-inbox-parent-")), "nested", "inbox");
    const store = scopedMem();
    watcher = await startInboxWatcher(store, {} as any, dir);
    // No throw = directory got created; sanity-check it's actually there.
    const stats = await import("node:fs/promises").then((fs) => fs.stat(dir));
    expect(stats.isDirectory()).toBe(true);
  });
});

// Sanity-check the per-user inbox base resolves somewhere under the data
// dir, not / or cwd.
describe("config.inboxBase", () => {
  it("defaults under the data directory", () => {
    expect(config.inboxBase).toContain("data");
    expect(config.inboxBase.endsWith("inbox")).toBe(true);
  });
});
