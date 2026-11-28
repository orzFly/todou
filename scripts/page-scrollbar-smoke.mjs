#!/usr/bin/env node
/**
 * Real-browser geometry for the page scrollbar (T-821). A classic scrollbar
 * takes 15px of the page's width; the shell has to sit in the same place
 * whether the page scrolls or not, and whether a menu or a dialog has locked
 * scrolling or not: the centred column's left edge and the header's
 * right-hand cluster stay put, and a dialog's scrim still reaches the
 * window's right edge.
 * Usage: node scripts/page-scrollbar-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes. Unlike them it
 * keeps Chromium's scrollbars: hidden, a scrollbar takes no width and there
 * is nothing to measure.
 * Exit: 0 every check as expected; 1 an assertion; 2 a coverage check or the
 * infrastructure failed.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `page-scrollbar-smoke — the shell stays put beside a classic scrollbar

Usage: node scripts/page-scrollbar-smoke.mjs [--keep] [--help]

At 1280x800 with real scrollbars, measures the shell on a spec file that
fits the window and one that does not, a long issue and the board, and on
the two spec files again with the account menu and with the Finish review
dialog open (the long one scrolled down first). The main column's left edge
and the header's right-hand cluster must match the long spec file at rest
within 0.5px; while a menu or dialog is open, a fixed full-window box and
the dialog's scrim must reach the window's right edge, and the header must
not move vertically.

Then three fault runs each take away one part of the fix and must turn the
checks that part answers for red, so a pass is evidence the checks can fail.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 coverage or infrastructure error.
`;

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const TOLERANCE = 0.5;
const SCROLL_Y = 1500;
const REFERENCE = "spec-long:idle";

const SAMPLES = {
  "spec-long:idle": { page: "spec-long", state: "idle" },
  "spec-short:idle": { page: "spec-short", state: "idle" },
  "issue-long:idle": { page: "issue-long", state: "idle" },
  "board:idle": { page: "board", state: "idle" },
  "spec-short:menu": { page: "spec-short", state: "menu" },
  "spec-long:menu": { page: "spec-long", state: "menu" },
  "spec-short:dialog": { page: "spec-short", state: "dialog" },
  "spec-long:dialog": { page: "spec-long", state: "dialog" },
};
const LOCKED = [
  "spec-short:menu",
  "spec-long:menu",
  "spec-short:dialog",
  "spec-long:dialog",
];

/**
 * Each fault restores one pre-fix shape, as a stylesheet added once the
 * document is parsed, and runs only the samples that can see it.
 */
