import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BatchInput,
  type BatchItemResult,
  type BatchRequestItem,
  BatchResult,
  SSE_BATCH_DONE_EVENT,
  SSE_BATCH_ITEM_EVENT,
} from "@todou/shared";
import { streamSSE } from "hono/streaming";
import { parseAccept } from "hono/utils/accept";
import type { AppEnv } from "../auth/middleware.ts";
import type { AppContext } from "../bootstrap.ts";

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const batchRoute = createRoute({
  method: "post",
  path: "/batch",
  summary: "Dispatch several read-only GETs in one exchange (T-91)",
  description:
    "Each sub-request runs through the full middleware chain, so " +
    "authorization is enforced per item, not on the envelope. Items are " +
    "isolated: one failing sub-request becomes its error entry without " +
    "affecting the rest. Content negotiation on Accept (T-368): a request " +
    "carrying `text/event-stream` with q > 0 answers 200 text/event-stream " +
    "with one `item` frame per sub-request as it completes — " +
    'data: {"index":<position in requests>,"status":<number>,"body":…} — ' +
    'followed by a `done` trailer frame, data: {"count":<item frames ' +
    "sent>}. Frames arrive in completion order, not request order, so `index` " +
    "is the only correlation key. Any other Accept gets the JSON envelope " +
    "below, positionally matched to the requests array.",
  request: { body: jsonBody(BatchInput) },
  responses: {
    200: {
      description: "Item results",
      content: {
        "application/json": { schema: BatchResult },
        "text/event-stream": { schema: z.string() },
      },
    },
  },
});

/**
 * Explicit `text/event-stream` with q > 0, per parseAccept — a substring
 * test would read `text/event-stream;q=0`, which is a refusal, as consent.
 */
function wantsEventStream(acceptHeader: string | undefined): boolean {
  if (acceptHeader === undefined) return false;
  return parseAccept(acceptHeader).some(
    (a) => a.type === "text/event-stream" && a.q > 0,
  );
}

const itemError = (
  status: number,
  code: string,
  message: string,
): BatchItemResult => ({ status, body: { error: { code, message } } });

/**
 * null = allowed. Rejections are per-item envelope entries — the batch
 * itself only fails on envelope shape (422 via the input schema).
 */
export function rejectBatchTarget(url: string): BatchItemResult | null {
  if (!url.startsWith("/") || url.includes("://")) {
    return itemError(
      400,
      "batch_target_not_allowed",
      "urls are /api-relative paths",
    );
  }
  const path = url.split("?", 1)[0] ?? url;
  if (path === "/batch" || path.startsWith("/batch/")) {
    return itemError(400, "batch_target_not_allowed", "no recursive batches");
  }
  // The SSE stream never ends; reading it would hang the envelope.
  if (/^\/projects\/[^/]+\/events$/.test(path)) {
    return itemError(
      400,
      "batch_target_not_allowed",
      "event streams cannot be batched",
    );
  }
  return null;
}

/** Only these travel to sub-requests. No accept-encoding: forwarding it
 *  would let the compression middleware encode bodies the gateway then
 *  has to decode to re-envelope. */
const FORWARDED_HEADERS = ["cookie", "authorization"] as const;

/**
 * Forward mode carries the identity in proxy-set headers rather than in a
 * cookie, so a sub-request that does not repeat them is anonymous however
 * the envelope arrived. The names are configuration, hence resolved per
 * request instead of living in the const above.
 */
function forwardedHeaderNames(ctx: AppContext): string[] {
  if (ctx.config.auth.mode !== "forward") return [...FORWARDED_HEADERS];
  const forward = ctx.config.auth.forward;
  return [
    ...FORWARDED_HEADERS,
    ...[forward.user_header, forward.name_header, forward.email_header].filter(
      (name): name is string => name !== undefined,
    ),
  ];
}

// Method shorthand, not a property: the assembled app's fetch declares its
// own env type, and only bivariance lets it satisfy this shape.
type Dispatcher = {
  fetch(request: Request, env?: unknown): Response | Promise<Response>;
};

/**
 * `getApp` breaks the cycle between this route and the assembled app it
 * re-enters: the reference is only needed at request time, well after
 * createApp has finished wiring.
 */
export function batchRoutes(getApp: () => Dispatcher) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(batchRoute, async (c) => {
    const { requests } = c.req.valid("json");
    const headers = new Headers();
    for (const name of forwardedHeaderNames(c.get("appCtx"))) {
      const value = c.req.raw.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (wantsEventStream(c.req.header("accept"))) {
      return streamSSE(c, async (stream) => {
        // Every sub-request is already in flight here; the loop only decides
        // when each settled result is written, so an item finishing early is
        // delivered before its slower siblings rather than held for them.
        const pending = new Map<
          number,
          Promise<{ index: number; result: BatchItemResult }>
        >(
          requests.map(
            (
              { url }: BatchRequestItem,
              index: number,
            ): [
              number,
              Promise<{ index: number; result: BatchItemResult }>,
            ] => [
              index,
              dispatchItem(getApp, headers, c.env, url).then((result) => ({
                index,
                result,
              })),
            ],
          ),
        );
        let written = 0;
        while (!stream.aborted && pending.size > 0) {
          // dispatchItem never rejects, so the race cannot interrupt the
          // write loop with an exception mid-stream.
          const { index, result } = await Promise.race(pending.values());
          pending.delete(index);
          await stream.writeSSE({
            event: SSE_BATCH_ITEM_EVENT,
            data: JSON.stringify({ index, ...result }),
          });
          written++;
        }
        if (stream.aborted) return;
        await stream.writeSSE({
          event: SSE_BATCH_DONE_EVENT,
          data: JSON.stringify({ count: written }),
        });
      });
    }
    const responses = await Promise.all(
      requests.map(({ url }: BatchRequestItem) =>
        dispatchItem(getApp, headers, c.env, url),
      ),
    );
    return c.json({ responses }, 200);
  });

  return app;
}

/**
 * One sub-request, re-dispatched through the full app. Never rejects: a
 * dispatch that throws (a body declaring JSON it does not carry, say)
 * becomes that item's 502, because in stream mode the response head is
 * already gone and the JSON branch's whole-batch 500 has nowhere to go —
 * and the route's own promise is per-item isolation anyway.
 */
async function dispatchItem(
  getApp: () => Dispatcher,
  headers: Headers,
  env: unknown,
  url: string,
): Promise<BatchItemResult> {
  try {
    const rejected = rejectBatchTarget(url);
    if (rejected) return rejected;
    const res = await getApp().fetch(
      new Request(new URL(`/api${url}`, "http://batch.internal"), {
        headers,
      }),
      // Proxy trust is decided on the peer address of the node socket,
      // which lives in the env rather than in the request — a
      // sub-request dispatched without it has no peer at all, and
      // forward mode 401s every item as untrusted.
      env,
    );
    if (res.status === 204) return { status: 204, body: null };
    if (!res.headers.get("content-type")?.includes("application/json")) {
      await res.body?.cancel();
      return itemError(
        502,
        "batch_target_not_json",
        "sub-response is not JSON",
      );
    }
    return { status: res.status, body: await res.json() };
  } catch {
    return itemError(502, "batch_target_failed", "sub-request dispatch failed");
  }
}
