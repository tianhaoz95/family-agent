import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPersistedSettings, persistSettings } from "../src/settingsFile.js";

describe("settingsFile", () => {
  const dirs: string[] = [];
  const freshDir = () => {
    const d = mkdtempSync(join(tmpdir(), "family-agent-settings-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns {} when there is no settings file", () => {
    expect(readPersistedSettings(freshDir())).toEqual({});
  });

  it("round-trips a value", () => {
    const dir = freshDir();
    persistSettings(dir, { ocrModel: "glm-ocr:latest" });
    expect(readPersistedSettings(dir)).toEqual({ ocrModel: "glm-ocr:latest" });
  });

  it("merges — writing one field does not drop the others", () => {
    const dir = freshDir();
    persistSettings(dir, { serverName: "The Nguyens" });
    persistSettings(dir, { ocrModel: "glm-ocr:latest" });
    expect(readPersistedSettings(dir)).toEqual({ serverName: "The Nguyens", ocrModel: "glm-ocr:latest" });
  });

  it("treats an empty string as a real value but undefined as leave-unchanged", () => {
    const dir = freshDir();
    persistSettings(dir, { serverName: "Home", ocrModel: "glm-ocr:latest" });
    persistSettings(dir, { ocrModel: "" }); // clear OCR model
    persistSettings(dir, { serverName: undefined }); // no-op
    expect(readPersistedSettings(dir)).toEqual({ serverName: "Home", ocrModel: "" });
  });

  it("ignores non-string junk in the file", () => {
    const dir = freshDir();
    persistSettings(dir, { serverName: "Home" });
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ serverName: 42, ocrModel: "ok" }));
    expect(readPersistedSettings(dir)).toEqual({ ocrModel: "ok" });
  });
});
