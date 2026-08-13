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
      // Process shutdown must end the stream from the server side: SSE
      // responses never finish on their own, and every one of them would
      // otherwise hold `server.close()` open until it is severed (T-56).
      const shutdown = ctx.shutdown.signal;
      const onShutdown = () => wake?.();
      shutdown.addEventListener("abort", onShutdown);
      stream.onAbort(() => wake?.());

      try {
        // Lets clients (and tests) know the subscription is live.
        await stream.writeSSE({ event: "hello", data: "{}" });

        while (!stream.aborted && !shutdown.aborted) {
          while (queue.length > 0 && !stream.aborted) {
            const event = queue.shift() as ChangeEvent;
            await stream.writeSSE({
              event: SSE_CHANGE_EVENT,
              data: JSON.stringify(event),
            });
          }
          if (stream.aborted || shutdown.aborted) break;
          // Heartbeat keeps proxies from idling the connection out. Sent as
          // a real event, not an SSE comment: EventSource can't see comments,
          // and the web client counts heartbeats to detect dead streams.
          // One promise, one timer, cleared every iteration: an uncancelled
          // sleep would keep the event loop (and thus the process, during
          // shutdown) alive for up to HEARTBEAT_MS after the stream ends.
          let pingDue = false;
          let heartbeat: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            heartbeat = setTimeout(() => {
              pingDue = true;
              resolve();
            }, HEARTBEAT_MS);
          });
          clearTimeout(heartbeat);
          wake = null;
          if (pingDue && !stream.aborted && !shutdown.aborted) {
            await stream.writeSSE({ event: SSE_PING_EVENT, data: "{}" });
          }
        }
      } finally {
        unsubscribe();
        shutdown.removeEventListener("abort", onShutdown);
      }
    });
  });

  return app;
}
