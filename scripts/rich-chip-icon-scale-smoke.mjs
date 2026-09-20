#!/usr/bin/env node
/**
 * Manual real-browser check that a rich chip's glyph follows the font size it
 * is drawn at (T-495): a reference inside an `# h1` is set at 28px, and a
 * glyph in `rem` stays at the body's 14px beside it.
 *
 * The reading is a ratio, never a height. The same fixture measured twice
 * eighteen minutes apart has given two different pixel heights (T-445), so
 * "the icon is 28px in an h1" is not a property this machine can assert; what
 * a font-relative glyph promises is that `iconHeight / fontSize` is the same
 * number at every tier, and that is what this grades. One tier cannot show it
 * at all, so the fixture draws every chip at four (h1, h2, h3, body) and the
 * run fails as coverage if those four did not actually differ in size.
 *
 * A glyph that scales also has to stay inside the line it is on, which is
 * T-460's contract met at a font size it was never measured at. Each tier
 * therefore carries a chipless row of the same tag, and the chip's row may
 * not be taller than it.
 *
 * Usage: node scripts/rich-chip-icon-scale-smoke.mjs [--self-test] [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium). The runner starts one
 * isolated API/Vite stack and one browser, and seeds its own project, issues,
 * comment and attachment through the real API.
 * Exit codes: 0 all checks pass; 1 a named assertion fails; 2 bad CLI input,
 * missing prerequisite, startup failure, or a check that could not reach the
 * thing it grades (a coverage failure).
 * Limitations: Chromium only, headless, one viewport. Headless browsers
 * measure CSS geometry, not painted pixels — nothing here says the glyph is
 * legible at 28px, only that its box tracks the text.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VIEWPORT = { width: 1280, height: 900 };

const HELP = `rich-chip-icon-scale-smoke — a rich chip's glyph follows its font size (T-495)

Usage:
  node scripts/rich-chip-icon-scale-smoke.mjs
  node scripts/rich-chip-icon-scale-smoke.mjs --self-test

Options:
  --self-test  Prove each checker with an injected fault and a fresh page.
  --keep       Keep the isolated stack directory after the run.
  --help       Print this help and exit.

Exit codes:
  0 checks passed; 1 a named assertion failed; 2 usage, prerequisite,
  startup, cleanup, or a check that never reached its target.
`;

/** Failures that mean the check never reached its target, not that it failed. */
const COVERAGE_FAILURES = new Set([
  "page-never-settled",
  "chip-missing",
  "chipless-row-missing",
  "row-wrapped",
  "tiers-do-not-differ",
  "self-test-baseline-not-clean",
]);

/**
 * Each fault is a shape this card's design names and rejects. The first is
 * the bug as reported — the glyph pinned to the root's scale, which is what
 * `size-3.5` was — so the check that grades the fix is proven against the
 * exact state the fix replaced.
 */
const GLYPHS =
  ".ref-chip-body .ref-chip-icon, .comment-link-body .comment-reference-icon, " +
  'a[href*="/attachments/"] svg';
const FAULTS = {
  // The bug as reported, in the length the fix replaced: `size-3.5` was
  // `0.875rem`, which is the body's own font size and no heading's.
  "icon-in-rem": {
    css: `${GLYPHS} { width: 0.875rem !important; height: 0.875rem !important; }`,
    detects: "icon-does-not-follow-font",
  },
  // A glyph may follow the font and still be wrong: one that outgrows the
  // strut pushes the line apart, which is what T-460 bought and this must not
  // spend. Sized off the font, so the ratio check stays green and only the
  // line check can see it — and kept under half a line, so what it trips is
  // "this line got taller" rather than "this row wrapped".
  "icon-outgrows-line": {
    css: `${GLYPHS} { width: 1.4em !important; height: 1.4em !important; }`,
    detects: "chip-grows-its-line",
  },
};

