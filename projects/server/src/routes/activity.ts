import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { CrossActivityPage, CrossActivityQuery } from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { getCrossActivity } from "../services/timeline.ts";

const crossActivityRoute = createRoute({
  method: "get",
  path: "/activity",
  summary:
    "Cross-project activity stream (T-93): the per-project stream fanned " +
    "out over several projects (comma-separated `projects`, or every " +
    "readable project when absent) and merged, each entry tagged with its " +
    "project slug. `after` takes the envelope minted by this endpoint " +
    "(per-project resume) or a plain single-project cursor (the common " +
    "starting position everywhere); `last=1` bootstraps a now-envelope.",
  request: { query: CrossActivityQuery },
  responses: {
    200: {
      description: "Page",
      content: { "application/json": { schema: CrossActivityPage } },
    },
  },
});

export function activityRoutes() {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(crossActivityRoute, async (c) =>
    c.json(
      await getCrossActivity(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("query"),
      ),
      200,
    ),
  );
  return app;
}
