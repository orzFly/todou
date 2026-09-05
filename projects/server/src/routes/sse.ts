import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ChangeEvent,
  type CrossChangeEvent,
  ProjectSlug,
  SSE_CHANGE_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../auth/middleware.ts";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  accessibleProjectRows,
  requireCapability,
} from "../services/access.ts";

const HEARTBEAT_MS = 30_000;

/**
 * One stream implementation, two scopes: the user-level feed follows every
 * project the caller can read, the legacy per-project feed is the same
 * machinery pinned to a single project (T-122).
 */
type Scope = { kind: "all" } | { kind: "project"; id: number; slug: string };

const userEventsRoute = createRoute({
  method: "get",
  path: "/events",
  summary:
    "SSE change feed across every project the caller can read (T-122). " +
    "Events carry pointers plus their origin ({entity, id, action, " +
    "issue_number?, project}); clients refetch via REST. The subscription " +
    "follows membership changes live: being added to a project starts its " +
    "events mid-stream, being removed silences them.",
  responses: { 200: { description: "text/event-stream" } },
});

const projectEventsRoute = createRoute({
  method: "get",
  path: "/projects/{slug}/events",
  summary:
    "SSE change feed for one project — a filtered view of /events. Events " +
    "carry pointers only ({entity, id, action, issue_number?, project}); " +
    "clients refetch via REST. The stream closes when the caller loses " +
    "access to the project.",
  request: { params: z.object({ slug: ProjectSlug }) },
  responses: { 200: { description: "text/event-stream" } },
});

function streamChanges(
  c: Context<AppEnv>,
  ctx: AppContext,
  user: UserRow,
  scope: Scope,
) {
  return streamSSE(c, async (stream) => {
    // The visible set decides delivery per event; project ids map to the
    // slug stamped into the payload. Loaded before subscribing so no event
    // is ever checked against an uninitialized set.
    const visible = new Map<number, string>();
    if (scope.kind === "project") {
      visible.set(scope.id, scope.slug);
    } else {
      for (const row of await accessibleProjectRows(ctx, user)) {
        visible.set(row.id, row.slug);
      }
    }

    const queue: Array<{ projectId: number; event: ChangeEvent }> = [];
    let wake: (() => void) | null = null;
    const unsubscribe = ctx.bus.subscribe((projectId, event) => {
      queue.push({ projectId, event });
      wake?.();
    });
    // Process shutdown must end the stream from the server side: SSE
    // responses never finish on their own, and every one of them would
    // otherwise hold `server.close()` open until it is severed (T-56).
    const shutdown = ctx.shutdown.signal;
    const onShutdown = () => wake?.();
    shutdown.addEventListener("abort", onShutdown);
    stream.onAbort(() => wake?.());

    const send = (slug: string, event: ChangeEvent) => {
      const payload: CrossChangeEvent = { ...event, project: slug };
      return stream.writeSSE({
        event: SSE_CHANGE_EVENT,
        data: JSON.stringify(payload),
      });
    };

    const recompute = async () => {
      const rows = await accessibleProjectRows(ctx, user);
      visible.clear();
      for (const row of rows) {
        if (scope.kind === "all" || row.id === scope.id) {
          visible.set(row.id, row.slug);
        }
      }
      // The pinned scope carries its own copy for the close-out messages.
      if (scope.kind === "project") {
        const slug = visible.get(scope.id);
        if (slug !== undefined) scope.slug = slug;
      }
    };

    // Flipped instead of breaking out directly so the revocation paths deep
    // in the drain loop share the loop's single exit (and its cleanup).
    let closed = false;

    try {
      // Lets clients (and tests) know the subscription is live.
      await stream.writeSSE({ event: "hello", data: "{}" });

      while (!closed && !stream.aborted && !shutdown.aborted) {
        while (queue.length > 0 && !stream.aborted && !closed) {
          const { projectId, event } = queue.shift() as {
            projectId: number;
            event: ChangeEvent;
          };

          // My own membership changed: the visible set moved under us.
          if (event.entity === "member" && event.id === user.id) {
            if (scope.kind === "all") {
              // Recompute, then deliver unconditionally — a just-granted
              // project is not in the old set, a just-revoked one is not in
              // the new; the union covers both. Only an add-then-remove race
              // leaves the slug unknown, and then there is nothing to say.
              const before = visible.get(projectId);
              try {
                await recompute();
              } catch {
                closed = true; // fail-closed: reconnect rebuilds the set
                continue;
              }
              const slug = visible.get(projectId) ?? before;
              if (slug !== undefined) await send(slug, event);
              continue;
            }
            if (projectId === scope.id && event.action === "deleted") {
              // Revoked mid-stream: say why, then close (this is the hole
              // the pre-T-122 route had — the subscription outlived access).
              await send(scope.slug, event);
              closed = true;
              continue;
            }
            // Role changes never drop below reader; fall through as an
            // ordinary event.
          }

          if (event.entity === "project" && event.action === "updated") {
            // A rename moves the slug every later payload is stamped with,
            // and nothing else in this loop would ever notice (T-156).
            try {
              await recompute();
            } catch {
              closed = true;
              continue;
            }
          }

          if (event.entity === "project" && scope.kind === "all") {
            if (event.action === "created") {
              // Covers both ways a project appears without a member event:
              // the creator's implicit admin row and instance-admin
              // visibility.
              try {
                await recompute();
              } catch {
                closed = true;
                continue;
              }
            } else if (event.action === "deleted") {
              const slug = visible.get(projectId);
              if (slug !== undefined) {
                await send(slug, event);
                visible.delete(projectId);
              }
              continue;
            }
          }
          if (
            event.entity === "project" &&
            scope.kind === "project" &&
            projectId === scope.id &&
            event.action === "deleted"
          ) {
            await send(scope.slug, event);
            closed = true;
            continue;
          }

          const slug = visible.get(projectId);
          if (slug !== undefined) await send(slug, event);
        }
        if (closed || stream.aborted || shutdown.aborted) break;
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
}

export function sseRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(userEventsRoute, async (c) =>
    streamChanges(c, c.get("appCtx"), c.get("user"), { kind: "all" }),
  );

  app.openapi(projectEventsRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const { project } = await requireCapability(
      ctx,
      user,
      c.req.valid("param").slug,
      "project.stream",
    );
    return streamChanges(c, ctx, user, {
      kind: "project",
      id: project.id,
      slug: project.slug,
    });
  });

  return app;
}
