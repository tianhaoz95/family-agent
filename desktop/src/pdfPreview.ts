// PDF preview for the side panel. pdf.js renders each page to a <canvas> —
// the Linux webview (WebKitGTK) has no built-in PDF viewer, so an <iframe>/
// <embed> wouldn't work; this does, on every platform. The worker is emitted
// by Vite and loaded from a local URL (no CDN).
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfRender {
  /** Stop rendering and release the document (call when the panel closes). */
  cancel(): void;
}

/**
 * Render every page of `data` as full-width stacked canvases into `container`.
 * Returns a handle whose `cancel()` aborts an in-flight render. On failure the
 * container is filled with a short message instead.
 */
export function renderPdf(container: HTMLElement, data: ArrayBuffer): PdfRender {
  let cancelled = false;
  let doc: PDFDocumentProxy | null = null;

  void (async () => {
    let pdf: PDFDocumentProxy;
    try {
      pdf = await pdfjs.getDocument({ data }).promise;
    } catch (err) {
      if (!cancelled) {
        container.innerHTML = `<p class="side-panel-hint">Couldn't open the PDF: ${
          err instanceof Error ? err.message : String(err)
        }</p>`;
      }
      return;
    }
    doc = pdf;
    if (cancelled) {
      void pdf.destroy();
      return;
    }

    container.innerHTML = "";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = Math.max(container.clientWidth || 0, 320);

    for (let n = 1; n <= pdf.numPages; n++) {
      if (cancelled) break;
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      container.appendChild(canvas);
      try {
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {
        /* cancelled mid-page, or a bad page — keep going */
      }
      page.cleanup();
    }
  })();

  return {
    cancel() {
      cancelled = true;
      void doc?.destroy();
    },
  };
}
