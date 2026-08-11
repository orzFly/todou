import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type ChangeEvent, ProjectSlug, SSE_CHANGE_EVENT } from "@todou/shared";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../auth/middleware.ts";
import { requireProject } from "../services/access.ts";

const HEARTBEAT_MS = 30_000;

const eventsRoute = createRoute({
  method: "get",
  path: "/{slug}/events",
  summary:
    "SSE change feed for one project. Events carry pointers only " +
    "({entity, id, action, issue_number?}); clients refetch via REST.",
  request: { params: z.object({ slug: ProjectSlug }) },
  responses: { 200: { description: "text/event-stream" } },
});

export function sseRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(eventsRoute, async (c) => {
    const ctx = c.get("appCtx");
    const { project } = await requireProject(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "reader",
    );

    return streamSSE(c, async (stream) => {
      const queue: ChangeEvent[] = [];
      let wake: (() => void) | null = null;

      const unsubscribe = ctx.bus.subscribe(project.id, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });

      // Lets clients (and tests) know the subscription is live.
      await stream.writeSSE({ event: "hello", data: "{}" });

      while (!stream.aborted) {
        while (queue.length > 0 && !stream.aborted) {
          const event = queue.shift() as ChangeEvent;
          await stream.writeSSE({
            event: SSE_CHANGE_EVENT,
            data: JSON.stringify(event),
          });
        }
        if (stream.aborted) break;
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          // Heartbeat comment keeps proxies from idling the connection out.
          stream.sleep(HEARTBEAT_MS).then(() => stream.write(": ping\n\n")),
        ]);
        wake = null;
      }
    });
  });

  return app;
}
