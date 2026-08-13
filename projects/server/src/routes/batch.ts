import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import {
  BatchInput,
  type BatchItemResult,
  type BatchRequestItem,
  BatchResult,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";

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
    "affecting the rest.",
  request: { body: jsonBody(BatchInput) },
  responses: { 200: { description: "Item results", ...jsonBody(BatchResult) } },
});

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

type Dispatcher = { fetch: (request: Request) => Response | Promise<Response> };

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
    for (const name of FORWARDED_HEADERS) {
      const value = c.req.raw.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    const responses = await Promise.all(
      requests.map(
        async ({ url }: BatchRequestItem): Promise<BatchItemResult> => {
          const rejected = rejectBatchTarget(url);
          if (rejected) return rejected;
          const res = await getApp().fetch(
            new Request(new URL(`/api${url}`, "http://batch.internal"), {
              headers,
            }),
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
        },
      ),
    );
    return c.json({ responses }, 200);
  });

  return app;
}
