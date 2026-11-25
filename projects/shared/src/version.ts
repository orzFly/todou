// Node-only (spawns git): imported by the CLI and the server, never by web —
// the web build embeds its version through vite `define` instead. The spawn
// sits behind `#git-describe` so that the CLI's single-file build, which
// cannot run git, can swap it for a stub (T-792).
import { gitDescribe } from "#git-describe";
import { BUILD_VERSION } from "./build-info.ts";

/** null in a source run; the version string in every packaged build. */
export { BUILD_VERSION };

export type VersionDeps = {
  buildVersion: string | null;
  /** Test seam; production uses git describe. */
  exec?: () => Promise<string>;
};

export function createVersionResolver(
  deps: VersionDeps,
): () => Promise<string> {
  // Memoized in the resolver itself so no call site — present or future —
  // can unknowingly re-spawn git on every call.
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= compute(deps);
    return cached;
  };
}

async function compute({
  buildVersion,
  exec = gitDescribe,
}: VersionDeps): Promise<string> {
  if (buildVersion) return buildVersion;
  try {
    return (await exec()).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export const resolveVersion = createVersionResolver({
  buildVersion: BUILD_VERSION,
});
