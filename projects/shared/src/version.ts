// Node-only (spawns git): imported by the CLI and the server, never by web —
// the web build embeds its version through vite `define` instead.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUILD_VERSION } from "./build-info.ts";

export type VersionDeps = {
  buildVersion: string | null;
  /** Test seam; production uses git describe. */
  exec?: () => string;
};

// One command carries the whole version-string rule: exactly on a tag it
// prints `v0.2.0` (the release form), otherwise `v0.1.0-49-g79b2ac8` with a
// `-dirty` suffix for uncommitted tracked changes, and a bare short sha when
// no tag is reachable.
const gitDescribe = () =>
  execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
    // The module's own directory, not the process cwd: the CLI habitually
    // runs inside other people's repositories.
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });

export function createVersionResolver(deps: VersionDeps): () => string {
  // Memoized in the resolver itself so no call site — present or future —
  // can unknowingly re-spawn git on every call.
  let cached: string | undefined;
  return () => {
    cached ??= compute(deps);
    return cached;
  };
}

function compute({ buildVersion, exec = gitDescribe }: VersionDeps): string {
  if (buildVersion) return buildVersion;
  try {
    return exec().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export const resolveVersion = createVersionResolver({
  buildVersion: BUILD_VERSION,
});