/**
 * Line growth this smoke measures and reports without grading, because it
 * predates the card and is not the glyph's doing — T-498 holds it. Measured
 * on `bd33b43`, before T-495 touched anything, as 2.59px at h1, 2.94px at h2
 * and 3.13px at h3, and byte-identical after: an attachment chip is an
 * `inline-flex` whose own box is `leading-[1.2]` plus a border and `py-px`,
 * and a heading's line is `1.25`, so its box outgrows the line wherever
 * `1.2em + 4px` does. The glyph is not in that sum; the ref and comment
 * chips sit at 0.00px at every tier with the same glyph.
 *
 * The wrap guard still bounds these: a shortfall that reaches half a line is
 * a second line, and is graded as one. When T-498 lands, delete these three
 * entries and this check starts grading them.
 */
const KNOWN_SHORTFALLS = new Set([
  "h1/attachment",
  "h2/attachment",
  "h3/attachment",
]);

/** Ratio spread across tiers that still counts as "the same number". */
const RATIO_TOLERANCE = 0.02;
/** T-460's own tolerance for a chip growing the line it sits on. */
const LINE_TOLERANCE = 0.05;
/** The largest tier must be at least this many times the smallest. */
const TIER_SPREAD = 1.8;

function failure(name, detail, extra = {}) {
  return { name, detail, ...extra };
}

async function seedFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, payload) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(payload instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body:
        payload === undefined
          ? undefined
          : payload instanceof FormData
            ? payload
            : JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok)
      throw new Error(
        `${method} ${path} -> ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  await call("PATCH", "/me", { display_name: "Alice Neutral" });
  const slug = "t495-icon-scale";
  await call("POST", "/projects", { slug, name: "Rich chip icon scale" });
  await call("PUT", `/projects/${slug}/references/format`, { prefix: "T" });
  // The bordered chip is the shape the report was filed against, and the
  // border is also what `--ref-chip-inset` and the flow guard key off.
  await call("PATCH", "/me/prefs", {
    boxed_ref_links: true,
    truncate_ref_title: true,
    ref_placement_reference: "before",
  });

  // Short titles on purpose: a tier is only measurable while its row stays on
  // one line, and an h1 sets the same title at twice the body's width.
  const target = await call("POST", `/projects/${slug}/issues`, {
    title: "Target",
    body: "target",
  });
  const commented = await call("POST", `/projects/${slug}/issues`, {
    title: "Noted",
    body: "commented",
  });
  const note = await call(
    "POST",
    `/projects/${slug}/issues/${commented.number}/comments`,
    { body: "a comment the text points at" },
  );
  const page = await call("POST", `/projects/${slug}/issues`, {
    title: "The card being read",
    body: "seed",
  });

  // A plain text file, so the link stays a chip: an image would render as an
  // embed and take the glyph off the page this grades.
  const form = new FormData();
  form.append("file", new File(["scale"], "note.txt", { type: "text/plain" }));
  form.append("issue_number", String(page.number));
  const attachment = await call("POST", `/projects/${slug}/attachments`, form);

  const refHref = `/projects/${slug}/issues/${target.number}`;
  const commentHref = `/projects/${slug}/issues/${commented.number}#comment-${note.id}`;
  const kinds = [
    { key: "ref", href: refHref },
    { key: "comment", href: commentHref },
    { key: "attachment", href: attachment.url },
  ];
  // Four tiers of one markdown body: the heading scale is the product surface
  // the report came from, and the paragraph is the size every earlier chip
  // card measured at.
  const TIERS = [
    { key: "h1", tag: "H1", prefix: "# " },
    { key: "h2", tag: "H2", prefix: "## " },
    { key: "h3", tag: "H3", prefix: "### " },
    { key: "body", tag: "P", prefix: "" },
  ];
  const rows = [];
  for (const tier of TIERS) {
    rows.push(`${tier.prefix}no chip here`);
    for (const kind of kinds)
      rows.push(`${tier.prefix}at [${kind.key}](${kind.href})`);
  }
  await call("PATCH", `/projects/${slug}/issues/${page.number}`, {
    body: rows.join("\n\n"),
  });

  const stored = await call("GET", `/projects/${slug}/issues/${page.number}`);
  for (const kind of kinds) {
    if (!stored.body.includes(`[${kind.key}](`))
      throw new Error(`fixture lost the ${kind.key} link on the way in`);
  }
  return {
    cookie,
    slug,
    number: page.number,
    tiers: TIERS,
    kinds: kinds.map(({ key }) => key),
  };
}

