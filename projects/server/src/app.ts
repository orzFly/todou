import { OpenAPIHono } from "@hono/zod-openapi";
import { type AppEnv, authMiddleware } from "./auth/middleware.ts";
import type { AppContext } from "./bootstrap.ts";
import { registerErrorHandler } from "./errors.ts";
import { agentRoutes } from "./routes/agents.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { authRoutes } from "./routes/auth.ts";
import { issueRoutes } from "./routes/issues.ts";
import { labelRoutes } from "./routes/labels.ts";
import { meRoutes } from "./routes/me.ts";
import { projectRoutes } from "./routes/projects.ts";
import { sseRoutes } from "./routes/sse.ts";
import { statusRoutes } from "./routes/statuses.ts";

/** Zod validation failures become uniform 422 error bodies. */
// biome-ignore lint/suspicious/noExplicitAny: hook signature is generic
const defaultHook = (result: any, c: any) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "validation_failed",
          message: "invalid request",
          details: result.error.issues,
        },
      },
      422,
    );
  }
};

export function createApp(ctx: AppContext) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook });
  app.use("*", async (c, next) => {
    c.set("appCtx", ctx);
    await next();
  });

  // basePath (rather than a prefixed mount) so the generated OpenAPI
  // document carries the /api prefix in its paths.
  const api = new OpenAPIHono<AppEnv>({ defaultHook }).basePath("/api");
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
  api.route("/", meRoutes());
  api.route("/agents", agentRoutes());
  api.route("/projects", projectRoutes());
  api.route("/projects", statusRoutes());
  api.route("/projects", labelRoutes());
  api.route("/projects", issueRoutes());
  api.route("/projects", attachmentRoutes());
  api.route("/projects", sseRoutes());

  app.route("/", api);
  registerErrorHandler(app);
  return app;
}

export type App = ReturnType<typeof createApp>;
