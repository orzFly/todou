import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 8636,
    proxy: {
      "/api": {
        // Point at the todou server; override with TODOU_API when it runs
        // on a non-default port.
        target: process.env.TODOU_API ?? "http://localhost:8637",
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "happy-dom",
    // Exposes afterEach globally so testing-library auto-cleans between
    // tests (otherwise renders leak across cases).
    globals: true,
  },
});
