import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const createdTmpDirs: string[] = [];

/**
 * `mkdtemp` under the system temp dir, removed when the test file finishes.
 * Every temp dir a server test creates must come from here.
 */
export function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

// The registry lives here rather than in helpers.ts so that setupFiles doesn't
// drag helpers -> app -> bootstrap into every test file, including the pure
// logic ones that never touch a database (that import graph alone costs ~71s
// across the suite). Without this hook the mkdtemp'd todou-* dirs stay in /tmp
// forever, and /tmp is RAM on this machine. Best-effort: a fork the OOM killer
// takes out never reaches afterAll — those leftovers are the dev machine's
// tmpfs sweeper's job (T-168) — but the steady-state leak stops here.
afterAll(() => {
  for (const dir of createdTmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