/**
 * The page-side probe. Runs in the browser; everything it returns is a
 * reading, and every judgement is made by the runner below.
 */
function probeSource(fault) {
  const css = fault ? FAULTS[fault].css : "";
  return `(() => {
  const sheet = ${JSON.stringify(css)};
  window.__t495 = { faultApplied: false };
  const install = () => {
    if (sheet) {
      const style = document.createElement('style');
      style.textContent = sheet;
      document.head.appendChild(style);
      window.__t495.faultApplied = true;
    }
  };
  if (document.head) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
  window.__t495.root = () => document.querySelector('.markdown-body');
  window.__t495.rows = () => {
    const root = window.__t495.root();
    return root
      ? [...root.children].filter((el) => /^(H1|H2|H3|P)$/.test(el.tagName))
      : [];
  };
})()`;
}

/** Everything the runner grades, read in one pass after layout has settled. */
async function readScale(kinds) {
  await document.fonts.ready;
  await new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    ),
  );
  const classify = (row) => {
    const anchor = row.querySelector("a");
    if (!anchor) return { kind: "chipless", anchor: null, icon: null };
    const icon = anchor.querySelector("svg");
    const kind = anchor.classList.contains("ref-chip-body")
      ? "ref"
      : anchor.classList.contains("comment-link-body")
        ? "comment"
        : anchor.getAttribute("href")?.includes("/attachments/")
          ? "attachment"
          : "unknown";
    return { kind, anchor, icon };
  };
  const rows = window.__t495.rows();
  const readings = [];
  for (const row of rows) {
    const { kind, anchor, icon } = classify(row);
    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    const reading = {
      tag: row.tagName,
      kind,
      rowHeight: box.height,
      // Same tag means the same padding and border on both rows of a tier,
      // so two of them are comparable on height alone. The runner still
      // subtracts it from the chipless row, to prove that row is one line
      // before it uses that row as a budget.
      rowChrome:
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth),
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
    };
    if (anchor) {
      const anchorStyle = getComputedStyle(anchor);
      reading.chipFontSize = Number.parseFloat(anchorStyle.fontSize);
      reading.hasIcon = icon !== null;
      if (icon) {
        const iconBox = icon.getBoundingClientRect();
        reading.iconHeight = iconBox.height;
        reading.iconWidth = iconBox.width;
      }
    }
    readings.push(reading);
  }
  return {
    readings,
    faultApplied: window.__t495.faultApplied === true,
    expectedKinds: kinds,
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
}

