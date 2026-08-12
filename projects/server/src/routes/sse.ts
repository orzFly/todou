import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ChangeEvent,
  ProjectSlug,
  SSE_CHANGE_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
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

      let tick = 0;
      while (!stream.aborted) {
        while (queue.length > 0 && !stream.aborted) {
          const event = queue.shift() as ChangeEvent;
          await stream.writeSSE({
            event: SSE_CHANGE_EVENT,
            data: JSON.stringify(event),
          });
        }
        if (stream.aborted) break;
        const iteration = ++tick;
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          // Heartbeat keeps proxies from idling the connection out. Sent as
          // a real event, not an SSE comment: EventSource can't see comments,
          // and the web client counts heartbeats to detect dead streams.
          // Promise.race never cancels the loser, so a sleep that lost to a
          // wake still resolves later — the tick guard keeps that stale
          // branch from injecting an off-schedule ping.
          stream.sleep(HEARTBEAT_MS).then(async () => {
            if (tick === iteration && !stream.aborted)
              await stream.writeSSE({ event: SSE_PING_EVENT, data: "{}" });
          }),
        ]);
        wake = null;
      }
    });
  });

  return app;
}
