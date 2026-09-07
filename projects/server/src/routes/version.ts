import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { VersionInfo } from "@todou/shared";
import { resolveVersion } from "@todou/shared/version";
import type { AppEnv } from "../auth/middleware.ts";

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  summary:
    "The running server's version string, and the deployment's public " +
    "address (public; the web footer compares the version with its own)",
  responses: {
    200: {
      description: "The version the server was built from",
      content: { "application/json": { schema: VersionInfo } },
    },
  },
});

export function versionRoutes() {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(versionRoute, (c) => {
    // Left out rather than sent as null when unconfigured, so a client can
    // tell "this deployment has no public address" from "this server is old
    // enough not to know the field" — both being cases to fall back on.
    const publicOrigin = c.get("appCtx").config.http.public_origin;
    return c.json(
      {
        version: resolveVersion(),
        ...(publicOrigin === undefined ? {} : { public_origin: publicOrigin }),
      },
      200,
    );
  });
  return app;
}
