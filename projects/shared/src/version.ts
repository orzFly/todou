// Node-only (spawns git): imported by the CLI and the server, never by web —
// the web build embeds its version through vite `define` instead. The spawn
// sits behind `#git-describe` so that the CLI's single-file build, which has
// no synchronous process API, can swap it for a stub (T-792).
import { gitDescribe } from "#git-describe";
import { BUILD_VERSION } from "./build-info.ts";

/** null in a source run; the version string in every packaged build. */
export { BUILD_VERSION };

export type VersionDeps = {
  buildVersion: string | null;
  /** Test seam; production uses git describe. */
  exec?: () => string;
};

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