const FAULTS = {
  "no-gutter": {
    css: "html { scrollbar-gutter: auto !important; }",
    samples: [REFERENCE, "spec-short:idle"],
    red: ["column-steady:spec-short:idle", "header-steady:spec-short:idle"],
  },
  "no-release": {
    css: "html:has(body[data-scroll-locked]) { scrollbar-gutter: stable !important; }",
    samples: [REFERENCE, "spec-short:dialog", "spec-long:dialog"],
    red: [
      "scrim-full-width:spec-short:dialog",
      "scrim-full-width:spec-long:dialog",
    ],
  },
  "no-margin": {
    css: "html body[data-scroll-locked] { margin-right: 0 !important; }",
    samples: [REFERENCE, ...LOCKED],
    red: LOCKED.map((name) => `column-steady:${name}`),
  },
};

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "page-scrollbar";
  await call("POST", "/projects", { slug, name: "Scrollbar", description: "" });
  const specIssue = await call("POST", `/projects/${slug}/issues`, {
    title: "Spec with a short and a long file",
    body: "One line.",
  });
  const longIssue = await call("POST", `/projects/${slug}/issues`, {
    title: "Long issue",
    body: Array.from(
      { length: 120 },
      (_, i) => `Paragraph ${i + 1} of a long body.`,
    ).join("\n\n"),
  });
  const longFile = [
    "# Design",
    "",
    ...Array.from(
      { length: 150 },
      (_, i) => `Line ${i + 1} of the long design document.\n`,
    ),
  ].join("\n");
  await call("POST", `/projects/${slug}/issues/${specIssue.number}/spec/push`, {
    message: "v1",
    files: [
      { path: "api/endpoints.md", body: "# Endpoints\n\nGET /things\n" },
      { path: "design.md", body: longFile },
    ],
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  const project = `${stack.webUrl}/projects/${slug}`;
  const spec = `${project}/issues/${specIssue.number}/spec?v=1&file=`;
  return {
    cookie,
    // Each page with the text that says its content has arrived.
    pages: {
      "spec-short": { url: `${spec}api/endpoints.md`, ready: "GET /things" },
      "spec-long": {
        url: `${spec}design.md`,
        ready: "Line 1 of the long design document.",
      },
      "issue-long": {
        url: `${project}/issues/${longIssue.number}`,
        ready: "Paragraph 1 of a long body.",
      },
      board: { url: `${project}/board`, ready: "Long issue" },
    },
  };
}

/** Run inside Chromium: the shell's horizontal geometry, or null if absent. */
function measure() {
  const main = document.querySelector("main");
  const header = document.querySelector("header");
  const cluster = header?.querySelector(
    "[data-shell-row=primary] > div:last-child",
  );
  if (!main || !cluster) return null;
  // What a fixed full-window layer gets, as the scrim is one.
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;inset:0;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  const fixedRight = probe.getBoundingClientRect().right;
  probe.remove();
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  const root = document.documentElement;
  return {
    innerWidth,
    mainLeft: main.getBoundingClientRect().left,
    clusterRight: cluster.getBoundingClientRect().right,
    headerTop: header.getBoundingClientRect().top,
    locked: document.body.hasAttribute("data-scroll-locked"),
    fixedRight,
    overlayRight: overlay ? overlay.getBoundingClientRect().right : null,
    scrolls: root.scrollHeight > innerHeight,
    scrollbar: innerWidth - root.clientWidth,
  };
}

/**
 * Run inside Chromium: whether `text` has rendered and no finite animation is
 * still running (an endless one, a spinner, would otherwise never settle).
 */
function settled(text) {
  return (
    (document.querySelector("main")?.textContent ?? "").includes(text) &&
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== "running" ||
          a.effect?.getTiming().iterations === Infinity,
      )
  );
}

/** Run inside Chromium: the centre of the control that opens `state`. */
function opener(state) {
  const target =
    state === "menu"
      ? [...document.querySelectorAll("header button[aria-haspopup=menu]")].at(
          -1,
        )
      : [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "Finish review",
        );
  if (!target) return null;
  const r = target.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Run inside Chromium: whether `state`'s surface is open and still. */
function opened(state) {
  const surface =
    state === "menu"
      ? document.querySelector('[role="menu"]')
      : document.querySelector('[data-slot="dialog-overlay"]');
  return (
    surface !== null &&
    document.body.hasAttribute("data-scroll-locked") &&
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== "running" ||
          a.effect?.getTiming().iterations === Infinity,
      )
  );
}

async function until(page, fn, arg, what) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(page, fn, arg).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Two reads 300ms apart that agree: layout has stopped moving. */
async function stableMeasure(page, what) {
  let last = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const next = await evaluate(page, measure);
    if (next && last && JSON.stringify(next) === JSON.stringify(last))
      return next;
    last = next;
    await sleep(300);
  }
  throw new Error(`${what}: the shell never stopped moving`);
}

async function sample(browser, fixture, name, fault) {
  const { page: pageName, state } = SAMPLES[name];
  const target = fixture.pages[pageName];
  const equals = fixture.cookie.indexOf("=");
  const context = await browser.newContext();
  try {
    const page = await context.newPage({
      viewport: VIEWPORT,
      cookie: {
        name: fixture.cookie.slice(0, equals),
        value: fixture.cookie.slice(equals + 1),
        url: target.url,
      },
      scripts: fault
        ? [
            `document.addEventListener("DOMContentLoaded", () => {
              const style = document.createElement("style");
              style.textContent = ${JSON.stringify(FAULTS[fault].css)};
              document.head.append(style);
            });`,
          ]
        : [],
    });
    await page.navigate(target.url);
    await until(page, settled, target.ready, `${name} content`);
    if (state !== "idle" && pageName.endsWith("-long")) {
      await evaluate(page, (y) => window.scrollTo(0, y), SCROLL_Y);
    }
    const before = await stableMeasure(page, name);
    if (state === "idle") return { name, before, after: before };
    const at = await evaluate(page, opener, state);
    if (!at) throw new Error(`${name}: nothing opens the ${state}`);
    // Radix opens a menu on pointerdown, which an element.click() never sends.
    for (const type of ["mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        clickCount: 1,
      });
    await until(page, opened, state, `${name} to open and lock scrolling`);
    return { name, before, after: await stableMeasure(page, name) };
  } finally {
    await context.close();
  }
}

