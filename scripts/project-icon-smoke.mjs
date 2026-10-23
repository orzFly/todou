#!/usr/bin/env node
/**
 * Manual real-browser check for a project's fallback icon (T-544): the REF is
 * drawn on a gradient hashed from the slug, and it has to stay inside its box
 * at every size and stay legible in every theme.
 *
 * Usage: node scripts/project-icon-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Owns an isolated stack, API-seeded projects, a browser context and its own
 * cleanup.
 * Exit: 0 every case as expected; 1 an icon or fault assertion; 2 coverage or
 * infrastructure failure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { projectTint } from "../projects/web/src/lib/project-tint.ts";
import { probeProjectIcons } from "./browser/project-icon-probe.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `project-icon-smoke — a project's fallback icon at every size and theme

Usage: node scripts/project-icon-smoke.mjs [--keep] [--help]

Seeds projects whose fallbacks are the awkward ones — the widest REF a
20-character prefix leaves, a digit and an underscore, initials with no prefix,
CJK initials — and grades every square avatar on the project list (the 40px
cards) and on two settings pages (the 20px breadcrumb and the 40px editor), in
every theme the app ships:

  glyph-outside-box               the REF's box leaves the icon's, at the size
                                  the surface draws it or forced to 14/20/24/
                                  28/40px
  text-contrast-below-threshold   white against either gradient stop < 4.5:1
  no-tint                         the fallback has no gradient
  tint-not-from-slug              one project drawn in two colours, or in a
                                  colour other than its slug's hash

Each of the first, second and fourth also runs against an injected fault that
must turn it red, so a pass is evidence the check can see what it grades.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
CHROMIUM overrides /usr/bin/chromium.
Exit codes: 0 pass, 1 icon/fault assertion, 2 infrastructure/coverage error.
`;

const SIZES = [14, 20, 24, 28, 40];
const MIN_CONTRAST = 4.5;
const VIEWPORT = { width: 1280, height: 1400, deviceScaleFactor: 1 };
const PROJECTS = [
  // `W` is the widest capital; three of them is the most a REF draws.
  { slug: "icon-wide", name: "Wide", ref_prefix: "W".repeat(20) },
  { slug: "icon-kgm", name: "Kagami", ref_prefix: "KGM" },
  { slug: "icon-digit", name: "Digits", ref_prefix: "M_9" },
  { slug: "icon-single", name: "Single", ref_prefix: "Q" },
  { slug: "icon-initials", name: "Home Lab" },
  { slug: "icon-cjk", name: "豆腐 实验" },
];

/** Every theme the picker offers, with the kind that decides `.dark`. */
function themes() {
  const source = readFileSync(
    resolve(ROOT, "projects/web/src/lib/theme.ts"),
    "utf8",
  );
  const found = [
    ...source.matchAll(/value: "([^"]+)",[\s\S]*?kind: "(light|dark)"/g),
  ].map(([, value, kind]) => ({ value, kind }));
  if (found.length < 4) throw new Error("could not read the theme list");
  return found;
}

