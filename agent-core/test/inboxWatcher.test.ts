import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { startInboxWatcher } from "../src/inboxWatcher.js";
import { config } from "../src/config.js";

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
    const store = new Store(":memory:");
    const extractSpy = vi.spyOn(extraction, "extractDocument").mockResolvedValue(undefined);

    watcher = await startInboxWatcher(store, {} as any, dir);

    const txtPath = join(dir, "bill.txt");
    await writeFile(txtPath, "Amount due: $40");
    const binPath = join(dir, "photo.jpg");
    await writeFile(binPath, "not really a jpg");

    await vi.waitFor(
      () => {
        expect(store.listDocuments().some((d) => d.filename === "bill.txt")).toBe(true);
        expect(store.listActivity().some((a) => a.action === "document.skipped")).toBe(true);
      },
      { timeout: 5000, interval: 100 }
    );

    const docs = store.listDocuments();
    expect(docs).toHaveLength(1); // the .jpg was skipped, not ingested
    expect(docs[0].sourcePath).toBe(txtPath);
    expect(extractSpy).toHaveBeenCalledTimes(1);

    const skipped = store.listActivity().find((a) => a.action === "document.skipped");
    expect(skipped?.detail).toContain("photo.jpg");

    // Restarting the watcher against the same folder must not re-ingest.
    await watcher.close();
    watcher = await startInboxWatcher(store, {} as any, dir);
    await new Promise((r) => setTimeout(r, 800));
    expect(store.listDocuments()).toHaveLength(1);
  });

  it("creates the inbox directory if it doesn't exist yet", async () => {
    dir = join(await mkdtemp(join(tmpdir(), "family-agent-inbox-parent-")), "nested", "inbox");
    const store = new Store(":memory:");
    watcher = await startInboxWatcher(store, {} as any, dir);
    // No throw = directory got created; sanity-check it's actually there.
    const stats = await import("node:fs/promises").then((fs) => fs.stat(dir));
    expect(stats.isDirectory()).toBe(true);
  });
});

// Keep config's default inboxDir out of the way of these tests — sanity
// check it at least resolves to somewhere under the data dir, not / or cwd.
describe("config.inboxDir", () => {
  it("defaults under the data directory", () => {
    expect(config.inboxDir).toContain("data");
    expect(config.inboxDir.endsWith("inbox")).toBe(true);
  });
});
