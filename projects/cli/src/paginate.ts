import { drainPaged as drainPagedShared, MAX_DRAIN_PAGES } from "@todou/shared";
import { CliError } from "./errors.ts";

export { MAX_DRAIN_PAGES };

/**
 * `drainPaged` with the CLI's error vocabulary bound in. The loop itself
 * lives in `@todou/shared` because the web drains the same way (T-307); the
 * only CLI-specific part is the exhaustion hint, which tells an operator that
 * the anomaly is the server's and that a retry costs nothing.
 */
export function drainPaged<T>(
  label: string,
  after: string | undefined,
  fetchPage: (
    after: string | undefined,
  ) => Promise<{ items: T[]; next_cursor: string | null; has_more?: boolean }>,
): Promise<{ items: T[]; cursor: string | undefined }> {
  return drainPagedShared(
    label,
    after,
    fetchPage,
    (message) =>
      new CliError(
        message,
        "this is a server-side pagination anomaly, not a CLI usage error; nothing was printed, so it is safe to retry once the server is fixed",
      ),
  );
}
