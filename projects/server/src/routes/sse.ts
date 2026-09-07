import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ChangeEntity,
  type ChangeEvent,
  type CrossChangeEvent,
  type InboxRowState,
  type MeEvent,
  MetadataNamespaceSelector,
  ProjectRef,
  SSE_CHANGE_EVENT,
  SSE_ME_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../auth/middleware.ts";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireCapability,
  routeInfoOf,
} from "../services/access.ts";
import {
  type VisibleProjects,
  visibleProjects,
} from "../services/cross-references.ts";
import { inboxRowState } from "../services/inbox.ts";
import { readPrefs } from "../services/prefs.ts";

const HEARTBEAT_MS = 30_000;

/**
 * Backlog above which one connection stops judging its events (T-273). The
 * judgement costs a handful of queries and is awaited inside the drain loop,
 * so a burst would delay every other invalidation on the connection —
 * invalidations that cost nothing today. Past the mark the field is simply
 * omitted, which is the same fail-open the client already handles.
 */
export const INBOX_JUDGE_QUEUE_MAX = 32;

/** Entities whose changes can move an issue into or out of an inbox. */
const INBOX_ENTITIES = new Set<ChangeEntity>([
  "issue",
  "comment",
  "timeline",
  "spec",
]);

/**
 * One stream implementation, two scopes: the user-level feed follows every
 * project the caller can read, the legacy per-project feed is the same
 * machinery pinned to a single project (T-122).
 */
type Scope = { kind: "all" } | { kind: "project"; row: ProjectRow };

const inboxParam = z
  .literal("1")
  .optional()
  .openapi({
    param: { name: "inbox", in: "query" },
    description:
      "Opt in to per-receiver inbox signals (T-275). Change events then " +
      "carry `inbox_row`, the deciding fields of the event issue's row in " +
      "the subscriber's inbox after the change (`null` when it holds no " +
      "row, key absent when the server declined to work it out), and the " +
      "connection additionally receives `me` events for the subscriber's " +
      "own read positions and preferences. Without it the server computes " +
      "nothing and sends neither, so subscribers that only use events as a " +
      "nudge pay nothing.",
  });

/**
 * Which metadata namespaces this connection wants (T-282). Absent means it
 * wants none, and then the server neither computes nor sends anything —
 * which is why `todou watch` is never woken by a metadata write.
 */
const metadataParam = MetadataNamespaceSelector.optional().openapi({
  param: { name: "metadata", in: "query" },
  description:
    "Opt in to `metadata` change events (T-282): a comma-separated list of " +
    "namespaces, or `*` for all of them. Such an event carries the whole " +
    "entry — namespace, key, value, and who wrote it when — which is safe " +
    "here precisely because metadata read permission is project visibility " +
    "and nothing finer, the same filter this feed already applies. Without " +
    "the parameter no metadata event is delivered at all.",
});

const userEventsRoute = createRoute({
  method: "get",
  path: "/events",
  summary:
    "SSE change feed across every project the caller can read (T-122). " +
    "Events carry pointers plus their origin ({entity, id, action, " +
    "issue_number?, project}); clients refetch via REST. An issue event " +
    "additionally carries `list_row` (T-279): `{kind:'activity'}` when only " +
    "`updated_at` or a badge moved, `{kind:'fields', status_id, label_ids?, " +
    "assignee_ids?}` for where the row now sits (an omitted set did not " +
    "change), `{kind:'gone'}` when it left every readable list. The key is " +
    "absent where the write path gave no answer, and a client must then " +
    "refetch the lists unconditionally. The subscription follows membership " +
    "changes live: being added to a project starts its events mid-stream, " +
    "being removed silences them.",
  request: {
    query: z.object({ inbox: inboxParam, metadata: metadataParam }),
  },
  responses: { 200: { description: "text/event-stream" } },
});

