#!/usr/bin/env node
/**
 * Manual real-browser check for the avatar a project or a person draws when
 * nothing was uploaded (T-544, T-555): whichever generator the account is set
 * to, the text has to stay inside its box at every size and in every theme,
 * and changing the setting in one tab redraws every icon in another.
 *
 * Usage: node scripts/fallback-avatar-smoke.mjs [--keep] [--help]
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
import { probeFallbacks } from "./browser/fallback-avatar-probe.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `fallback-avatar-smoke — generated project icons and user avatars

Usage: node scripts/fallback-avatar-smoke.mjs [--keep] [--help]

Seeds projects whose fallbacks are the awkward ones — the widest REF a
20-character prefix leaves, a digit and an underscore, initials with no prefix,
CJK initials — and an account whose initials are WW. Grades every square
avatar on the project list (the 40px cards) and on two settings pages (the
20px breadcrumb and the 40px editor), and every round one on those settings
pages and the profile page, in every theme the app ships, once per project
generator:

  glyph-outside-box               the text's box leaves the avatar's, at the
                                  size the surface draws it or forced to
                                  14/20/24/28/40px
  glyph-off-centre                the text's left and right margins differ by
                                  more than half a pixel
  wrong-generator                 the fallback is not the generator the
                                  account is set to
  text-contrast-below-threshold   colorful: white against either gradient
                                  stop < 4.5:1
  no-tint                         colorful: the fallback has no gradient
  tint-not-from-slug              colorful: one project drawn in two colours,
                                  or in a colour other than its slug's hash
  not-monochrome                  monochrome: anything but the theme's muted
                                  text on its muted box
  live-switch                     choosing the other project generator on the
                                  profile page does not redraw the project
                                  list open in another tab without a reload,
                                  or the server does not read the choice back

Each graded failure also runs against an injected fault that must turn it
red, so a pass is evidence the check can see what it grades.

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
/** `W` twice: the widest initials a person can have. */
const DISPLAY_NAME = "Wm Wu";
const LIST = { path: "/projects", square: PROJECTS.length, circle: 0 };
const PROFILE = { path: "/settings/profile", square: 0, circle: 1 };
const PAGES = [
  LIST,
  // Breadcrumb and editor: the two faces that do not share a component,
  // beside the member list's people.
  ...["icon-wide", "icon-cjk"].map((slug) => ({
    path: `/projects/${slug}/settings`,
    square: 2,
    circle: 1,
  })),
  // The person's own editor.
  PROFILE,
];
/** Only one generator exists for people so far (T-555). */
const USER_GENERATOR = "monochrome_text";

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
  await call("PATCH", "/me", { display_name: DISPLAY_NAME });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return { cookie, call };
}

/** Waits until the page draws at least this many generated fallbacks of each shape. */
async function openPage(context, fixture, url, { square, circle }) {
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
        (counts) =>
          Object.entries(counts).every(
            ([shape, count]) =>
              document.querySelectorAll(
                `[data-slot="avatar"][data-shape="${shape}"] > [data-slot="avatar-fallback"] [data-generator]`,
              ).length >= count,
          ),
        { square, circle },
      );
      if (ready) {
        await sleep(400);
        return page;
      }
      await sleep(150);
    }
    throw new Error(
      `${url}: fewer than ${square} square and ${circle} round fallbacks rendered`,
    );
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