async function sweep(browser, fixture, names, fault) {
  const results = {};
  for (const name of names) {
    results[name] = await sample(browser, fixture, name, fault);
    console.log(
      `  SAMPLE ${fault ?? "layout"} ${name} ${JSON.stringify(results[name].after)}`,
    );
  }
  return results;
}

/** What has to hold for the run to have measured anything at all. */
function coverage(results) {
  const failures = [];
  const at = (name) => results[name]?.before;
  if (!(at(REFERENCE)?.scrollbar > 0))
    failures.push({
      name: "real-scrollbar-not-observed",
      detail: at(REFERENCE),
    });
  for (const [name, scrolls] of [
    ["spec-short:idle", false],
    ["spec-long:idle", true],
    ["issue-long:idle", true],
  ]) {
    if (at(name) && at(name).scrolls !== scrolls)
      failures.push({
        name: scrolls ? "long-page-fits" : "short-page-scrolls",
        detail: name,
      });
  }
  for (const name of LOCKED) {
    if (results[name] && !results[name].after.locked)
      failures.push({ name: "lock-not-observed", detail: name });
  }
  return failures;
}

function checks(results) {
  const ref = results[REFERENCE].before;
  const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
  const out = [];
  for (const [name, { before, after }] of Object.entries(results)) {
    const { page, state } = SAMPLES[name];
    if (page !== "board")
      out.push({
        name: `column-steady:${name}`,
        ok: near(after.mainLeft, ref.mainLeft),
        detail: { mainLeft: after.mainLeft, expected: ref.mainLeft },
      });
    out.push({
      name: `header-steady:${name}`,
      ok: near(after.clusterRight, ref.clusterRight),
      detail: { clusterRight: after.clusterRight, expected: ref.clusterRight },
    });
    if (state === "idle") continue;
    out.push({
      name: `scrim-full-width:${name}`,
      ok:
        near(after.fixedRight, after.innerWidth) &&
        (state !== "dialog" || near(after.overlayRight, after.innerWidth)),
      detail: {
        fixedRight: after.fixedRight,
        overlayRight: after.overlayRight,
        innerWidth: after.innerWidth,
      },
    });
    out.push({
      name: `header-top-steady:${name}`,
      ok: near(after.headerTop, before.headerTop),
      detail: { before: before.headerTop, after: after.headerTop },
    });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--keep", "--help"].includes(arg))) {
    console.error("Unknown argument. Try --help.");
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const keep = args.includes("--keep");
  let stack;
  let exitCode = 0;
  const runs = [];
  const record = (name, results, requiredRed = []) => {
    const failures = coverage(results);
    const outcome = checks(results);
    const red = outcome.filter((c) => !c.ok).map((c) => c.name);
    const pass =
      failures.length === 0 &&
      (requiredRed.length === 0
        ? red.length === 0
        : requiredRed.every((n) => red.includes(n)));
    runs.push({
      name,
      status: pass ? "pass" : "fail",
      coverage: failures,
      requiredRed,
      red,
      checks: outcome,
    });
    console.log(
      `RUN ${JSON.stringify({ name, pass, coverage: failures, requiredRed, red })}`,
    );
    for (const c of outcome)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (failures.length > 0) exitCode = 2;
    else if (!pass) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "page-scrollbar-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
      hideScrollbars: false,
    });
    stack.addCleanup(() => browser.close());
    record("layout", await sweep(browser, fixture, Object.keys(SAMPLES), null));
    for (const [fault, { samples, red }] of Object.entries(FAULTS)) {
      record(
        `fault-${fault}`,
        await sweep(browser, fixture, samples, fault),
        red,
      );
    }
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`page-scrollbar-smoke: ${error.stack ?? error}`);
  } finally {
    if (stack) {
      if (exitCode !== 0 && !keep) {
        stack.keep = {
          remove: ["attachments", "chrome", "db"],
          message: `kept failure artifacts: ${stack.dir}`,
        };
      }
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        runs.push({
          name: "cleanup-error",
          status: "fail",
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "page-scrollbar-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "page-scrollbar-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
