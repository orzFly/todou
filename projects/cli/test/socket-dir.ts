import { tmpdir } from "node:os";

/**
 * Where a test that binds a Unix socket makes its temp dirs.
 *
 * macOS caps a socket path at 104 bytes, and its default TMPDIR
 * (`/var/folders/…/T/`) spends half of that before a test has nested a
 * `mkdtemp` dir or two and a socket name under it — the bind then fails with
 * EINVAL. `/private/tmp` is the short spelling of the same kind of place,
 * already resolved, so a path a child process reports back still compares
 * equal to the one built here. Production paths are not affected: they hang
 * off the peer's socket directory or a single `todou-omp/` level (T-591).
 */
export function socketTmpdir(): string {
  return process.platform === "darwin" ? "/private/tmp" : tmpdir();
}
