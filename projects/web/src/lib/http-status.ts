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