function checkScale(measured, tiers, kinds) {
  const failures = [];
  /** Recorded, not graded: see KNOWN_SHORTFALLS. */
  const notes = [];
  const byTier = new Map();
  for (const reading of measured.readings) {
    const tier = tiers.find((one) => one.tag === reading.tag);
    if (!tier) continue;
    const group = byTier.get(tier.key) ?? { chipless: null, chips: new Map() };
    if (reading.kind === "chipless") group.chipless = reading;
    else group.chips.set(reading.kind, reading);
    byTier.set(tier.key, group);
  }

  // Coverage before judgement: a ratio that is equal because nothing was
  // measured is the shape this card is most able to fool itself with.
  for (const tier of tiers) {
    const group = byTier.get(tier.key);
    if (!group?.chipless)
      failures.push(
        failure("chipless-row-missing", `${tier.key} has no chipless row`),
      );
    for (const kind of kinds) {
      const chip = group?.chips.get(kind);
      if (!chip || chip.hasIcon !== true || !(chip.iconHeight > 0)) {
        failures.push(
          failure(
            "chip-missing",
            `${tier.key}/${kind} drew no measurable glyph`,
          ),
        );
      }
    }
    // The chipless row is the tier's budget, and it is only a budget while it
    // holds exactly one line. Counting rects cannot answer this: an inline
    // SVG and an `overflow: hidden` inline-block sit at tops of their own, so
    // a single line of chip returns three of them. Its height, less its own
    // padding and border, is the line box itself.
    const chipless = group?.chipless;
    if (
      chipless &&
      Math.abs(chipless.rowHeight - chipless.rowChrome - chipless.lineHeight) >
        0.5
    )
      failures.push(
        failure(
          "row-wrapped",
          `${tier.key} chipless row is ${chipless.rowHeight - chipless.rowChrome}px ` +
            `against a ${chipless.lineHeight}px line; the tier is not comparable`,
        ),
      );
  }

  const sizes = tiers.map((tier) => byTier.get(tier.key)?.chipless?.fontSize);
  const known = sizes.filter((size) => size > 0);
  if (known.length !== tiers.length) {
    failures.push(
      failure(
        "tiers-do-not-differ",
        `font sizes unread: ${JSON.stringify(sizes)}`,
      ),
    );
  } else if (Math.max(...known) < Math.min(...known) * TIER_SPREAD) {
    // Without this the whole run is one font size wearing four tag names,
    // and "the ratio is constant" would hold however the glyph is sized.
    failures.push(
      failure(
        "tiers-do-not-differ",
        `font sizes ${JSON.stringify(known)} span less than ${TIER_SPREAD}x`,
      ),
    );
  }

  const ratios = {};
  const lineDeltas = {};
  for (const kind of kinds) {
    const perTier = [];
    for (const tier of tiers) {
      const group = byTier.get(tier.key);
      const chip = group?.chips.get(kind);
      if (!chip || !(chip.iconHeight > 0) || !(chip.chipFontSize > 0)) continue;
      perTier.push({
        tier: tier.key,
        fontSize: chip.chipFontSize,
        iconHeight: chip.iconHeight,
        ratio: chip.iconHeight / chip.chipFontSize,
      });
      if (group?.chipless) {
        const delta = chip.rowHeight - group.chipless.rowHeight;
        const at = `${tier.key}/${kind}`;
        lineDeltas[at] = delta;
        const detail = `${at}: ${chip.rowHeight}px against a chipless ${group.chipless.rowHeight}px`;
        // Half a line apart is a second line, not a taller one, and a wrapped
        // row is not comparable to a one-line budget at all — so it is a gap
        // in the fixture rather than a defect in the chip.
        if (delta >= group.chipless.lineHeight * 0.5)
          failures.push(failure("row-wrapped", detail));
        else if (delta > LINE_TOLERANCE) {
          if (KNOWN_SHORTFALLS.has(at)) notes.push(detail);
          else failures.push(failure("chip-grows-its-line", detail));
        }
      }
    }
    ratios[kind] = perTier;
    if (perTier.length < 3) continue;
    const values = perTier.map((one) => one.ratio);
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > RATIO_TOLERANCE)
      failures.push(
        failure(
          "icon-does-not-follow-font",
          `${kind}: glyph/font ratio spans ${spread.toFixed(4)} across ` +
            JSON.stringify(
              perTier.map(({ tier, fontSize, iconHeight, ratio }) => ({
                tier,
                fontSize,
                iconHeight,
                ratio: Number(ratio.toFixed(4)),
              })),
            ),
        ),
      );
  }

  if (measured.scrollWidth > measured.viewportWidth + 1)
    failures.push(
      failure(
        "page-overflows-horizontally",
        `scrollWidth ${measured.scrollWidth} vs clientWidth ${measured.viewportWidth}`,
      ),
    );

  return { failures, notes, measurements: { ratios, lineDeltas } };
}

async function openPage(browser, context, fixture, stack, fault) {
  const url = `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`;
  const page = await browser.newPage({
    context,
    viewport: { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
    cookie: { ...cookieFor(fixture.cookie), url },
    scripts: [probeSource(fault)],
  });
  try {
    await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await page.navigate(url);
    const wantedRows = fixture.tiers.length * (fixture.kinds.length + 1);
    const wantedGlyphs = fixture.tiers.length * fixture.kinds.length;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await evaluate(
        page,
        (rowCount, glyphCount) => {
          if (typeof window.__t495 !== "object") return false;
          const rows = window.__t495.rows();
          if (rows.length !== rowCount) return false;
          // Every chip resolved: a reference still on its plain-anchor
          // fallback has no glyph, and would be graded as a chip that lost
          // one rather than as a page that had not finished loading.
          return (
            rows.filter((row) => row.querySelector("a svg")).length ===
            glyphCount
          );
        },
        wantedRows,
        wantedGlyphs,
      ).catch(() => false);
      if (ready) {
        await sleep(400);
        return page;
      }
      await sleep(100);
    }
    return null;
  } catch (error) {
    await page.close();
    throw error;
  }
}

