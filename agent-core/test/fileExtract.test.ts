import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { config } from "../src/config.js";
import { extractText, SUPPORTED_EXTENSIONS, UnsupportedFileTypeError } from "../src/fileExtract.js";

// PDF and OCR both take real (if brief) work — a few seconds is normal for
// these, not a hang.
const SLOW = 30000;

function makeTestPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(14).text(text);
    doc.end();
  });
}

// A PDF whose only content is an image — no selectable text layer, i.e. what
// a phone-scanned or photographed document looks like.
function makeScannedPdf(imagePng: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.image(imagePng, 40, 40, { width: 480 });
    doc.end();
  });
}

describe("extractText", () => {
  it("reads .txt files as plain utf8", async () => {
    const text = await extractText("note.txt", Buffer.from("hello family"));
    expect(text).toBe("hello family");
  });

  it("reads .md files as plain utf8", async () => {
    const text = await extractText("note.md", Buffer.from("# Title\n\nBody"));
    expect(text).toBe("# Title\n\nBody");
  });

  it("throws UnsupportedFileTypeError for an unknown extension", async () => {
    await expect(extractText("resume.docx", Buffer.from("x"))).rejects.toThrow(UnsupportedFileTypeError);
  });

  it("extracts text from a real PDF, stripping pdf-parse's page-separator noise", async () => {
    const pdfBuffer = await makeTestPdf("Electric bill: $86.40, due 2026-10-05.");
    const text = await extractText("bill.pdf", pdfBuffer);
    expect(text).toContain("Electric bill");
    expect(text).toContain("86.40");
    expect(text).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
  }, SLOW);

  it("falls back to OCR for a scanned PDF with no text layer", async () => {
    const png = Buffer.from(FIXTURE_PNG_BASE64, "base64");
    const pdfBuffer = await makeScannedPdf(png);
    const text = await extractText("scan.pdf", pdfBuffer);
    expect(text.toUpperCase()).toContain("TEST");
  }, SLOW);

  it("rejects a file with a .png name that isn't actually a PNG, without crashing", async () => {
    await expect(extractText("fake.png", Buffer.from("not a real png"))).rejects.toThrow(/doesn't look like/);
  });

  describe("with an OCR model configured (config.ocrModel)", () => {
    const realFetch = globalThis.fetch;
    const realTimeout = config.ocrModelTimeoutMs;
    afterEach(() => {
      config.ocrModel = "";
      config.ocrModelTimeoutMs = realTimeout;
      globalThis.fetch = realFetch;
    });

    it("routes image OCR through the Ollama vision model", async () => {
      config.ocrModel = "glm-ocr:test";
      const calls: string[] = [];
      globalThis.fetch = (async (url: any, init: any) => {
        calls.push(String(url));
        expect(String(url)).toContain("/api/generate");
        expect(JSON.parse(init.body).model).toBe("glm-ocr:test");
        return new Response(JSON.stringify({ response: "# Water bill\n\nDue $63.20 on 2026-10-15" }), { status: 200 });
      }) as typeof fetch;

      const png = Buffer.from(FIXTURE_PNG_BASE64, "base64");
      const text = await extractText("receipt.png", png);
      expect(text).toContain("Water bill");
      expect(calls).toHaveLength(1);
    });

    it("falls back to the built-in engine when the model call fails", async () => {
      config.ocrModel = "glm-ocr:test";
      globalThis.fetch = (async () => new Response("model not found", { status: 404 })) as typeof fetch;

      const png = Buffer.from(FIXTURE_PNG_BASE64, "base64");
      const text = await extractText("scan.png", png);
      // tesseract still ran on the fixture
      expect(text.toUpperCase()).toContain("TEST");
    }, SLOW);

    it("falls back to the built-in engine when the model exceeds its time budget", async () => {
      config.ocrModel = "glm-ocr:test";
      config.ocrModelTimeoutMs = 40;
      globalThis.fetch = ((_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError"))
          );
        })) as typeof fetch;

      const png = Buffer.from(FIXTURE_PNG_BASE64, "base64");
      const text = await extractText("scan.png", png);
      expect(text.toUpperCase()).toContain("TEST");
    }, SLOW);
  });

  it("OCRs a real PNG containing text", async () => {
    // A pre-rendered PNG fixture instead of generating one at test time —
    // keeps this test from depending on system font availability.
    const dir = mkdtempSync(join(tmpdir(), "family-agent-fileextract-"));
    try {
      // 300x80 PNG, black text "TEST 2026" on white, generated once via PIL
      // and stored as base64 so this test has no image-generation dependency.
      const pngPath = join(dir, "fixture.png");
      writeFileSync(pngPath, Buffer.from(FIXTURE_PNG_BASE64, "base64"));
      const text = await extractText("scan.png", readFileSync(pngPath));
      expect(text.toUpperCase()).toContain("TEST");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);
});

describe("SUPPORTED_EXTENSIONS", () => {
  it("includes text, pdf, and common image formats", () => {
    for (const ext of [".txt", ".md", ".pdf", ".jpg", ".jpeg", ".png", ".webp"]) {
      expect(SUPPORTED_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(false);
  });
});

// 300x80, white background, black "TEST 2026" text, generated with PIL.
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAASwAAABQCAIAAAAsiN8sAAADrElEQVR4nO3dP0hyexjA8V83FyWywCiXlggEJYOiKNJXhRqEwBanwKG5loigJWgogv4tQZPRJnEokGhoFIqmVqGixRqUiiSXQnvuIO/LhewON/MZ7vcz/Tw85+BP+HIOKNgkIgaAnr+03wDwf0eEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgLJvRXh8fBwKhUKhkM1mqy4sy3I4HKHftra2jDFXV1cTExPhcHh8fDyXy9U8q3rBZDIZCAT6+/vPzs6MMcViMRaLjY2NxWKxYrFYc+bj42Nubm5kZCQYDN7d3X3rwwBUSD04nc6a6yq/35/L5UTEsqx4PP7VZKFQCAaDlUolm816PB4RWVhY2NzcFJGNjY3FxcWaM7u7u0tLSyJydHQ0NTVVl+0AjdSICN1u983NjYi8v79nMpmvJrPZ7OHhoYiUSqWOjg4R8Xq9Dw8PInJ/f+/z+WrOjI6OVi/+9va2vr5el+0AjWRrwM12dXU1EAhEo9Hp6elwOPzVmMfj8Xg8xhjLsiYnJ40x+Xy+q6vLGON2u/P5fM2Z6+vrdDqdTqfb29u3t7cbsB2gzuqS8j/vaXa7/ddvFxcX1YPPz8/JZLKvr295ebnmWX/c3t56vd5CoSAiLperUqmISKVSqd73Ps+0trZaliUilmVFIpG6bAdopB9/HC0UCufn53/WnZ2dX02KyOvr68DAwOXlZfXl58fRzzO9vb3lcllEyuWyy+Wqy3aARvrxryiampri8XgulzPGPD09dXd3/8s9OZFIzM/PDw8PV49Eo9FUKmWMSaVS0Wi05kwkEslkMsaYTCbj9/t/ejtA3TVJPf6pt62t7eXlpbp2OBxDQ0PV9cjIyNra2unp6crKit1ub25u3tnZ8fl8n88yxuzv78/Ozg4ODhpjWlpaTk5OisViIpF4fHx0uVwHBwdOp/PzTKFQmJmZKZVKNpttb2+vp6fn+9sBGqk+EQL4z/jFDKCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JAGRECyogQUEaEgDIiBJQRIaCMCAFlRAgoI0JA2d85JB66H3SlMQAAAABJRU5ErkJggg==";