/** Every square fallback's generator on the page. */
const squareGenerators = (page) =>
  evaluate(page, () =>
    [
      ...document.querySelectorAll(
        '[data-slot="avatar"][data-shape="square"] [data-slot="avatar-fallback"] [data-generator]',
      ),
    ].map((glyph) => glyph.getAttribute("data-generator")),
  );

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
      ...(result.icons?.length && {
        icons: result.icons.length,
        worstOverhang: Math.max(
          ...result.icons.flatMap((icon) => icon.sizes.map((s) => s.over)),
        ),
        worstOverhangAt: result.icons
          .flatMap((icon) =>
            icon.sizes.map((s) => ({ key: icon.key, glyph: icon.glyph, ...s })),
          )
          .sort((a, b) => b.over - a.over)[0],
        worstContrast: Math.min(
          ...result.icons.map(
            (icon) => icon.contrast ?? Number.POSITIVE_INFINITY,
          ),
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
      prefix: "fallback-avatar-smoke-",
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
    const open = (target) =>
      openPage(context, fixture, `${stack.webUrl}${target.path}`, target);
    const probe = (page, shape, generator, faults) =>
      evaluate(page, probeFallbacks, {
        shape,
        generator,
        sizes: SIZES,
        minContrast: MIN_CONTRAST,
        faults,
      });

    /** Every page, every theme, both shapes, against what the account chose. */
    const grade = async (projectGenerator) => {
      const results = [];
      for (const target of PAGES) {
        const page = await open(target);
        try {
          for (const theme of themeList) {
            await applyTheme(page, theme);
            for (const [shape, generator] of [
              ["square", projectGenerator],
              ["circle", USER_GENERATOR],
            ]) {
              if (target[shape] === 0) continue;
              const result = await probe(page, shape, generator);
              if (result.theme !== theme.value)
                result.coverageErrors.push("theme-not-applied");
              if (target === LIST) {
                const slugs = new Set(result.icons.map((icon) => icon.slug));
                for (const { slug } of PROJECTS) {
                  if (!slugs.has(slug))
                    result.coverageErrors.push(`missing-${slug}`);
                }
              }
              if (
                shape === "circle" &&
                !result.icons.some((i) => i.glyph === "WW")
              )
                result.coverageErrors.push("missing-WW");
              if (shape === "square") results.push(result);
              record(
                `${projectGenerator} ${shape} ${target.path} ${theme.value}`,
                result,
              );
            }
          }
        } finally {
          await page.close();
        }
      }
      return results;
    };

    /**
     * Picks a project generator on the profile page the way a keyboard user
     * does, and watches the project list open in another tab redraw.
     */
    const liveSwitch = async (key, generator) => {
      const list = await open(LIST);
      const profile = await open(PROFILE);
      try {
        await evaluate(list, () => {
          window.__notReloaded = true;
        });
        await evaluate(profile, () =>
          document.getElementById("project-icon-fallback")?.focus(),
        );
        for (const type of ["keyDown", "keyUp"]) {
          await profile.send("Input.dispatchKeyEvent", {
            type,
            key,
            code: `Key${key}`,
            text: type === "keyDown" ? key : undefined,
            windowsVirtualKeyCode: key.charCodeAt(0),
          });
        }
        const failures = [];
        const coverageErrors = [];
        const deadline = Date.now() + 15_000;
        let seen = [];
        while (Date.now() < deadline) {
          seen = await squareGenerators(list);
          if (seen.length && seen.every((g) => g === generator)) break;
          await sleep(150);
        }
        if (!seen.length || !seen.every((g) => g === generator)) {
          failures.push({ name: "live-switch", expected: generator, seen });
        }
        if (!(await evaluate(list, () => window.__notReloaded === true))) {
          failures.push({ name: "live-switch", reloaded: true });
        }
        const stored = await fixture.call("GET", "/me/prefs");
        if (stored.project_icon_fallback !== generator) {
          failures.push({
            name: "live-switch",
            stored: stored.project_icon_fallback,
          });
        }
        record(`live-switch-to-${generator}`, { failures, coverageErrors });
      } finally {
        await list.close();
        await profile.close();
      }
    };

    /** A fresh page per fault: these mutate the live document. */
    const fault = async (
      name,
      target,
      shape,
      generator,
      faults,
      requiredRed,
    ) => {
      const page = await open(target);
      try {
        record(name, await probe(page, shape, generator, faults), requiredRed);
      } finally {
        await page.close();
      }
    };

    try {
      // An account that never chose sees what every project drew before
      // the setting existed.
      const colorful = await grade("colorful_text");
      const tints = tintFailures(colorful);
      const distinct = new Set(
        colorful.flatMap((r) => r.icons.map((i) => i.tint?.join(" "))),
      );
      record("tint-from-slug", {
        failures: tints,
        coverageErrors:
          distinct.size > 1 || tints.length ? [] : ["one-colour-for-all"],
      });
      await fault(
        "unfit-red",
        LIST,
        "square",
        "colorful_text",
        { unfit: true },
        "glyph-outside-box",
      );
      await fault(
        "light-tint-red",
        LIST,
        "square",
        "colorful_text",
        { lightTint: true },
        "text-contrast-below-threshold",
      );
      const drift = await open(LIST);
      try {
        const drifted = await probe(drift, "square", "colorful_text", {
          driftOne: true,
        });
        record(
          "drift-red",
          {
            failures: tintFailures([...colorful, drifted]),
            coverageErrors: drifted.coverageErrors,
          },
          "tint-not-from-slug",
        );
      } finally {
        await drift.close();
      }
      await fault(
        "inherited-centre-red",
        LIST,
        "square",
        "colorful_text",
        { inheritCentre: true },
        "glyph-off-centre",
      );
      await fault(
        "wrong-generator-red",
        LIST,
        "square",
        "colorful_text",
        { relabel: true },
        "wrong-generator",
      );

      await liveSwitch("M", "monochrome_text");
      await grade("monochrome_text");
      await fault(
        "mono-unfit-red",
        LIST,
        "square",
        "monochrome_text",
        { unfit: true },
        "glyph-outside-box",
      );
      await fault(
        "mono-white-text-red",
        LIST,
        "square",
        "monochrome_text",
        { whiteText: true },
        "not-monochrome",
      );
      await fault(
        "round-white-text-red",
        PROFILE,
        "circle",
        USER_GENERATOR,
        { whiteText: true },
        "not-monochrome",
      );
      await liveSwitch("C", "colorful_text");
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
    console.error(`fallback-avatar-smoke: ${error.stack ?? error}`);
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
    name: "fallback-avatar-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "fallback-avatar-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
