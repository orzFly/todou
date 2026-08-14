import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // svgr serves the `?react` imports in lib/harness-logos.tsx: the brand marks
  // ship as bare .svg files, and only a component can take the badge's sizing
  // class and test id. vitest reads this same plugin array, so the marks
  // resolve identically under happy-dom.
  plugins: [
    react(),
    tailwindcss(),
    // Each upstream mark hardcodes a <title> ("Claude", "Hermes Agent").
    // titleProp turns that into a prop, which is the only way to *drop* it
    // short of pulling in svgo — see the render in shared/agent-badge.tsx.
    svgr({ svgrOptions: { titleProp: true } }),
  ],
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
    setupFiles: ["./test/setup.ts"],
  },
});
