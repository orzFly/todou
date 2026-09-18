/**
 * Every `/api` failure the client throws is a `TodouError`, which carries the
 * HTTP status the server answered with; network-level failures carry none.
 * The three error states in `AuthedLayout` and the custom `throwOnError` in
 * `ProjectLayout` all branch on this, so the cast lives here rather than
 * being repeated per call site.
 */
export function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

/**
 * Classifies read failures by whether cached content is still safe to show.
 * A refused request makes that cache known-stale, while session loss belongs
 * to AuthedLayout so page-level reads stay silent.
 */
export type ReadFailureKind = "transient" | "refused" | "session";

export function classifyReadFailure(error: unknown): ReadFailureKind {
  const status = statusOf(error);
  if (status === 401) return "session";
  if (status !== undefined && status >= 400 && status < 500) return "refused";
  return "transient";
}
