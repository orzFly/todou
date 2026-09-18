#!/usr/bin/env node
/**
 * Manual real-Chromium layout smoke for board overlay scrollbars and collapsed
 * assignee badge clipping. It is intentionally independent of `pnpm test`/CI.
 *
 * Usage: node scripts/browser-layout-smoke.mjs [--self-test|--self-test-cdp] [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium). The runner starts one
 * isolated API/Vite stack and one browser, then gives each sequential case a
 * unique real project and fresh browser contexts/pages.
 * Exit codes: 0 all checks pass; 1 a layout/self-test assertion fails; 2 bad
 * CLI input, missing prerequisite, startup failure, or cleanup failure.
 * Limitations: headless Chromium measures CSS geometry/opacity, not painted
 * pixel antialiasing, platform scrollbar themes, touch, or mobile browser UI.
 * After editing scripts/lib/, run --self-test-cdp, then all three browser
 * self-tests: pnpm test:browser --self-test;
 * pnpm test:browser:overlay --self-test;
 * pnpm exec node scripts/user-baseline-smoke.mjs --self-test.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBadgeClip } from "./browser/badge-clip.mjs";
import { runBoardScrollbars } from "./browser/board-scrollbars.mjs";
import { selfCheckCdpPipe, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HELP = `browser-layout-smoke — manual real-browser layout assertions

Usage:
  node scripts/browser-layout-smoke.mjs
  pnpm test:browser --self-test
  pnpm test:browser --self-test-cdp

Options:
  --self-test  Prove each checker with an injected fault and a fresh clean page.
  --self-test-cdp  Check CDP pipe framing, failures, timeouts, and sessions without Chromium.
  --keep       Keep the complete isolated stack directory after the run.
  --help       Print this help and exit.

After changing scripts/lib/:
  pnpm test:browser --self-test-cdp
  pnpm test:browser --self-test
  pnpm test:browser:overlay --self-test
  pnpm exec node scripts/user-baseline-smoke.mjs --self-test

Preconditions:
  Node 24+ from the devshell, workspace dependencies, flock, and Chromium at
  CHROMIUM (default /usr/bin/chromium). No existing app is reused.

Exit codes:
  0 checks passed; 1 named layout/self-test assertion failed; 2 usage,
  prerequisite, stack/browser startup, or cleanup failed.

Limitations:
  Headless Chromium checks CSS geometry and opacity, not painted-pixel
  antialiasing, OS scrollbar themes, touch behavior, or mobile browser chrome.
`;

function parseArgs(argv) {
  const options = {
    selfTest: false,
    selfTestCdp: false,
    keep: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--self-test-cdp") options.selfTestCdp = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.selfTestCdp && (options.selfTest || options.keep))
    throw new Error(
      "--self-test-cdp cannot be combined with --self-test or --keep",
    );
  return options;
}

function failuresOf(result, selfTest) {
  if (selfTest) return result.failures ?? [];
  return result.passes.flatMap((pass) => pass.failures ?? []);
}

const COVERAGE_FAILURES = new Set([
  "case-exception",
  "todo-request-intercept",
  "paused-loading-samples",
  "self-test-baseline-coverage",
  "self-test-fault-coverage",
  "self-test-restoration-coverage",
  "fault-injection-not-confirmed",
  "real-scroll-not-observed",
  "self-test-injection",
  "collapsed-group-missing",
  "collapsed-group-not-closed",
  "assignee-summary-target-missing",
  "target-machine-badges-missing",
  "fixture-machine-badge-mismatch",
  "expected-clipping-allowance-missing",
  "clipping-ancestor-missing",
  "641-horizontal-overflow-missing",
  "641-truncation-contract",
]);

function isCoverageFailure(entry) {
  return COVERAGE_FAILURES.has(entry.name);
}

function compactCase(result, selfTest, elapsedMs) {
  const failures = failuresOf(result, selfTest);
  return {
    name: result.name,
    status: failures.length ? "fail" : "pass",
    elapsedMs,
    failures,
    passes: result.passes.map((pass) => ({
      name: pass.name,
      failures: pass.failures,
      ...(pass.intercept ? { intercept: pass.intercept } : {}),
      ...(pass.injectionConfirmed !== undefined
        ? { injectionConfirmed: pass.injectionConfirmed }
        : {}),
      ...(pass.mutationConfirmed !== undefined
        ? { mutationConfirmed: pass.mutationConfirmed }
        : {}),
      sampleCount: pass.samples?.length,
      widths: pass.measurements?.map((measurement) => measurement.width),
    })),
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`browser-layout-smoke: ${error.message}\nTry --help.`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.selfTestCdp) {
    try {
      console.log(`CDP ${JSON.stringify(await selfCheckCdpPipe())}`);
      return 0;
    } catch (error) {
      console.error(
        `browser-layout-smoke CDP self-test: ${error.stack ?? error}`,
      );
      return 2;
    }
  }

  const startedAt = Date.now();
  let stack;
  let browser;
  let exitCode = 0;
  const cases = [];
  try {
    const stackStage = Date.now();
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "browser-layout-smoke-",
      keep: options.keep,
    });
    stack.timings.stackStartupMs = Date.now() - stackStage;
    const browserStage = Date.now();
    browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.timings.browserStartupMs = Date.now() - browserStage;
    stack.addCleanup(() => browser.close());

    for (const [name, run] of [
      ["board-scrollbars", runBoardScrollbars],
      ["badge-clip", runBadgeClip],
    ]) {
      const stage = Date.now();
      try {
        const result = await run({
          browser,
          stack,
          selfTest: options.selfTest,
        });
        const summary = compactCase(
          result,
          options.selfTest,
          Date.now() - stage,
        );
        cases.push(summary);
        console.log(`CASE ${JSON.stringify(summary)}`);
      } catch (error) {
        const summary = {
          name,
          status: "fail",
          elapsedMs: Date.now() - stage,
          failures: [
            {
              name: "case-exception",
              kind: "coverage",
              detail: error.stack ?? String(error),
            },
          ],
          passes: [],
        };
        cases.push(summary);
        console.log(`CASE ${JSON.stringify(summary)}`);
      }
    }

    const allFailures = cases.flatMap((entry) => entry.failures);
    exitCode =
      allFailures.length === 0
        ? 0
        : allFailures.some(isCoverageFailure)
          ? 2
          : 1;
    stack.timings.casesMs = cases.reduce(
      (sum, entry) => sum + entry.elapsedMs,
      0,
    );
    stack.timings.runMs = Date.now() - startedAt;
    if (exitCode !== 0 && !options.keep) {
      stack.keep = {
        remove: ["attachments", "chrome", "db"],
        message: `kept failure artifacts: ${stack.dir}`,
      };
    }
  } catch (error) {
    exitCode = 2;
    console.error(`browser-layout-smoke startup: ${error.stack ?? error}`);
    if (stack && !options.keep) {
      stack.keep = {
        remove: ["attachments", "chrome", "db"],
        message: `kept failure artifacts: ${stack.dir}`,
      };
    }
  } finally {
    if (stack) {
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        console.error(`browser-layout-smoke cleanup: ${error.stack ?? error}`);
      }
    }
  }
  const report = {
    name: "browser-layout-smoke",
    mode: options.selfTest ? "self-test" : "clean",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    timings: stack?.timings ?? { totalMs: Date.now() - startedAt },
    resources: stack?.resources ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (exitCode !== 0 && stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "browser-layout-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
