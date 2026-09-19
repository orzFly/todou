#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assess,
  installCodeRoles,
  installRoles,
  measureRoles,
  rowKey,
} from "./browser/diff-colors.mjs";
import { FAULTS, injectFault } from "./browser/diff-colors-faults.mjs";
import {
  openDiffPage,
  seedDiffFixture,
} from "./browser/diff-colors-fixture.mjs";
import {
  staticPreRule,
  verifyThemeTransitions,
} from "./browser/diff-colors-theme.mjs";
import { startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE_REVISION = "53b4d71b8f8a74d802dad640c786b2722d804945";
const options = {
  selfTest: false,
  faultsOnly: false,
  faults: null,
  capture: null,
  sourceRoot: ROOT,
  themes: null,
  surfaces: null,
  probe: false,
  limit: null,
  offset: 0,
  workers: 1,
};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--self-test") options.selfTest = true;
  else if (arg === "--faults-only") options.faultsOnly = true;
  else if (arg === "--faults")
    options.faults = (process.argv[++i] ?? "").split(",");
  else if (arg === "--capture-baseline") options.capture = process.argv[++i];
  else if (arg === "--source-root")
    options.sourceRoot = resolve(process.argv[++i]);
  else if (arg === "--themes") options.themes = process.argv[++i].split(",");
  else if (arg === "--surfaces")
    options.surfaces = process.argv[++i].split(",");
  else if (arg === "--probe") options.probe = true;
  else if (arg === "--limit") options.limit = Number(process.argv[++i]);
  else if (arg === "--offset") options.offset = Number(process.argv[++i]);
  else if (arg === "--workers") options.workers = Number(process.argv[++i]);
  else if (arg === "--help") {
    console.log(
      "node scripts/diff-colors-smoke.mjs [--capture-baseline PATH --source-root CLEAN_CHECKOUT] [--self-test [--faults-only [--faults ID,...]]] [--workers N (1-3, default 1)]\nDevelopment only: --themes NAME,... --surfaces rendered,source,issue,plain,files --probe --limit N --offset N",
    );
    process.exit(0);
  } else throw new Error(`unknown argument ${arg}`);
}
if (
  options.limit !== null &&
  (!Number.isSafeInteger(options.limit) || options.limit < 1 || !options.probe)
)
  throw new Error("--limit requires --probe and a positive integer");
if (
  !Number.isSafeInteger(options.offset) ||
  options.offset < 0 ||
  (options.offset && !options.probe)
)
  throw new Error("--offset requires --probe and a nonnegative integer");
if (
  !Number.isSafeInteger(options.workers) ||
  options.workers < 1 ||
  options.workers > 3
)
  throw new Error("--workers requires an integer from 1 to 3");
if (options.faultsOnly && !options.selfTest)
  throw new Error("--faults-only requires --self-test");
if (options.faults && !options.faultsOnly)
  throw new Error("--faults requires --faults-only");
if (
  options.faultsOnly &&
  (options.capture ||
    options.probe ||
    options.themes ||
    options.surfaces ||
    options.limit !== null ||
    options.offset)
)
  throw new Error(
    "--faults-only cannot be combined with capture or matrix/probe filters",
  );
if (
  options.faults &&
  (new Set(options.faults).size !== options.faults.length ||
    options.faults.some((id) => !FAULTS.some((fault) => fault.id === id)))
)
  throw new Error("--faults requires unique known fault IDs");
const selectedFaults = FAULTS.filter(
  (fault) => !options.faults || options.faults.includes(fault.id),
);
const themeSource = readFileSync(
  join(options.sourceRoot, "projects/web/src/lib/theme.ts"),
  "utf8",
);
const registry = [
  ...themeSource.matchAll(/value:\s*"([^"]+)"[\s\S]*?kind:\s*"(light|dark)"/g),
].map(([, value, kind]) => ({ value, kind }));
if (
  registry.length !== 19 ||
  new Set(registry.map((t) => t.value)).size !== registry.length
)
  throw new Error(
    "theme registry changed: review and extend the explicit coverage contract",
  );
