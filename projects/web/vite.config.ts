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
        configure(proxy) {
          // http-proxy pipes the upstream response into ours, and pipe()
          // does not propagate a premature upstream close — when the server
          // dies mid-stream the browser keeps a silently dead connection
          // (deadly for SSE: EventSource never notices, never reconnects).
          // Destroy our side so clients see the drop, like they would in
          // production behind a real reverse proxy.
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!res.writableEnded) res.destroy();
            });
          });
        },
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
