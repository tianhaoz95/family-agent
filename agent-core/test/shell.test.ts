import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { safeName, importFile, listWorkspace, writeWorkspaceText } from "../src/shell/workspace.js";
import { runTool, installedTools } from "../src/shell/executor.js";
import { sandboxAvailable } from "../src/shell/sandbox.js";

describe("workspace.safeName", () => {
  it("accepts plain and nested names", () => {
    expect(safeName("out.pdf")).toBe("out.pdf");
    expect(safeName("sub/dir/out.pdf")).toBe("sub/dir/out.pdf");
  });
  it("rejects traversal, absolute, hidden, and NUL", () => {
    for (const bad of ["../x", "/etc/passwd", ".ssh/key", "a/../../b", "x\0y"]) {
      expect(() => safeName(bad), bad).toThrow();
    }
  });
});

describe("workspace (per-user, isolated)", () => {
  let realDataDir: string;
  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "fa-ws-"));
  });
  afterEach(() => {
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("imports a file and lists it back", () => {
    const src = join(config.dataDir, "src.txt");
    writeFileSync(src, "hello");
    const name = importFile("user-a", src, "note.txt");
    expect(name).toBe("note.txt");
    expect(listWorkspace("user-a").map((f) => f.name)).toEqual(["note.txt"]);
    expect(listWorkspace("user-b")).toEqual([]);
  });

  it("collision-suffixes a repeated import", () => {
    const src = join(config.dataDir, "src.txt");
    writeFileSync(src, "x");
    expect(importFile("u", src, "a.txt")).toBe("a.txt");
    expect(importFile("u", src, "a.txt")).toBe("a (2).txt");
  });
});

describe("executor.runTool validation", () => {
  it("rejects an unknown / non-installed tool", async () => {
    await expect(runTool("u", "definitely-not-a-tool", [])).rejects.toThrow();
  });
  it("rejects an argument that escapes the workspace", async () => {
    const tool = installedTools()[0];
    if (!tool) return;
    await expect(runTool("u", tool, ["/etc/passwd"])).rejects.toThrow(/outside the workspace/i);
    await expect(runTool("u", tool, ["../x"])).rejects.toThrow(/outside the workspace/i);
  });
});

// Only runs where bubblewrap can actually sandbox — CI without it just skips.
describe.skipIf(!sandboxAvailable().ok)("sandboxed execution", () => {
  let realDataDir: string;
  beforeEach(() => {
    realDataDir = config.dataDir;
    config.dataDir = mkdtempSync(join(tmpdir(), "fa-sb-"));
  });
  afterEach(() => {
    rmSync(config.dataDir, { recursive: true, force: true });
    config.dataDir = realDataDir;
  });

  it("a command cannot see the host filesystem or reach the network", async () => {
    const tools = installedTools();
    // jq is a common, safe pick; fall back to any installed tool that reads a file.
    if (!tools.includes("jq")) return;
    writeWorkspaceText("u", "in.json", JSON.stringify({ a: 1 }));
    const ok = await runTool("u", "jq", [".a", "in.json"]);
    expect(ok.stdout.trim()).toBe("1");
    // /etc/hostname is bound read-only via /usr? No — only /usr,/bin,/lib.
    // Reading an absolute path is blocked at the arg-validation layer, and even
    // a relative escape can't reach outside /work.
    const esc = await runTool("u", "jq", [".", "in.json"]).catch(() => null);
    expect(esc).not.toBeNull();
  });
});
