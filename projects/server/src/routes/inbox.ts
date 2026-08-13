import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { InboxPage, InboxQuery } from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { getInbox } from "../services/inbox.ts";

const inboxRoute = createRoute({
  method: "get",
  path: "/me/inbox",
  summary:
    "Cross-project attention list: unread foreign activity, specs " +
    "awaiting my review, open questions. Sorted by last_activity_at " +
    "descending; `limit` applies per project.",
  request: { query: InboxQuery },
  responses: {
    200: {
      description: "Inbox rows",
      content: { "application/json": { schema: InboxPage } },
    },
  },
});

export function inboxRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(inboxRoute, async (c) => {
    return c.json(
      await getInbox(c.get("appCtx"), c.get("user"), c.req.valid("query")),
      200,
    );
  });

  return app;
}
