import { spawnSync } from "node:child_process";
import { config } from "../config.js";
import { runSandboxed, type SandboxResult } from "./sandbox.js";
import { ensureWorkspace, listWorkspace } from "./workspace.js";

// The curated set of command-line tools the workshop agent may run. The model
// never gets a shell — it names a tool and an argv array (no pipes, no
// metacharacters, nothing is interpreted). Only tools actually installed on
// the host are advertised; an admin can add more with FAMILY_AGENT_SHELL_ALLOW.

interface CuratedTool {
  /** apt/dnf package that provides it — shown in the "not installed" message. */
  pkg: string;
  what: string;
}

export const CURATED_TOOLS: Record<string, CuratedTool> = {
  // PDF
  qpdf: { pkg: "qpdf", what: "merge / split / rotate / decrypt PDFs" },
  pdftk: { pkg: "pdftk-java", what: "assemble and stamp PDFs" },
  pdfunite: { pkg: "poppler-utils", what: "concatenate PDFs" },
  pdfseparate: { pkg: "poppler-utils", what: "burst a PDF into pages" },
  pdftoppm: { pkg: "poppler-utils", what: "render PDF pages to images" },
  pdftotext: { pkg: "poppler-utils", what: "pull the text layer out of a PDF" },
  pdfinfo: { pkg: "poppler-utils", what: "read PDF metadata / page count" },
  gs: { pkg: "ghostscript", what: "compress / convert PDFs" },
  ocrmypdf: { pkg: "ocrmypdf", what: "add a searchable text layer to a scanned PDF" },
  // images
  convert: { pkg: "imagemagick", what: "convert / resize / rotate images" },
  magick: { pkg: "imagemagick", what: "convert / resize / rotate images" },
  mogrify: { pkg: "imagemagick", what: "batch image edits in place" },
  identify: { pkg: "imagemagick", what: "read image dimensions / format" },
  jpegtran: { pkg: "libjpeg-turbo-progs", what: "lossless JPEG rotate / crop" },
  exiftool: { pkg: "libimage-exiftool-perl", what: "read / strip photo metadata" },
  "heif-convert": { pkg: "libheif-examples", what: "convert HEIC photos to JPG" },
  // audio / video
  ffmpeg: { pkg: "ffmpeg", what: "convert / trim / compress audio and video" },
  ffprobe: { pkg: "ffmpeg", what: "inspect a media file" },
  // documents
  pandoc: { pkg: "pandoc", what: "convert between doc formats (md, docx, html…)" },
  soffice: { pkg: "libreoffice", what: "convert office documents (headless)" },
  libreoffice: { pkg: "libreoffice", what: "convert office documents (headless)" },
  // data
  jq: { pkg: "jq", what: "query / reshape JSON" },
  csvcut: { pkg: "csvkit", what: "select CSV columns" },
  csvstat: { pkg: "csvkit", what: "summary stats for a CSV" },
  csvgrep: { pkg: "csvkit", what: "filter CSV rows" },
  csvjson: { pkg: "csvkit", what: "CSV → JSON" },
  in2csv: { pkg: "csvkit", what: "xls / json → CSV" },
  xsv: { pkg: "xsv", what: "fast CSV slicing / stats" },
  qsv: { pkg: "qsv", what: "fast CSV slicing / stats" },
  // archives / misc
  zip: { pkg: "zip", what: "make a .zip" },
  unzip: { pkg: "unzip", what: "extract a .zip" },
  tar: { pkg: "tar", what: "make / extract tar archives" },
  "7z": { pkg: "p7zip-full", what: "make / extract 7z / many archive formats" },
  tesseract: { pkg: "tesseract-ocr", what: "OCR an image to text" },
  iconv: { pkg: "libc-bin", what: "convert text encodings" },
};

let installedCache: string[] | undefined;

/** The subset of CURATED_TOOLS (plus config.shellAllow) present on the host. */
export function installedTools(): string[] {
  if (installedCache) return installedCache;
  const names = [...new Set([...Object.keys(CURATED_TOOLS), ...config.shellAllow])];
  installedCache = names.filter((n) => {
    if (n.includes("/") || !/^[\w.+-]+$/.test(n)) return false;
    return spawnSync("sh", ["-c", `command -v ${n}`], { timeout: 3000 }).status === 0;
  });
  return installedCache;
}

export function toolCatalogText(): string {
  const have = new Set(installedTools());
  const lines = Object.entries(CURATED_TOOLS)
    .filter(([n]) => have.has(n))
    .map(([n, t]) => `  ${n} — ${t.what}`);
  for (const extra of config.shellAllow) if (have.has(extra) && !CURATED_TOOLS[extra]) lines.push(`  ${extra}`);
  return lines.join("\n");
}

export interface RunOutcome extends SandboxResult {
  changedFiles: string[];
}

function argIsSuspicious(arg: string): boolean {
  if (arg.includes("\0")) return true;
  // A path-looking arg must stay inside the workspace.
  if (arg.startsWith("/") || arg.startsWith("~")) return true;
  if (arg.split("/").some((p) => p === "..")) return true;
  return false;
}

/** Run one curated tool against the user's workspace. */
export async function runTool(userId: string, toolName: string, args: string[]): Promise<RunOutcome> {
  if (!/^[\w.+-]+$/.test(toolName) || !installedTools().includes(toolName)) {
    const known = CURATED_TOOLS[toolName];
    throw new Error(
      known
        ? `"${toolName}" isn't installed on this server (install the "${known.pkg}" package).`
        : `"${toolName}" is not an allowed tool. Use list_tools to see what's available.`
    );
  }
  if (args.length > 64) throw new Error("Too many arguments.");
  for (const a of args) {
    if (typeof a !== "string") throw new Error("Every argument must be a string.");
    if (argIsSuspicious(a)) throw new Error(`Argument "${a}" points outside the workspace — use plain file names.`);
  }
  const dir = ensureWorkspace(userId);
  const before = snapshot(userId);
  const result = await runSandboxed([toolName, ...args], dir);
  return { ...result, changedFiles: diff(before, snapshot(userId)) };
}

/** Unrestricted mode: arbitrary bash, still sandboxed + network-free. */
export async function runShellScript(userId: string, script: string): Promise<RunOutcome> {
  if (!config.shellUnrestricted) throw new Error("Unrestricted shell is not enabled on this server.");
  if (script.length > 8000) throw new Error("Script too long.");
  const dir = ensureWorkspace(userId);
  const before = snapshot(userId);
  const result = await runSandboxed(["bash", "-lc", script], dir);
  return { ...result, changedFiles: diff(before, snapshot(userId)) };
}

function snapshot(userId: string): Map<string, number> {
  return new Map(listWorkspace(userId).map((f) => [f.name, f.modifiedMs]));
}
function diff(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [name, mtime] of after) if (before.get(name) !== mtime) changed.push(name);
  return changed.sort();
}
