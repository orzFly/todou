import { defineConfig } from "vitest/config";

// PGlite-heavy suites: WASM instance startup plus migrations can blow the
// 5s default when all files run in parallel (the worker-host and crash
// suites spawn extra instances on top of each file's own databases).
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
