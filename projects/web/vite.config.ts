import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vitest/config";

// The browser can't ask git, so the version is baked in at build time.
// TODOU_BUILD_VERSION comes from environments without a .git directory (the
// Docker image build); checkouts fall back to the same describe command every
// other artifact uses (see @todou/shared/version for the string's grammar).
function buildVersion(): string {
  if (process.env.TODOU_BUILD_VERSION) return process.env.TODOU_BUILD_VERSION;
  try {
    const out = execFileSync(
      "git",
      ["describe", "--tags", "--always", "--dirty"],
      {
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      },
    );
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// Derived from the root package.json rather than hardcoded a second time.
function repoUrl(): string {
  const pkg = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { repository?: string };
  const github = /^github:(.+)$/.exec(pkg.repository ?? "");
  return github ? `https://github.com/${github[1]}` : "";
}

export default defineConfig({
  define: {
    __TODOU_VERSION__: JSON.stringify(buildVersion()),
    __TODOU_REPO_URL__: JSON.stringify(repoUrl()),
  },
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