function cookieFor(raw) {
  const equals = raw.indexOf("=");
  if (equals < 1) throw new Error("seed did not receive an auth cookie");
  return { name: raw.slice(0, equals), value: raw.slice(equals + 1) };
}

async function runPass(browser, context, fixture, stack, fault) {
  const page = await openPage(browser, context, fixture, stack, fault);
  if (page === null)
    return {
      failures: [failure("page-never-settled", `fault=${fault ?? "none"}`)],
      notes: [],
      measurements: null,
      faultApplied: fault === null,
    };
  try {
    const measured = await evaluate(page, readScale, fixture.kinds);
    const graded = checkScale(measured, fixture.tiers, fixture.kinds);
    // Always on the un-faulted pass: the tiers side by side are what a reader
    // of this card's report is actually asking to see.
    if (graded.failures.length || fault === null) {
      const shot = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      writeFileSync(
        join(stack.dir, `icon-scale-${fault ?? "green"}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
    return { ...graded, faultApplied: measured.faultApplied, measured };
  } finally {
    await page.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--self-test", "--keep", "--help"]);
  if (args.some((arg) => !allowed.has(arg))) {
    console.error("Unknown argument. Try --help.");
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const keep = args.includes("--keep");
  const selfTest = args.includes("--self-test");
  let stack;
  let exitCode = 0;
  const cases = [];
  const record = (entry) => {
    cases.push(entry);
    console.log(`CASE ${JSON.stringify(entry)}`);
    // A shortfall this smoke measures but does not grade still has to be read
    // by whoever runs it, or "exit 0" quietly becomes "nothing was wrong".
    for (const note of entry.notes ?? [])
      console.log(`NOTE ${entry.name}: known shortfall, not graded — ${note}`);
    if (entry.status !== "pass")
      exitCode = Math.max(exitCode, entry.coverage ? 2 : 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "rich-chip-icon-scale-",
      keep,
    });
    const fixture = await seedFixture(stack.serverPort);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    try {
      const green = await runPass(browser, context, fixture, stack, null);
      record({
        name: "green",
        status: green.failures.length === 0 ? "pass" : "fail",
        coverage: green.failures.some((one) => COVERAGE_FAILURES.has(one.name)),
        failures: green.failures,
        notes: green.notes,
        measurements: green.measurements,
      });

      if (selfTest) {
        const clean = green.failures.length === 0;
        for (const fault of Object.keys(FAULTS)) {
          if (!clean) {
            record({
              name: `self-test:${fault}`,
              status: "fail",
              coverage: true,
              failures: [
                failure(
                  "self-test-baseline-not-clean",
                  "the green pass failed, so a fault proves nothing",
                ),
              ],
            });
            continue;
          }
          const red = await runPass(browser, context, fixture, stack, fault);
          const names = new Set(red.failures.map((one) => one.name));
          const coverage = red.failures.some((one) =>
            COVERAGE_FAILURES.has(one.name),
          );
          // The check this fault is aimed at, not merely some check: a fault
          // that only trips a neighbour proves the neighbour, and leaves the
          // one it was written for untested.
          const wanted = FAULTS[fault].detects;
          const detected = red.faultApplied && !coverage && names.has(wanted);
          record({
            name: `self-test:${fault}`,
            status: detected ? "pass" : "fail",
            coverage: !red.faultApplied || coverage,
            faultApplied: red.faultApplied,
            expected: wanted,
            failures: red.failures,
            notes: red.notes,
            measurements: red.measurements,
          });
        }
        // A fault injected per page must not survive the page that carried it.
        const restored = await runPass(browser, context, fixture, stack, null);
        record({
          name: "self-test:restored",
          status: restored.failures.length === 0 ? "pass" : "fail",
          coverage:
            restored.failures.length > 0 &&
            restored.failures.every((one) => COVERAGE_FAILURES.has(one.name)),
          failures: restored.failures,
          notes: restored.notes,
          measurements: restored.measurements,
        });
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
    console.error(`rich-chip-icon-scale-smoke: ${error.stack ?? error}`);
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
    name: "rich-chip-icon-scale-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "rich-chip-icon-scale-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
