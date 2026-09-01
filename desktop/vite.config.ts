import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and a relative build output it can
// bundle directly; see src-tauri/tauri.conf.json (build.devUrl / frontendDist).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
