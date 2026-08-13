import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { type AppEnv, authMiddleware } from "./auth/middleware.ts";
import type { AppContext } from "./bootstrap.ts";
import { registerErrorHandler } from "./errors.ts";
import { agentContextMiddleware } from "./middleware/agent-context.ts";
import {
  avatarBodyLimit,
  jsonBodyLimit,
  uploadBodyLimit,
} from "./middleware/body-limit.ts";
import { compressMiddleware } from "./middleware/compress.ts";
import { agentRoutes } from "./routes/agents.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { authRoutes } from "./routes/auth.ts";
import { issueRoutes } from "./routes/issues.ts";
import { labelRoutes } from "./routes/labels.ts";
import { meRoutes } from "./routes/me.ts";
import { projectRoutes } from "./routes/projects.ts";
import { referenceRoutes } from "./routes/references.ts";
import { specRoutes } from "./routes/spec.ts";
import { sseRoutes } from "./routes/sse.ts";
import { statusRoutes } from "./routes/statuses.ts";
import { userRoutes } from "./routes/users.ts";

/**
 * Zod validation failures become uniform 422 error bodies. The message is
 * the prettified error, not a generic "invalid request": strict component
 * schemas (T-19) reject hallucinated extra fields, and the offending path
 * must reach the CLI user verbatim.
 */
// biome-ignore lint/suspicious/noExplicitAny: hook signature is generic
const defaultHook = (result: any, c: any) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "validation_failed",
          message: z.prettifyError(result.error),
          details: result.error.issues,
        },
      },
      422,
    );
  }
};

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

/**
 * serveStatic finalises its response body before handing control back, so
 * Cache-Control has to be stamped on the way out rather than through its
 * onFound hook — headers set there are dropped.
 */
const cacheControl = (value: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set("Cache-Control", value);
  });

/**
 * Serves the built web app next to the API so the two share an origin: the
 * session cookie and the SSE stream then need no CORS or proxy-buffering
 * setup.
 */
function mountWebApp(app: OpenAPIHono<AppEnv>, root: string): void {
  const files = serveStatic({ root });

  // Vite content-hashes everything here, so it can be cached forever. A miss
  // is a stale build reference rather than a client route — 404 it, or the
  // fallthrough below would cache the SPA shell under an asset URL forever.
  app.use("/assets/*", cacheControl(IMMUTABLE_CACHE), files);
  app.all("/assets/*", (c) => c.notFound());

  app.use("*", cacheControl(REVALIDATE_CACHE), files);
  // The web router uses browser history, so an unmatched path is a deep link
  // and must return the shell for the client to resolve. Under /api it is a
  // genuine miss instead, and has to stay machine-readable, not become HTML.
  const shell = serveStatic({ root, path: "index.html" });
  app.on(["GET", "HEAD"], "*", (c, next) =>
    isApiPath(c.req.path) ? next() : shell(c, next),
  );
}

export function createApp(ctx: AppContext) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook });
  app.use("*", async (c, next) => {
    c.set("appCtx", ctx);
    await next();
  });
  if (ctx.config.http.compression) {
    app.use("*", compressMiddleware());
  }

  // basePath (rather than a prefixed mount) so the generated OpenAPI
  // document carries the /api prefix in its paths.
  const api = new OpenAPIHono<AppEnv>({ defaultHook }).basePath("/api");
  // Body limits come before every route — including the unauthenticated
  // /auth ones — so nothing buffers an oversized request (T-70). The scoped
  // upload limits must register ahead of the API-wide JSON limit, which
  // would otherwise cut legitimate uploads off first.
  api.use("/projects/:slug/attachments", uploadBodyLimit(ctx.config));
  api.use("/me/avatar", avatarBodyLimit());
  api.use("/agents/:id/avatar", avatarBodyLimit());
  api.use("*", jsonBodyLimit(ctx.config));
  // Order matters: /auth endpoints and the OpenAPI document are registered
  // before the auth guard so they work unauthenticated; everything after
  // the guard requires a session cookie or a bearer PAT.
  api.route("/auth", authRoutes(ctx));
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "todou",
      version: "0.1.0",
      description:
        "A to-do system where projects behave like GitHub-Issues-style " +
        "boards and agents are first-class machine users.",
    },
  });
  api.use("*", authMiddleware(ctx));
  api.use("*", agentContextMiddleware());
  api.route("/", meRoutes());
  api.route("/", userRoutes());
  api.route("/agents", agentRoutes());
  api.route("/projects", projectRoutes());
  api.route("/projects", statusRoutes());
  api.route("/projects", referenceRoutes());
  api.route("/projects", labelRoutes());
  api.route("/projects", issueRoutes());
  api.route("/projects", specRoutes());
  api.route("/projects", attachmentRoutes());
  api.route("/projects", sseRoutes());

  app.route("/", api);
  if (ctx.config.http.static_dir) {
    mountWebApp(app, ctx.config.http.static_dir);
  }
  registerErrorHandler(app);
  return app;
}

export type App = ReturnType<typeof createApp>;
