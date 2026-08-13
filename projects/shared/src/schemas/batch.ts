import { z } from "zod";

// Read-only batch gateway (T-91): one HTTP exchange carrying several GET
// sub-requests, each re-dispatched through the full middleware chain so
// authorization stays per-item. Envelope-shape failures are a 422 on the
// whole batch; allowlist failures are per-item entries in the response.

export const BATCH_MAX_REQUESTS = 50;

/** An /api-relative URL, query string included. */
export const BatchRequestItem = z.object({
  url: z.string().min(1).max(2048),
});
export type BatchRequestItem = z.infer<typeof BatchRequestItem>;

export const BatchInput = z.object({
  requests: z.array(BatchRequestItem).min(1).max(BATCH_MAX_REQUESTS),
});
export type BatchInput = z.infer<typeof BatchInput>;

/** Positionally matched to the request array; body is null for 204s. */
export const BatchItemResult = z.object({
  status: z.number().int(),
  body: z.unknown(),
});
export type BatchItemResult = z.infer<typeof BatchItemResult>;

export const BatchResult = z.object({
  responses: z.array(BatchItemResult),
});
export type BatchResult = z.infer<typeof BatchResult>;