const projectEventsRoute = createRoute({
  method: "get",
  path: "/projects/{slug}/events",
  summary:
    "SSE change feed for one project — a filtered view of /events. Events " +
    "carry pointers ({entity, id, action, issue_number?, project}) plus " +
    "`list_row` on an issue event (T-279, see /events); clients refetch via " +
    "REST. The stream closes when the caller loses access to the project.",
  request: {
    params: z.object({ slug: ProjectRef }),
    query: z.object({ inbox: inboxParam, metadata: metadataParam }),
  },
  responses: { 200: { description: "text/event-stream" } },
});

function streamChanges(
  c: Context<AppEnv>,
  ctx: AppContext,
  user: UserRow,
  scope: Scope,
  wantInbox: boolean,
  /** Undefined = this connection asked for no metadata at all. */
  wantMetadata: MetadataNamespaceSelector | undefined,
) {
  return streamSSE(c, async (stream) => {
    // The visible set decides delivery per event; each row carries the slug
    // stamped into the payload and the route to that project's database.
    // Loaded before subscribing so no event is ever checked against an
    // uninitialized set.
    const visible = new Map<number, ProjectRow>();
    if (scope.kind === "project") {
      visible.set(scope.row.id, scope.row);
    } else {
      for (const row of await accessibleProjectRows(ctx, user)) {
        visible.set(row.id, row);
      }
    }

    // Cross-reference visibility for the inbox judgement — the whole
    // readable set, which is wider than `visible` on a pinned stream.
    // Invalidated rather than recomputed, so a connection that never judges
    // anything never pays for it.
    let crossRefVisible: VisibleProjects | null = null;

    const queue: Array<{ projectId: number; event: ChangeEvent }> = [];
    // Kept out of `queue` on purpose: INBOX_JUDGE_QUEUE_MAX measures how
    // many events are waiting to be judged, and a `me` event triggers no
    // judgement. Mixing the two would make that threshold read high for
    // work that never happens.
    const meQueue: MeEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = ctx.bus.subscribe((projectId, event) => {
      queue.push({ projectId, event });
      wake?.();
    });
    // Only an opt-in connection registers: `?inbox=1` now means "send me
    // the inbox signals computed for me", of which this is one.
    const unsubscribeMe = wantInbox
      ? ctx.bus.subscribeMe(user.id, (event) => {
          meQueue.push(event);
          wake?.();
        })
      : null;
    // Process shutdown must end the stream from the server side: SSE
    // responses never finish on their own, and every one of them would
    // otherwise hold `server.close()` open until it is severed (T-56).
    const shutdown = ctx.shutdown.signal;
    const onShutdown = () => wake?.();
    shutdown.addEventListener("abort", onShutdown);
    stream.onAbort(() => wake?.());

    /**
     * Which row does the event's issue occupy in this receiver's inbox now,
     * or `null` for none? `undefined` means the server declined to work it
     * out, which the client reads as "refetch anyway" — so every way out of
     * here other than a row or a `null` is safe, only slower.
     */
    const judge = async (
      project: ProjectRow,
      event: ChangeEvent,
    ): Promise<InboxRowState | null | undefined> => {
      if (event.issue_number === undefined) return undefined;
      if (!INBOX_ENTITIES.has(event.entity)) return undefined;
      if (queue.length > INBOX_JUDGE_QUEUE_MAX) return undefined;
      try {
        crossRefVisible ??= await visibleProjects(ctx, user);
        // Read per judgement, never cached: changing a preference emits no
        // change event, so a cached copy could go stale in the one direction
        // that matters — a card that should light the badge and does not.
        const prefs = await readPrefs(ctx.router.system(), user.id);
        const db = await ctx.router.forProject(routeInfoOf(project));
        return await inboxRowState(
          db,
          project,
          user,
          event.issue_number,
          prefs,
          crossRefVisible,
        );
      } catch (err) {
        // Loud but not fatal: an exception must never reach the drain loop.
        console.error("sse: inbox judgement failed", err);
        return undefined;
      }
    };

    /**
     * Does this connection want to hear about that namespace? A membership
     * test on a set held in memory — deliberately not routed through
     * `judge()`, whose queue length measures events waiting on database
     * work, which this is not.
     */
    const wantsMetadata = (event: ChangeEvent): boolean => {
      if (wantMetadata === undefined) return false;
      if (wantMetadata === "*") return true;
      const namespace = event.metadata?.namespace;
      return namespace !== undefined && wantMetadata.includes(namespace);
    };

    const send = async (project: ProjectRow, event: ChangeEvent) => {
      if (event.entity === "metadata" && !wantsMetadata(event)) return;
      const payload: CrossChangeEvent = { ...event, project: project.slug };
      if (wantInbox) {
        const row = await judge(project, event);
        // `null` is an answer and has to travel; only `undefined` omits the
        // key, which is how the client tells "not in your inbox" apart from
        // "the server did not work it out".
        if (row !== undefined) payload.inbox_row = row;
      }
      return stream.writeSSE({
        event: SSE_CHANGE_EVENT,
        data: JSON.stringify(payload),
      });
    };

    const recompute = async () => {
      const rows = await accessibleProjectRows(ctx, user);
      visible.clear();
      for (const row of rows) {
        if (scope.kind === "all" || row.id === scope.row.id) {
          visible.set(row.id, row);
        }
      }
      // The pinned scope carries its own copy for the close-out messages.
      if (scope.kind === "project") {
        const row = visible.get(scope.row.id);
        if (row !== undefined) scope.row = row;
      }
      // What the caller can read just moved, and the judgement filters
      // cross-references against exactly that.
      crossRefVisible = null;
    };

    // Flipped instead of breaking out directly so the revocation paths deep
    // in the drain loop share the loop's single exit (and its cleanup).
    let closed = false;

    try {
      // Lets clients (and tests) know the subscription is live.
      await stream.writeSSE({ event: "hello", data: "{}" });

      while (!closed && !stream.aborted && !shutdown.aborted) {
        while (meQueue.length > 0 && !stream.aborted && !closed) {
          const event = meQueue.shift() as MeEvent;
          await stream.writeSSE({
            event: SSE_ME_EVENT,
            data: JSON.stringify(event),
          });
        }
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
              // leaves the project unknown, and then there is nothing to say.
              const before = visible.get(projectId);
              try {
                await recompute();
              } catch {
                closed = true; // fail-closed: reconnect rebuilds the set
                continue;
              }
              const row = visible.get(projectId) ?? before;
              if (row !== undefined) await send(row, event);
              continue;
            }
            if (projectId === scope.row.id && event.action === "deleted") {
              // Revoked mid-stream: say why, then close (this is the hole
              // the pre-T-122 route had — the subscription outlived access).
              await send(scope.row, event);
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
              const row = visible.get(projectId);
              if (row !== undefined) {
                await send(row, event);
                visible.delete(projectId);
                // recompute() is deliberately not called on this path — the
                // send above needs the project as it was — so the
                // judgement's set has to be dropped by hand, or it would go
                // on filtering references against a project that is gone.
                crossRefVisible = null;
              }
              continue;
            }
          }
          if (
            event.entity === "project" &&
            scope.kind === "project" &&
            projectId === scope.row.id &&
            event.action === "deleted"
          ) {
            await send(scope.row, event);
            closed = true;
            continue;
          }

          const row = visible.get(projectId);
          if (row !== undefined) await send(row, event);
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
      unsubscribeMe?.();
      shutdown.removeEventListener("abort", onShutdown);
    }
  });
}

export function sseRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(userEventsRoute, async (c) =>
    streamChanges(
      c,
      c.get("appCtx"),
      c.get("user"),
      { kind: "all" },
      c.req.valid("query").inbox === "1",
      c.req.valid("query").metadata,
    ),
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
    return streamChanges(
      c,
      ctx,
      user,
      { kind: "project", row: project },
      c.req.valid("query").inbox === "1",
      c.req.valid("query").metadata,
    );
  });

  return app;
}
