import { rmSync } from "node:fs";
import { afterAll } from "vitest";

/** Storage directories `testConfig()` created, for the cleanup below. */
export const createdStorageDirs: string[] = [];

// The list lives here rather than in helpers.ts so that setupFiles doesn't
// drag helpers -> app -> bootstrap into every test file, including the pure
// logic ones that never touch a database (that import graph alone costs ~71s
// across the suite). Without this hook the mkdtemp'd todou-storage-* dirs stay
// in /tmp forever, and /tmp is RAM on this machine. Best-effort: a fork the
// OOM killer takes out never reaches afterAll — but the steady-state leak stops
// here.
afterAll(() => {
  for (const dir of createdStorageDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
