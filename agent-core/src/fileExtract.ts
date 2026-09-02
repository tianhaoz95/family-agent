import { extname } from "node:path";
import { mkdirSync } from "node:fs";
import { createWorker } from "tesseract.js";
import { PDFParse } from "pdf-parse";
import { config } from "./config.js";
import { ocrImageViaOllama } from "./ollamaOcr.js";

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

// A scanned PDF has a text layer of only pdf-parse's page separators, which
// strip to nothing. Anything under this many non-whitespace characters is
// treated as "no real text layer" and sent down the OCR path instead.
const PDF_TEXT_LAYER_MIN_CHARS = 24;

// Cap how many pages of a scanned PDF get OCR'd in one upload. OCR is ~5–15s
// per page on CPU; without a cap a 40-page scan would hang the request for
// minutes. Family documents are near-always a handful of pages.
const PDF_OCR_MAX_PAGES = 10;


/**
 * Extracts plain text from a file's raw bytes, dispatching on extension.
 * Throws UnsupportedFileTypeError for anything outside SUPPORTED_EXTENSIONS.
 *
 * PDFs: the embedded text layer is used when there is one; a scanned PDF with
 * no text layer falls back to OCR'ing its page images (same tesseract.js path
 * as a photo), capped at PDF_OCR_MAX_PAGES.
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
    const text = result.text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, "").trim();
    if (text.replace(/\s+/g, "").length >= PDF_TEXT_LAYER_MIN_CHARS) return text;

    // No usable text layer — this is a scan. pdf-parse hands back each page's
    // embedded image already PNG-encoded, so it can go straight to the same
    // OCR path a photo upload uses. imageThreshold:0 disables pdf-parse's
    // default "skip images <=80px" filter — a scanned page is always large,
    // but the filter also drops legitimately small scans, and we only reach
    // this branch when there's no text layer to lose anyway.
    const extracted = await parser.getImage({
      imageBuffer: true,
      imageDataUrl: false,
      imageThreshold: 0,
    });
    const pageImages: Buffer[] = [];
    for (const page of extracted.pages) {
      for (const img of page.images) {
        if (img.data?.length) pageImages.push(Buffer.from(img.data));
      }
      if (pageImages.length >= PDF_OCR_MAX_PAGES) break;
    }
    const ocrText = await ocrImages(pageImages.slice(0, PDF_OCR_MAX_PAGES));
    return ocrText || text;
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

async function extractImageText(buffer: Buffer): Promise<string> {
  return ocrImages([buffer]);
}

// OCR one or more encoded (PNG/JPEG) page images. Routes to the configured
// Ollama vision model (config.ocrModel, e.g. "glm-ocr:latest") when set, else
// the built-in tesseract.js engine. A model that's missing, unreachable, or
// too slow falls back to tesseract rather than sinking the whole ingest.
async function ocrImages(images: Buffer[]): Promise<string> {
  if (images.length === 0) return "";
  if (config.ocrModel) {
    try {
      return await ocrViaModel(images, config.ocrModel);
    } catch (err) {
      console.error(
        `OCR model "${config.ocrModel}" failed — falling back to the built-in engine:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return ocrViaTesseract(images);
}

async function ocrViaModel(images: Buffer[], model: string): Promise<string> {
  const budgetMs = config.ocrModelTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const parts: string[] = [];
  try {
    for (const image of images) {
      parts.push(await ocrImageViaOllama(image, controller.signal));
    }
  } catch (err) {
    // Out of time but some pages are done — a partial transcript still beats
    // nothing (and beats a slower re-run through tesseract).
    if (controller.signal.aborted && parts.length > 0) {
      console.error(`OCR model "${model}" hit the ${budgetMs / 1000}s budget after ${parts.length} page(s)`);
      return parts.join("\n\n").trim();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return parts.join("\n\n").trim();
}

// Built-in OCR via tesseract.js. One shared worker for a multi-page scan —
// creating a worker loads the ~4MB English model, paid once not per page.
// That model is fetched from a CDN on the very first OCR call and then cached
// under `<dataDir>/tessdata/` (cachePath set explicitly, not left at
// tesseract.js's default of the process CWD). Every call after the first is
// fully offline. This CDN fetch is the one deliberate exception to "nothing
// leaves the machine" — flagged here and in docs/DECISIONS.md, not hidden.
async function ocrViaTesseract(images: Buffer[]): Promise<string> {
  const cachePath = `${config.dataDir}/tessdata`;
  // tesseract.js's Node cache writer is a plain fs.writeFile — it doesn't
  // create the directory itself, and fails (silently swallowed upstream)
  // if it's missing. Confirmed by testing: without this, nothing ever got
  // cached and every OCR call re-downloaded from the CDN.
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker("eng", undefined, { cachePath });
  try {
    const parts: string[] = [];
    for (const image of images) {
      const {
        data: { text },
      } = await worker.recognize(image);
      parts.push(text);
    }
    return parts.join("\n\n").trim();
  } finally {
    await worker.terminate();
  }
}