const themes = registry.filter(
  (t) => !options.themes || options.themes.includes(t.value),
);
if (
  !themes.length ||
  options.themes?.some((t) => !registry.some((r) => r.value === t))
)
  throw new Error("unknown theme selection");
const baselinePath = resolve(ROOT, "scripts/browser/diff-colors-baseline.json");
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : null;
const assertOriginalSource = () => {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: options.sourceRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", "projects"],
    { cwd: options.sourceRoot, encoding: "utf8" },
  ).trim();
  if (revision !== BASE_REVISION || dirty)
    throw new Error(
      "capture requires unchanged source at the user-approved original revision",
    );
};
const validColor = (value) =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every(
    (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
  );
if (options.capture) {
  if (
    options.themes ||
    options.surfaces ||
    options.selfTest ||
    options.probe ||
    options.limit ||
    options.offset
  )
    throw new Error("baseline capture requires the complete matrix");
  assertOriginalSource();
  if (existsSync(resolve(ROOT, options.capture)))
    throw new Error(
      "baseline already exists; refusing to overwrite immutable evidence",
    );
}
if (
  !options.capture &&
  !options.probe &&
  (!baseline ||
    baseline.revision !== BASE_REVISION ||
    !baseline.colors ||
    typeof baseline.colors !== "object" ||
    Array.isArray(baseline.colors) ||
    !Object.keys(baseline.colors).length ||
    !Object.values(baseline.colors).every(validColor) ||
    !registry.every((theme) =>
      ["addition", "deletion"].every((side) =>
        validColor(baseline.bases?.[theme.value]?.[side]),
      ),
    ))
)
  throw new Error(
    "missing or malformed immutable original-source baseline; capture from the preserved clean checkout first",
  );
const matrix = [];
for (const theme of themes)
  for (const width of [1280, 390]) {
    for (const surface of [
      "rendered",
      "source",
      "issue",
      "plain",
      ...(width === 390 ? ["files"] : []),
    ])
      matrix.push({
        theme: theme.value,
        kind: theme.kind,
        width,
        surface,
        status: "unreviewed",
        draft: false,
      });
    for (const status of ["approved", "changes_requested"])
      matrix.push({
        theme: theme.value,
        kind: theme.kind,
        width,
        surface: "rendered",
        status,
        draft: false,
      });
    matrix.push({
      theme: theme.value,
      kind: theme.kind,
      width,
      surface: "rendered",
      status: "unreviewed",
      draft: true,
    });
    matrix.push({
      theme: theme.value,
      kind: theme.kind,
      width,
      surface: "rendered",
      status: "unreviewed",
      draft: false,
      finishReview: true,
    });
  }
let stack;
let fatal = false;
const report = {
  revision: BASE_REVISION,
  themes: themes.map((t) => t.value),
  workers: options.workers,
  phase: options.faultsOnly
    ? "faults-only"
    : options.capture
      ? "capture"
      : options.probe
        ? "probe"
        : options.selfTest
          ? "self-test"
          : "matrix",
  selectedFaults: options.selfTest
    ? selectedFaults.map((fault) => fault.id)
    : [],
  completeMatrix:
    !options.faultsOnly &&
    !options.themes &&
    !options.surfaces &&
    !options.limit &&
    !options.offset,
  acceptance: "approved-spec-v3-B",
  pages: [],
  failures: [],
  faults: [],
  staticOnly: ["pre.spec-del-structure: deletion 12% + muted"],
};
const measurements = [];
const basesByTheme = {};

// A worker owns its Chrome process/profile and measured bases. Only its queue
// opens pages, sequentially; separate workers never share a CDP target.
const createWorker = async (stack, fixture, index) => {
  const dir = join(stack.dir, `worker-${index + 1}`);
  mkdirSync(dir, { recursive: true });
  let browser;
  try {
    browser = await startBrowser({
      dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const basesByTheme = {};
  const prepare = async (config) => {
    if (config.surface === "issue" && !basesByTheme[config.theme]) {
      const warmup = await prepare({
        ...config,
        surface: "rendered",
        status: "unreviewed",
        draft: false,
        finishReview: false,
      });
      try {
        if (warmup.fixtureErrors.length)
          throw new Error(`fixture: ${warmup.fixtureErrors.join("; ")}`);
      } finally {
        await warmup.close();
      }
    }
    const page = await openDiffPage(browser, stack.webUrl, fixture, config);
    try {
      await installRoles(page, config, basesByTheme[config.theme]);
      if (["rendered", "source", "files"].includes(config.surface)) {
        const bases = await installCodeRoles(page, config);
        basesByTheme[config.theme] = bases;
        await installRoles(page, config, bases);
        if (!config.draft && !config.finishReview && config.surface !== "files")
          await installCodeRoles(page, config);
      }
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  };
  const run = async (config, fault = null) => {
    const page = await prepare(config);
    try {
      const injection = fault ? await injectFault(page, fault) : null;
      const rows = [];
      for (const state of ["normal", "hover"])
        rows.push(...(await measureRoles(page, config, state)));
      const failures = assess(
        rows,
        options.capture || options.probe ? null : baseline.colors,
      );
      failures.push(
        ...page.fixtureErrors.map((reason) => ({
          ...config,
          classification: "fixture",
          reason,
        })),
      );
      return { rows, injection, failures };
    } finally {
      await page.close();
    }
  };
  return {
    prepare,
    run,
    basesByTheme,
    close: async () => {
      try {
        await browser.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
};

const workers = [];
let activeQueues = Promise.resolve([]);
let workersStopping = false;
const runWorkerQueue = async (entries, task) => {
  if (workersStopping) throw new Error("browser workers are stopping");
  let next = 0;
  let failed = false;
  // Stop assigning work on rejection, but join every active task before the
  // caller can reach stack cleanup. Results are stored by input index.
  activeQueues = Promise.allSettled(
    workers.map(async (worker) => {
      while (!failed && !workersStopping && next < entries.length) {
        const index = next++;
        try {
          await task(worker, entries[index], index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const settled = await activeQueues;
  const errors = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(errors, "browser worker queue failed");
  if (workersStopping)
    throw new Error("browser workers stopped before the queue completed");
};

try {
  if (
    !options.capture &&
    !options.probe &&
    !staticPreRule(
      readFileSync(
        join(options.sourceRoot, "projects/web/src/styles.css"),
        "utf8",
      ),
    )
  )
    throw new Error("static-only pre.spec-del-structure recipe mismatch");
  stack = await createBrowserStack({
    root: options.sourceRoot,
    prefix: "diff-colors-",
  });
  const fixture = await seedDiffFixture(stack.serverPort);
  // This single lifecycle finalizer also handles signals during startup or a
  // queue: drain first, then close every browser, even if one close rejects.
  stack.addCleanup(async () => {
    workersStopping = true;
    await activeQueues;
    const closed = await Promise.allSettled(
      workers.map((worker) => worker.close()),
    );
    const errors = closed
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "browser worker cleanup failed");
  });
  activeQueues = Promise.allSettled(
    Array.from({ length: options.workers }, async (_, index) => {
      workers[index] = await createWorker(stack, fixture, index);
    }),
  );
  const started = await activeQueues;
  const startupErrors = started
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (startupErrors.length)
    throw new AggregateError(startupErrors, "browser worker startup failed");
  if (workersStopping)
    throw new Error("browser workers stopped during startup");
  console.log(`WORKERS ${options.workers}`);
  const selectedMatrix = (options.faultsOnly ? [] : matrix)
    .filter((c) => !options.surfaces || options.surfaces.includes(c.surface))
    .slice(options.offset, options.offset + (options.limit ?? matrix.length));
  if (!options.faultsOnly && !selectedMatrix.length)
    throw new Error("probe filters selected no pages");
  const themeJobs = themes
    .map((theme) =>
      selectedMatrix
        .map((config, index) => ({ config, index }))
        .filter((entry) => entry.config.theme === theme.value),
    )
    .filter((entries) => entries.length);
  const pageResults = new Array(selectedMatrix.length);
  const themeBases = new Array(themeJobs.length);
  try {
    await runWorkerQueue(themeJobs, async (worker, entries, themeIndex) => {
      for (const { config, index } of entries) {
        if (workersStopping) break;
        const key = [
          config.theme,
          config.width,
          config.surface,
          config.status,
          config.draft
            ? "draft"
            : config.finishReview
              ? "review-dialog"
              : "published",
        ].join("/");
        console.log(`MEASURE ${key}`);
        const result = await worker.run(config);
        pageResults[index] = result;
        console.log(
          `RESULT ${key} samples=${result.rows.length} color=${result.failures.filter((f) => f.classification === "color").length} baseline=${result.failures.filter((f) => f.classification === "baseline").length} contrast=${result.failures.filter((f) => f.classification === "contrast").length} fixture=${result.failures.filter((f) => f.classification === "fixture").length}`,
        );
        if (options.probe)
          console.log(JSON.stringify(result.failures.slice(0, 30)));
      }
      const theme = entries[0].config.theme;
      themeBases[themeIndex] = [theme, worker.basesByTheme[theme]];
    });
  } finally {
    // Only the parent aggregates evidence, in the original matrix/registry order.
    for (const [index, result] of pageResults.entries()) {
      if (!result) continue;
      measurements.push(...result.rows);
      report.pages.push({
        ...selectedMatrix[index],
        samples: result.rows.length,
        failures: result.failures.length,
      });
      report.failures.push(...result.failures);
    }
    for (const entry of themeBases)
      if (entry?.[1]) basesByTheme[entry[0]] = entry[1];
  }
  if (options.capture) {
    const missing = report.failures.filter(
      (f) => !["color", "contrast"].includes(f.classification),
    );
    if (missing.length)
      throw new Error(
        `capture refused: ${missing.length} fixture/coverage failures`,
      );
    const positive = report.failures.filter(
      (f) => f.classification === "color",
    );
    if (
      !positive.some((f) => f.role === "word-ins") ||
      !positive.some((f) => f.role === "timeline-file-plus")
    )
      throw new Error(
        "original implementation did not fail the expected body and statistics role/property checks",
      );
    const colors = {};
    for (const row of measurements)
      for (const p of row.props ?? [])
        if (p.kind === "baseline")
          colors[`${rowKey(row)}|${p.property}`] = p.actual;
    if (!Object.keys(colors).length || !Object.values(colors).every(validColor))
      throw new Error("capture produced missing or malformed baseline colors");
    if (report.pages.length !== matrix.length)
      throw new Error("capture did not complete every required page");
    const bases = Object.fromEntries(
      Object.entries(basesByTheme).map(([theme, value]) => [theme, value.rgba]),
    );
    if (
      !registry.every((theme) =>
        ["addition", "deletion"].every((side) =>
          validColor(bases[theme.value]?.[side]),
        ),
      )
    )
      throw new Error(
        "capture lacks actual Pierre bases for a registered theme",
      );
    assertOriginalSource();
    const target = resolve(ROOT, options.capture);
    const temporary = resolve(
      ROOT,
      ".tmp/t439/diff-colors-baseline-pending.json",
    );
    mkdirSync(resolve(ROOT, ".tmp/t439"), { recursive: true });
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify(
          {
            revision: BASE_REVISION,
            themes: registry.map((t) => t.value),
            pages: matrix.length,
            bases,
            colors,
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      if (existsSync(target))
        throw new Error(
          "baseline appeared during capture; refusing to replace it",
        );
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    console.log(
      `CAPTURED ${Object.keys(colors).length} immutable colors; original positive failures=${positive.length}`,
    );
  } else if (!options.probe && !options.faultsOnly) {
    let transitions;
    let fixtureFailures;
    await runWorkerQueue([null], async (worker) => {
      const page = await worker.prepare({
        theme: "solarized-light",
        kind: "light",
        width: 1280,
        surface: "rendered",
        status: "unreviewed",
        draft: false,
      });
      try {
        transitions = await verifyThemeTransitions(page, baseline.bases);
        fixtureFailures = page.fixtureErrors.map((reason) => ({
          classification: "fixture",
          role: "theme-transition",
          reason,
        }));
      } finally {
        await page.close();
      }
    });
    report.transitions = transitions;
    report.failures.push(...transitions.failures, ...fixtureFailures);
  }
  if (options.selfTest) {
    const faultResults = new Array(selectedFaults.length);
    await runWorkerQueue(selectedFaults, async (worker, fault, index) => {
      const { run } = worker;
      try {
        const config = {
          theme: fault.theme,
          kind: registry.find((t) => t.value === fault.theme).kind,
          width: fault.width ?? 1280,
          surface: fault.surface,
          status: fault.status ?? "unreviewed",
          draft: fault.draft ?? false,
          finishReview: fault.finishReview ?? false,
        };
        const clean = await run(config);
        const injected = await run(config, fault);
        const fresh = await run(config);
        const match = injected.failures.filter(
          (f) =>
            ["color", "baseline"].includes(f.classification) &&
            f.role === fault.role &&
            f.property === fault.property,
        );
        const invalid = injected.failures.filter(
          (f) => !["color", "baseline", "contrast"].includes(f.classification),
        );
        let lightControl = null;
        if (fault.lightControl) {
          const control = fault.lightControl;
          const lightConfig = { ...config, ...control, kind: "light" };
          const lightClean = await run(lightConfig);
          const lightInjected = await run(lightConfig, {
            ...control,
            id: `${fault.id}-light-control`,
          });
          const lightFresh = await run(lightConfig);
          lightControl = {
            clean: lightClean.failures.length,
            injected: lightInjected.failures.length,
            fresh: lightFresh.failures.length,
            evidence: lightInjected.injection,
          };
        }
        const pass =
          clean.failures.length === 0 &&
          fresh.failures.length === 0 &&
          invalid.length === 0 &&
          match.length > 0 &&
          (!lightControl ||
            (lightControl.clean === 0 &&
              lightControl.injected === 0 &&
              lightControl.fresh === 0));
        faultResults[index] = {
          id: fault.id,
          pass,
          clean: clean.failures.length,
          matched: match.length,
          invalid: invalid.length,
          fresh: fresh.failures.length,
          evidence: injected.injection,
          lightControl,
        };
        console.log(
          `FAULT ${fault.id}: ${pass ? "clean GREEN / fault RED / fresh GREEN" : "NOT PROVEN"}`,
        );
      } catch (error) {
        faultResults[index] = {
          id: fault.id,
          pass: false,
          classification: "fault-unproven",
          error: String(error),
        };
        console.error(`FAULT ${fault.id}: NOT PROVEN (${error})`);
      }
    });
    report.faults.push(...faultResults);
    if (report.faults.some((fault) => !fault.pass)) fatal = true;
  }
  if (!options.capture && report.failures.length) fatal = true;
} catch (error) {
  fatal = true;
  report.error = error.stack ?? String(error);
  console.error(report.error);
} finally {
  try {
    mkdirSync(resolve(ROOT, ".tmp/t439"), { recursive: true });
    report.summary = {
      pages: report.pages.length,
      samples: measurements.length,
      selectedSamples: measurements.filter((row) => row.selected).length,
      failures: report.failures.length,
      byKind: Object.fromEntries(
        [
          ...new Set(report.failures.map((f) => f.classification ?? f.family)),
        ].map((kind) => [
          kind,
          report.failures.filter((f) => (f.classification ?? f.family) === kind)
            .length,
        ]),
      ),
      faults: report.faults.length,
      provenFaults: report.faults.filter((fault) => fault.pass).length,
    };
    console.log(
      `SUMMARY ${JSON.stringify(report.summary)}; phase=${report.phase}; completeMatrix=${report.completeMatrix}; acceptance=${report.acceptance}; workers=${report.workers}`,
    );
    const reportFile = resolve(
      ROOT,
      ".tmp/t439",
      options.faultsOnly
        ? "diff-colors-faults-only-report.json"
        : options.capture
          ? "diff-colors-capture-report.json"
          : options.selfTest
            ? "diff-colors-self-test-report.json"
            : "diff-colors-report.json",
    );
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT ${reportFile}`);
  } finally {
    await stack?.cleanup();
  }
}
process.exitCode = fatal ? (report.error ? 2 : 1) : 0;
