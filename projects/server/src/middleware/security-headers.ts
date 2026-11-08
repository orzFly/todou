import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";

/** Inline `<script>` bodies only; a `src` script is covered by 'self'. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)].map(
    ([, body]) =>
      `'sha256-${createHash("sha256")
        .update(body ?? "")
        .digest("base64")}'`,
  );
}

/**
 * The shell's own policy. Only script execution is fenced: it is the second
 * line behind the markdown and mermaid sanitizers, and fencing styles, fonts
 * or images as well would break markdown that embeds outside images for no
 * script-execution gain. 'wasm-unsafe-eval' is shiki's Oniguruma build.
 */
export function shellPolicy(scriptHashes: readonly string[]): string {
  return [
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(" ")}`.trimEnd(),
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function readShellHashes(staticDir: string | undefined): string[] {
  if (staticDir === undefined) return [];
  try {
    return inlineScriptHashes(
      readFileSync(join(staticDir, "index.html"), "utf8"),
    );
  } catch {
    return [];
  }
}

/**
 * Nothing todou serves is meant to be framed by another site (T-633): a
 * one-click page such as /cli-auth's Authorize must not sit under someone
 * else's decoy button. The one exception is a route that already set its
 * own policy — the attachment view, a sandbox the web app frames itself —
 * which keeps that policy and may be framed by todou's own pages only.
 */
export function securityHeaders(staticDir: string | undefined) {
  // Hashed once: a redeploy replaces index.html and restarts the server.
  const shell = shellPolicy(readShellHashes(staticDir));
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    const own = headers.get("Content-Security-Policy");
    if (own !== null) {
      headers.set("Content-Security-Policy", `${own}; frame-ancestors 'self'`);
      headers.set("X-Frame-Options", "SAMEORIGIN");
      return;
    }
    const html = headers.get("Content-Type")?.startsWith("text/html") ?? false;
    headers.set(
      "Content-Security-Policy",
      html ? shell : "frame-ancestors 'none'",
    );
    headers.set("X-Frame-Options", "DENY");
  });
}