const rgbOf = (hex) =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(",");

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
    if (!response.ok) {
      throw new Error(
        `${method} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  for (const project of PROJECTS) {
    await call("POST", "/projects", { description: "", ...project });
  }
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return { cookie };
}

async function openPage(context, fixture, url, expected) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport: VIEWPORT,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url,
    },
  });
  try {
    await page.navigate(url);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await evaluate(
        page,
        (count) =>
          document.querySelectorAll(
            '[data-slot="avatar"][data-shape="square"] > [data-slot="avatar-fallback"]',
          ).length >= count,
        expected,
      );
      if (ready) {
        await sleep(400);
        return page;
      }
      await sleep(150);
    }
    throw new Error(`${url}: fewer than ${expected} fallback icons rendered`);
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function applyTheme(page, theme) {
  await evaluate(
    page,
    ({ value, kind }) =>
      new Promise((done) => {
        const root = document.documentElement;
        root.dataset.theme = value;
        root.classList.toggle("dark", kind === "dark");
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
    theme,
  );
}

/** One project, one colour, and the colour its slug hashes to. */
function tintFailures(results) {
  const seen = new Map();
  for (const result of results) {
    for (const icon of result.icons) {
      if (!icon.tint) continue;
      const tints = seen.get(icon.slug) ?? new Set();
      tints.add(icon.tint.join(" "));
      seen.set(icon.slug, tints);
    }
  }
  const failures = [];
  for (const [slug, tints] of seen) {
    const { from, to } = projectTint(slug);
    const expected = `${rgbOf(from)} ${rgbOf(to)}`;
    if (tints.size !== 1 || !tints.has(expected)) {
      failures.push({
        name: "tint-not-from-slug",
        slug,
        expected,
        seen: [...tints],
      });
    }
  }
  return failures;
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
  const cases = [];
  const record = (name, result, requiredRed = null) => {
    const names = result.failures.map((failure) => failure.name);
    const pass =
      result.coverageErrors.length === 0 &&
      (requiredRed === null
        ? names.length === 0
        : names.length > 0 && names.every((n) => n === requiredRed));
    const entry = {
      name,
      status: pass ? "pass" : "fail",
      requiredRed,
      failures: result.failures,
      coverageErrors: result.coverageErrors,
      // The margins a pass had, so a later run can tell how close it came.
      ...(result.icons && {
        icons: result.icons.length,
        worstOverhang: Math.max(
          ...result.icons.flatMap((icon) => icon.sizes.map((s) => s.over)),
        ),
        worstContrast: Math.min(
          ...result.icons.map((icon) => icon.contrast ?? 0),
        ),
      }),
    };
    cases.push(entry);
    console.log(`CASE ${JSON.stringify(entry)}`);
    if (!pass)
      exitCode = Math.max(exitCode, result.coverageErrors.length ? 2 : 1);
  };

  try {
    const themeList = themes();
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "project-icon-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    const listUrl = `${stack.webUrl}/projects`;
    try {
      const results = [];
      for (const [url, expected] of [
        [listUrl, PROJECTS.length],
        // Breadcrumb and editor: the two faces that do not share a component.
        [`${stack.webUrl}/projects/icon-wide/settings`, 2],
        [`${stack.webUrl}/projects/icon-cjk/settings`, 2],
      ]) {
        const page = await openPage(context, fixture, url, expected);
        try {
          for (const theme of themeList) {
            await applyTheme(page, theme);
            const result = await evaluate(page, probeProjectIcons, {
              sizes: SIZES,
              minContrast: MIN_CONTRAST,
            });
            if (result.theme !== theme.value)
              result.coverageErrors.push("theme-not-applied");
            if (url === listUrl) {
              const slugs = new Set(result.icons.map((icon) => icon.slug));
              for (const { slug } of PROJECTS) {
                if (!slugs.has(slug))
                  result.coverageErrors.push(`missing-${slug}`);
              }
            }
            results.push(result);
            record(`${new URL(url).pathname} ${theme.value}`, result);
          }
        } finally {
          await page.close();
        }
      }
      const tints = tintFailures(results);
      const distinct = new Set(
        results.flatMap((r) => r.icons.map((i) => i.tint?.join(" "))),
      );
      record("tint-from-slug", {
        failures: tints,
        coverageErrors:
          distinct.size > 1 || tints.length ? [] : ["one-colour-for-all"],
      });

      // A fresh page per fault: these mutate the live document.
      for (const [name, faults, requiredRed] of [
        ["unfit-red", { unfit: true }, "glyph-outside-box"],
        [
          "light-tint-red",
          { lightTint: true },
          "text-contrast-below-threshold",
        ],
      ]) {
        const page = await openPage(context, fixture, listUrl, PROJECTS.length);
        try {
          record(
            name,
            await evaluate(page, probeProjectIcons, {
              sizes: SIZES,
              minContrast: MIN_CONTRAST,
              faults,
            }),
            requiredRed,
          );
        } finally {
          await page.close();
        }
      }
      const page = await openPage(context, fixture, listUrl, PROJECTS.length);
      try {
        const drifted = await evaluate(page, probeProjectIcons, {
          sizes: SIZES,
          minContrast: MIN_CONTRAST,
          faults: { driftOne: true },
        });
        record(
          "drift-red",
          {
            failures: tintFailures([...results, drifted]),
            coverageErrors: drifted.coverageErrors,
          },
          "tint-not-from-slug",
        );
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    cases.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`project-icon-smoke: ${error.stack ?? error}`);
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
        cases.push({
          name: "cleanup-error",
          status: "fail",
          error: error.stack ?? String(error),
        });
      }
    }
  }
  const report = {
    name: "project-icon-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "project-icon-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
