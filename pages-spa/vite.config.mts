import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "..");

export default defineConfig({
  root: rootDir,
  base: "/crypto-pump-screener/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(repoRoot, "src"),
    },
  },
  publicDir: path.resolve(rootDir, "public"),
  css: {
    // Avoid picking up Next's postcss.config.mjs (string plugin form)
    postcss: {},
  },
  build: {
    outDir: path.resolve(repoRoot, "docs"),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: "assets",
  },
  server: {
    port: 4173,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
});
