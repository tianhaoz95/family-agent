import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and a relative build output it can
// bundle directly; see src-tauri/tauri.conf.json (build.devUrl / frontendDist).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Crawl the real entry on startup so every bare import below is discovered
    // and pre-bundled before the Tauri window loads the page.
    warmup: { clientFiles: ["./src/main.ts"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // Pre-bundle every third-party dep at server start. Without this, Vite
  // discovers `pdfjs-dist` (large, many submodules) only when the page first
  // requests it, kicks off optimization mid-load, and forces a full-page
  // reload. In Chromium that reload is seamless; in the Tauri Linux webview
  // (WebKitGTK/JSC) the interrupted first load can throw
  // "Importing binding name 'default' cannot be resolved by star export
  // entries" and the reload doesn't always recover — the window stays blank.
  optimizeDeps: {
    include: ["marked", "dompurify", "pdfjs-dist", "@tauri-apps/plugin-dialog"],
  },
  plugins: [
    {
      name: "__tmp_reqlog",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url === "/index.html") console.log(`REQLOG ${req.method} ${req.url}`);
          next();
        });
      },
    },
  ],
});
