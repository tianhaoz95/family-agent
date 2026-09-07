import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The egress chokepoint rule: nothing in agent-core makes an outbound request
// to a non-localhost host EXCEPT the modules under src/web/. Everything else
// (Ollama, the tools server) talks to 127.0.0.1. See docs/DECISIONS.md → "Web
// access". A new `fetch("https://…")` outside src/web/ should fail this test.

const SRC = new URL("../src/", import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

// A fetch/request call is fine if its URL argument mentions any of these —
// they're all provably loopback or an operator-configured Ollama address.
const LOCAL_HINTS = ["127.0.0.1", "localhost", "ollamaBaseUrl", "baseUrl", "${port}", "${realPort}", "${config.toolsPort}"];

describe("outbound-request chokepoint", () => {
  const files = walk(SRC).filter((f) => !f.includes("/web/"));

  it("no module outside src/web/ fetches a hard-coded remote URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Match fetch("http…") / fetch(`http…`) / .request("http…")
      const re = /\b(?:fetch|request)\s*\(\s*[`"']https?:\/\/([^`"'\s)]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = text.lastIndexOf("\n", m.index) + 1;
        const line = text.slice(start, text.indexOf("\n", m.index));
        if (!LOCAL_HINTS.some((h) => line.includes(h))) {
          offenders.push(`${file.replace(SRC, "src/")}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
