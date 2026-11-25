import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// One command carries the whole version-string rule: exactly on a tag it
// prints `v0.2.0` (the release form), otherwise `v0.1.0-49-g79b2ac8e1` with a
// `-dirty` suffix for uncommitted tracked changes, and a bare short sha when
// no tag is reachable.
export const gitDescribe = (): string =>
  execFileSync(
    "git",
    ["describe", "--tags", "--always", "--abbrev=9", "--dirty"],
    {
      // The module's own directory, not the process cwd: the CLI habitually
      // runs inside other people's repositories.
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    },
  );
