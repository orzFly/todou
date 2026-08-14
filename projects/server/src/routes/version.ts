import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { VersionInfo } from "@todou/shared";
import { resolveVersion } from "@todou/shared/version";
import type { AppEnv } from "../auth/middleware.ts";

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  summary:
    "The running server's version string (public; the web footer compares " +
    "it with its own)",
  responses: {
    200: {
      description: "The version the server was built from",
      content: { "application/json": { schema: VersionInfo } },
    },
  },
});

export function versionRoutes() {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(versionRoute, (c) => c.json({ version: resolveVersion() }, 200));
  return app;
}
