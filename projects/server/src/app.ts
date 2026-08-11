import { OpenAPIHono } from "@hono/zod-openapi";
import { type AppEnv, authMiddleware } from "./auth/middleware.ts";
import type { AppContext } from "./bootstrap.ts";
import { registerErrorHandler } from "./errors.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { authRoutes } from "./routes/auth.ts";
import { issueRoutes } from "./routes/issues.ts";
import { labelRoutes } from "./routes/labels.ts";
import { meRoutes } from "./routes/me.ts";
import { projectRoutes } from "./routes/projects.ts";
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

  const api = new OpenAPIHono<AppEnv>({ defaultHook });
  // Order matters: /auth endpoints are registered before the auth guard so
  // login works unauthenticated; everything after the guard requires
  // a session cookie or a bearer PAT.
  api.route("/auth", authRoutes(ctx));
  api.use("*", authMiddleware(ctx));
  api.route("/", meRoutes());
  api.route("/projects", projectRoutes());
  api.route("/projects", statusRoutes());
  api.route("/projects", labelRoutes());
  api.route("/projects", issueRoutes());
  api.route("/projects", attachmentRoutes());

  app.route("/api", api);
  registerErrorHandler(app);
  return app;
}

export type App = ReturnType<typeof createApp>;
