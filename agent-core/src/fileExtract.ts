import { extname } from "node:path";
import { mkdirSync } from "node:fs";
import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";
import { config } from "./config.js";

// Shared by both ingestion paths (POST /documents/upload and the inbox
// watcher) so "what file types does this app understand" is defined once.
export const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export class UnsupportedFileTypeError extends Error {
  constructor(ext: string) {
    super(`Unsupported file type: "${ext}"`);
    this.name = "UnsupportedFileTypeError";
  }
}

/**
 * Extracts plain text from a file's raw bytes, dispatching on extension.
 * Throws UnsupportedFileTypeError for anything outside SUPPORTED_EXTENSIONS.
 *
 * PDF support is text-layer only — a scanned PDF with no embedded text
 * layer will extract as empty/near-empty text, not OCR'd. Photos taken with
 * a phone camera or picked from a gallery go through OCR instead (that's
 * the actual "scan" path); a scanned-PDF-to-OCR pipeline would mean
 * rasterizing pages to images first, which is real future work, not
 * something silently half-done here.
 */
export async function extractText(filename: string, buffer: Buffer): Promise<string> {
  const ext = extname(filename).toLowerCase();
  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf8");
  }
  if (ext === ".pdf") {
    return extractPdfText(buffer);
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (!looksLikeImage(buffer, ext)) {
      throw new Error(`File has a ${ext} name but doesn't look like a real ${ext} image (bad magic bytes).`);
    }
    return extractImageText(buffer);
  }
  throw new UnsupportedFileTypeError(ext);
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    // pdf-parse inserts "-- N of M --" page-separator lines into the text;
    // pure noise for what this app does with the text (a small model
    // extracting fields), so strip them rather than pass them through.
    return result.text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, "").trim();
  } finally {
    await parser.destroy();
  }
}

// tesseract.js's Node worker doesn't always reject its recognize() promise
// cleanly when handed bytes that aren't actually a readable image — it can
// surface as an uncaught exception from the underlying worker thread
// instead, which no amount of try/catch around recognize() will stop.
// Reproduced directly: a .jpg-named file containing plain text crashed the
// whole process, not just that one request. Checking the file's magic
// bytes ourselves first turns that into an ordinary caught error.
function looksLikeImage(buffer: Buffer, ext: string): boolean {
  if (ext === ".png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === ".jpg" || ext === ".jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (ext === ".webp") return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

// OCR via tesseract.js. The English language model (~4MB) is fetched from a
// CDN on the very first OCR call and then cached under
// `<dataDir>/tessdata/` — cachePath is set explicitly rather than left at
// tesseract.js's default (the process's current working directory, which is
// an unpredictable place to silently write a cache file). Every OCR call
// after the first one is fully offline, reading from that local cache. This
// is the one deliberate exception to "nothing leaves the machine" in this
// codebase — flagged here and in docs/DECISIONS.md, not hidden.
async function extractImageText(buffer: Buffer): Promise<string> {
  const cachePath = `${config.dataDir}/tessdata`;
  // tesseract.js's Node cache writer is a plain fs.writeFile — it doesn't
  // create the directory itself, and fails (silently swallowed upstream)
  // if it's missing. Confirmed by testing: without this, nothing ever got
  // cached and every OCR call re-downloaded from the CDN.
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker("eng", undefined, { cachePath });
  try {
    const {
      data: { text },
    } = await worker.recognize(buffer);
    return text;
  } finally {
    await worker.terminate();
  }
}
