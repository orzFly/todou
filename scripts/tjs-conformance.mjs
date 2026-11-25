#!/usr/bin/env node
// Usage: tjs-conformance.mjs <tjs>
//
// Bundles projects/cli/tjs/conformance/run.ts with the tjs build's own
// configuration — the flags come from bundle-cli.sh, so the shims under test
// are the ones the executables carry — and runs it on the given tjs. The
// same cases run against Node's modules in projects/cli/test/
// tjs-conformance.test.ts. esbuild comes from PATH, as in bundle-cli.sh.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [tjs] = process.argv.slice(2);
if (tjs === undefined) {
  console.error("usage: tjs-conformance.mjs <tjs>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = execFileSync(
  "bash",
  [join(root, "scripts/bundle-cli.sh"), "--tjs-flags", root],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((flag) => flag !== "");

mkdirSync(join(root, ".tmp"), { recursive: true });
const scratch = mkdtempSync(join(root, ".tmp", "tjs-conformance-"));
try {
  const bundle = join(scratch, "run.mjs");
  execFileSync(
    "esbuild",
    [
      join(root, "projects/cli/tjs/conformance/run.ts"),
      ...flags,
      "--log-level=warning",
      `--outfile=${bundle}`,
    ],
    { stdio: "inherit" },
  );
  // TJS_HOME keeps `tjs run` from creating ~/.tjs in the caller's home.
  const result = spawnSync(resolve(tjs), ["run", bundle], {
    stdio: "inherit",
    env: { ...process.env, TJS_HOME: join(scratch, "tjs-home") },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
