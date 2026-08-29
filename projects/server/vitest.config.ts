import os from "node:os";
import { defineConfig } from "vitest/config";

// A fork runs one test file at a time, and a server test file stands up
// several in-memory PGlite (WASM) instances: measured 2026-08-29 on 24 cores
// / 31 GiB, the first instance costs ~680 MB RSS and each further one ~230 MB,
// putting a fork at ~3 GB on average and ~5 GB for the heaviest file. So the
// cap has to come from "per-worker memory x workers < memory available", not
// from the core count — vitest's default (one worker per core) would want
// 72 GB here and gets the whole run OOM-killed instead, with zero assertion
// failures to show for it. The budget is 60% of total memory; the rest is for
// the OS, for tmpfs (/tmp is RAM here), and for the other agents sharing this
// machine. If a future machine OOMs again, the number to re-measure is the
// 3 GB constant (the suite got heavier) — not the shape of the formula.
const PEAK_WORKER_BYTES = 3 * 2 ** 30;
const MEMORY_BUDGET_FRACTION = 0.6;
const maxWorkers = Math.min(
  Math.max(
    1,
    Math.floor((os.totalmem() * MEMORY_BUDGET_FRACTION) / PEAK_WORKER_BYTES),
  ),
  os.availableParallelism(),
);

// The 20s timeouts stay even with the worker cap: they defend against other
// agents running their own suites on this shared machine, where PGlite startup
// plus migrations still blow well past the 5s default. A green run pays
// nothing for them, and lowering them reopens exactly the "no assertion
// failed, yet it timed out" flake this cap exists to kill.
export default defineConfig({
  test: {
    maxWorkers,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
  },
});
