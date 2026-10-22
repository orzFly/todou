#!/usr/bin/env node
/**
 * Manual real-browser check that a reference chip's title flows with the
 * prose it sits in (T-541): it starts on the line its ref ends on, breaks
 * inside itself where the line runs out, and no character of it is hidden by
 * a box of its own.
 *
 * What the reader reported was a title that could not break: an inline-block
 * box, cut with an ellipsis at its own width and moved whole onto the next
 * line whenever it did not fit the rest of this one. So the fixture puts the
 * same chips behind leads of every length, and the run grades four readings
 * on each chip at two widths and both settings of "Shorten long titles":
 *
 * - title-clipped: a character of the title lies outside a clipping box. On
 *   with the setting off, a visible title is the whole title; with it on, a
 *   cut is spelled in the text (`…`) and no wider than the 24em cap.
 * - title-left-its-line: the title starts a line below its ref although its
 *   first word fitted after it.
 * - chip-overflows-line: a fragment of the chip past the paragraph's content
 *   edge (plus the gutter the flow guard reserved for its closing edge).
 * - title-off-baseline: the title's text and the ref's text on one line do
 *   not share a bottom edge — the same font, so the same baseline.
 *
 * And the run fails as coverage when no chip at a width actually broke
 * inside its title, because then "wraps mid-title" was never put to it.
 *
 * Usage: node scripts/ref-title-wrap-smoke.mjs [--self-test] [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium). One isolated API/Vite
 * stack and one browser; the fixture is seeded through the real API.
 * Exit codes: 0 all checks pass; 1 a named assertion fails; 2 bad CLI input,
 * missing prerequisite, startup failure, or a coverage failure.
 * Limitations: Chromium only, headless. Selection and copy of the chip as one
 * unit are graded by rich-link-copy-smoke, not here.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WIDTHS = [390, 1024];

const HELP = `ref-title-wrap-smoke — a chip's title wraps with the prose (T-541)

Usage:
  node scripts/ref-title-wrap-smoke.mjs
  node scripts/ref-title-wrap-smoke.mjs --self-test

Options:
  --self-test  Prove each checker with an injected fault and a fresh page.
  --keep       Keep the isolated stack directory (screenshots included).
  --help       Print this help and exit.

Exit codes:
  0 checks passed; 1 a named assertion failed; 2 usage, prerequisite,
  startup, cleanup, or a check that never reached its target.
`;

const COVERAGE_FAILURES = new Set([
  "page-never-settled",
  "chip-missing",
  "never-wrapped-mid-title",
  "self-test-baseline-not-clean",
]);

const TITLES = "[data-ref-title], [data-comment-title]";
/**
 * Each fault is a shape this card rejects, the first of them being the chip
 * as it was reported.
 */
const FAULTS = {
  "title-box-clips": {
    css: `${TITLES} { display: inline-block !important; max-width: 24em !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; vertical-align: bottom !important; }`,
    detects: "title-clipped",
  },
  // A title that cannot break leaves its ref's line wherever it does not fit
  // the rest of it, and at 390px its single line is wider than the column.
  "title-nowrap": {
    css: `${TITLES} { white-space: nowrap !important; }`,
    detects: { 390: "chip-overflows-line", 1024: "title-left-its-line" },
  },
  "title-sinks": {
    css: `${TITLES} { vertical-align: -2px !important; }`,
    detects: "title-off-baseline",
  },
};

const EDGE_TOLERANCE = 0.05;
const BASELINE_TOLERANCE = 0.05;
/** RICH_CHIP_TITLE_CAP's 24em, plus a pixel for subpixel text advance. */
const CAP_EM = 24;

function failure(name, detail, extra = {}) {
  return { name, detail, ...extra };
}

const LONG_EN =
  "Storybook toolbar ThemeMenu has no way to open the custom theme editor without leaving the story";
const LONG_CJK =
  "自定义主题编辑器：每一侧的基础主题都可以单独选择，并且在工具栏里直接打开而不需要离开当前故事";
const LEAD = "Out of scope: opening the custom-theme editor from the toolbar";

async function seedFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, payload) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
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
  const slug = "t541-title-wrap";
  await call("POST", "/projects", { slug, name: "Ref title wrap" });
  await call("PUT", `/projects/${slug}/references/format`, { prefix: "UI" });
  await call("PATCH", "/me/prefs", {
    boxed_ref_links: true,
    ref_placement_reference: "before",
    show_repeated_ref_title: true,
  });
  const en = await call("POST", `/projects/${slug}/issues`, {
    title: LONG_EN,
    body: "target",
  });
  const cjk = await call("POST", `/projects/${slug}/issues`, {
    title: LONG_CJK,
    body: "target",
  });
  const note = await call(
    "POST",
    `/projects/${slug}/issues/${en.number}/comments`,
    { body: "a comment the text points at" },
  );
  const page = await call("POST", `/projects/${slug}/issues`, {
    title: "The card being read",
    body: "seed",
  });
  const targets = [
    `[ref](/projects/${slug}/issues/${en.number})`,
    `[ref](/projects/${slug}/issues/${cjk.number})`,
    `[comment](/projects/${slug}/issues/${en.number}#comment-${note.id})`,
  ];
  // Leads of every length put each chip's start somewhere different along
  // the line, so at any width some of them run out of room inside the title.
  const words = LEAD.split(" ");
  const rows = [];
  for (const target of targets) {
    for (let k = 1; k <= words.length; k++) {
      rows.push(`${words.slice(0, k).join(" ")} (${target}), after.`);
    }
  }
  await call("PATCH", `/projects/${slug}/issues/${page.number}`, {
    body: rows.join("\n\n"),
  });
  return { cookie, slug, number: page.number, rows: rows.length, call };
}

function probeSource(fault) {
  const css = fault ? FAULTS[fault].css : "";
  return `(() => {
  const sheet = ${JSON.stringify(css)};
  window.__t541 = { faultApplied: false };
  const install = () => {
    if (!sheet) return;
    const style = document.createElement('style');
    style.textContent = sheet;
    document.head.appendChild(style);
    window.__t541.faultApplied = true;
  };
  if (document.head) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
})()`;
}

/** Runs in the page: readings only, every judgement is the runner's. */
async function readChips(titles) {
  await document.fonts.ready;
  await new Promise((done) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    ),
  );
  const px = (value) => Number.parseFloat(value) || 0;
  const root = document.querySelector(".markdown-body");
  const paragraphs = root ? [...root.querySelectorAll(":scope > p")] : [];
  const textNodes = (element, skip) => {
    const out = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (skip && node.parentElement.closest(skip)) continue;
      if (node.textContent) out.push(node);
    }
    return out;
  };
  const charRect = (node, index) => {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    return rects[0] ?? null;
  };
  const rectsOf = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((r) => r.width > 0);
  };
  const chips = [];
  for (const p of paragraphs) {
    const anchor = p.querySelector("a.ref-chip-body, a.comment-link-body");
    if (!anchor) {
      chips.push({ missing: true, text: p.textContent.slice(0, 60) });
      continue;
    }
    const kind = anchor.classList.contains("ref-chip-body")
      ? "issue"
      : "comment";
    const title = anchor.querySelector(
      "[data-ref-title], [data-comment-title], .ref-chip-title",
    );
    const token = anchor.querySelector(
      "[data-ref-token], [data-comment-ref] > .comment-reference-identity",
    );
    if (!title || !token) {
      chips.push({ missing: true, kind, text: p.textContent.slice(0, 60) });
      continue;
    }
    const style = getComputedStyle(p);
    const box = p.getBoundingClientRect();
    const gutter = px(p.style.getPropertyValue("--ref-chip-gutter"));
    const contentRight =
      box.right - px(style.borderRightWidth) - px(style.paddingRight);
    const contentLeft =
      box.left + px(style.borderLeftWidth) + px(style.paddingLeft);
    // Text the reader can see: a cut title keeps its rest for assistive
    // technology in a node marked as such, which is not on screen.
    const visibleNodes = textNodes(title, "[data-ref-title-rest]");
    const visibleText = visibleNodes.map((n) => n.textContent).join("");
    const fullTitle = titles.find((one) =>
      title.textContent.replace("…", "").startsWith(one.slice(0, 8)),
    );
    // Every visible character against every clipping box between it and
    // the paragraph, title included.
    const clippers = [];
    for (let el = title; el && el !== p.parentElement; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.overflowX !== "visible" || s.overflowY !== "visible")
        clippers.push(el.getBoundingClientRect());
    }
    let hiddenChars = 0;
    for (const node of visibleNodes) {
      for (let i = 0; i < node.textContent.length; i++) {
        if (/\s/.test(node.textContent[i])) continue;
        const r = charRect(node, i);
        if (!r) {
          hiddenChars++;
          continue;
        }
        if (
          clippers.some(
            (c) =>
              r.left < c.left - 0.5 ||
              r.right > c.right + 0.5 ||
              r.top < c.top - 0.5 ||
              r.bottom > c.bottom + 0.5,
          )
        )
          hiddenChars++;
      }
    }
    const titleRects = visibleNodes.flatMap(rectsOf);
    const titleTops = [...new Set(titleRects.map((r) => Math.round(r.top)))];
    const tokenNodes = textNodes(token);
    const tokenLast = tokenNodes.at(-1);
    const tokenEnd = tokenLast
      ? charRect(tokenLast, tokenLast.textContent.length - 1)
      : null;
    const tokenStart = tokenNodes[0] ? charRect(tokenNodes[0], 0) : null;
    const firstNode = visibleNodes[0];
    const titleStart = firstNode ? charRect(firstNode, 0) : null;
    // The first break opportunity in the title, which is what has to fit
    // after the ref for the title to have a reason to stay on its line.
    let firstWordWidth = null;
    if (firstNode) {
      const text = firstNode.textContent;
      const cjk = /[　-鿿＀-￯]/.test(text[0]);
      const end = cjk ? 1 : Math.max(1, text.search(/\s|$/));
      const range = document.createRange();
      range.setStart(firstNode, 0);
      range.setEnd(firstNode, Math.min(end, text.length));
      firstWordWidth = range.getBoundingClientRect().width;
    }
    const fontSize = px(getComputedStyle(title).fontSize);
    const visibleWidth = visibleNodes
      .flatMap(rectsOf)
      .reduce((sum, r) => sum + r.width, 0);
    chips.push({
      kind,
      fullTitle: fullTitle ?? null,
      visibleText,
      hiddenChars,
      titleLines: titleTops.length,
      visibleWidth,
      fontSize,
      fragments: [...anchor.getClientRects()]
        .filter((r) => r.width > 0)
        .map((r) => ({ left: r.left, right: r.right })),
      contentLeft,
      contentRight,
      gutter,
      tokenEnd: tokenEnd && {
        right: tokenEnd.right,
        top: tokenEnd.top,
        bottom: tokenEnd.bottom,
      },
      tokenStart: tokenStart && { bottom: tokenStart.bottom },
      titleStart: titleStart && {
        top: titleStart.top,
        bottom: titleStart.bottom,
      },
      firstWordWidth,
    });
  }
  return {
    chips,
    faultApplied: window.__t541.faultApplied === true,
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
}

function checkChips(measured, { truncate, rows }) {
  const failures = [];
  const at = (index, chip) => `#${index} ${chip.kind ?? "?"}`;
  if (measured.chips.length !== rows)
    failures.push(
      failure("chip-missing", `${measured.chips.length} of ${rows} rows`),
    );
  let wrappedMidTitle = 0;
  measured.chips.forEach((chip, index) => {
    if (chip.missing) {
      failures.push(failure("chip-missing", `${at(index, chip)} ${chip.text}`));
      return;
    }
    if (!chip.fullTitle) {
      failures.push(
        failure("chip-missing", `${at(index, chip)} title not recognised`),
      );
      return;
    }
    // 1. Every character the reader is shown is on screen, and what they are
    //    shown is the title or an honest, spelled-out cut of it.
    if (chip.hiddenChars > 0)
      failures.push(
        failure(
          "title-clipped",
          `${at(index, chip)} ${chip.hiddenChars} characters outside a clipping box`,
        ),
      );
    if (chip.visibleText !== chip.fullTitle) {
      const cut = chip.visibleText.endsWith("…")
        ? chip.visibleText.slice(0, -1).trimEnd()
        : null;
      const honest =
        truncate &&
        cut !== null &&
        cut.length > 0 &&
        chip.fullTitle.startsWith(cut) &&
        chip.visibleWidth <= CAP_EM * chip.fontSize + 1;
      if (!honest)
        failures.push(
          failure(
            "title-clipped",
            `${at(index, chip)} shows ${JSON.stringify(chip.visibleText)} (${chip.visibleWidth.toFixed(1)}px)`,
          ),
        );
    } else if (truncate && chip.visibleWidth > CAP_EM * chip.fontSize + 1) {
      failures.push(
        failure(
          "title-over-cap",
          `${at(index, chip)} ${chip.visibleWidth.toFixed(1)}px over ${CAP_EM}em`,
        ),
      );
    }
    // 2. The title starts where its ref ends unless not even a word fitted.
    if (chip.tokenEnd && chip.titleStart && chip.firstWordWidth !== null) {
      const sameLine =
        chip.titleStart.top < chip.tokenEnd.bottom &&
        chip.titleStart.bottom > chip.tokenEnd.top;
      // A space, then the word: half an em is more than any space here.
      const room = chip.contentRight - chip.tokenEnd.right;
      if (!sameLine && room > chip.firstWordWidth + chip.fontSize * 0.5)
        failures.push(
          failure(
            "title-left-its-line",
            `${at(index, chip)} ${room.toFixed(1)}px left after the ref, first word ${chip.firstWordWidth.toFixed(1)}px`,
          ),
        );
      // 4. Same font, same line: same bottom edge.
      if (sameLine) {
        const drift = Math.abs(chip.titleStart.bottom - chip.tokenEnd.bottom);
        if (drift > BASELINE_TOLERANCE)
          failures.push(
            failure(
              "title-off-baseline",
              `${at(index, chip)} title ${drift.toFixed(2)}px off its ref`,
            ),
          );
      }
    }
    if (chip.titleLines >= 2) wrappedMidTitle++;
    // 3. No fragment past the content edge, beyond what the guard reserved.
    for (const fragment of chip.fragments) {
      const over = fragment.right - (chip.contentRight + chip.gutter);
      const under = chip.contentLeft - fragment.left;
      if (over > EDGE_TOLERANCE || under > EDGE_TOLERANCE)
        failures.push(
          failure(
            "chip-overflows-line",
            `${at(index, chip)} fragment ${fragment.left.toFixed(2)}–${fragment.right.toFixed(2)} vs content ${chip.contentLeft.toFixed(2)}–${(chip.contentRight + chip.gutter).toFixed(2)}`,
          ),
        );
    }
  });
  // With the setting off every title is long enough to need two lines
  // somewhere along the leads; with it on, the cap may keep them short.
  if (!truncate && wrappedMidTitle === 0)
    failures.push(
      failure("never-wrapped-mid-title", "no title spans two lines"),
    );
  if (measured.scrollWidth > measured.viewportWidth + 1)
    failures.push(
      failure(
        "page-overflows-horizontally",
        `scrollWidth ${measured.scrollWidth} vs ${measured.viewportWidth}`,
      ),
    );
  return { failures, wrappedMidTitle };
}

function cookieFor(raw) {
  const equals = raw.indexOf("=");
  if (equals < 1) throw new Error("seed did not receive an auth cookie");
  return { name: raw.slice(0, equals), value: raw.slice(equals + 1) };
}

async function runPass(browser, context, fixture, stack, pass) {
  const { width, truncate, fault } = pass;
  const url = `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`;
  const page = await browser.newPage({
    context,
    viewport: { width, height: 900, deviceScaleFactor: 1, mobile: false },
    cookie: { ...cookieFor(fixture.cookie), url },
    scripts: [probeSource(fault)],
  });
  const label = `${width}-${truncate ? "cap" : "full"}-${fault ?? "green"}`;
  try {
    await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
    await page.navigate(url);
    let ready = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !ready) {
      ready = await evaluate(
        page,
        (rows) =>
          document.querySelectorAll(
            ".markdown-body > p a.ref-chip-body, .markdown-body > p a.comment-link-body",
          ).length === rows,
        fixture.rows,
      ).catch(() => false);
      if (!ready) await sleep(100);
    }
    if (!ready)
      return {
        label,
        failures: [failure("page-never-settled", label)],
        faultApplied: fault === null,
      };
    await sleep(400);
    const measured = await evaluate(page, readChips, [LONG_EN, LONG_CJK]);
    const graded = checkChips(measured, { truncate, rows: fixture.rows });
    const shot = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    writeFileSync(
      join(stack.dir, `title-wrap-${label}.png`),
      Buffer.from(shot.data, "base64"),
    );
    return { label, ...graded, faultApplied: measured.faultApplied };
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
    if (entry.status !== "pass")
      exitCode = Math.max(exitCode, entry.coverage ? 2 : 1);
  };
  const coverageOf = (failures) =>
    failures.some((one) => COVERAGE_FAILURES.has(one.name));

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "ref-title-wrap-",
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
      let clean = true;
      for (const truncate of [false, true]) {
        await fixture.call("PATCH", "/me/prefs", {
          truncate_ref_title: truncate,
        });
        for (const width of WIDTHS) {
          const green = await runPass(browser, context, fixture, stack, {
            width,
            truncate,
            fault: null,
          });
          if (green.failures.length) clean = false;
          record({
            name: green.label,
            status: green.failures.length === 0 ? "pass" : "fail",
            coverage: coverageOf(green.failures),
            wrappedMidTitle: green.wrappedMidTitle,
            failures: green.failures.slice(0, 12),
            failureCount: green.failures.length,
          });
        }
      }
      if (selfTest) {
        await fixture.call("PATCH", "/me/prefs", { truncate_ref_title: false });
        for (const fault of Object.keys(FAULTS)) {
          if (!clean) {
            record({
              name: `self-test:${fault}`,
              status: "fail",
              coverage: true,
              failures: [
                failure(
                  "self-test-baseline-not-clean",
                  "a green pass failed, so a fault proves nothing",
                ),
              ],
            });
            continue;
          }
          for (const width of WIDTHS) {
            const red = await runPass(browser, context, fixture, stack, {
              width,
              truncate: false,
              fault,
            });
            const names = new Set(red.failures.map((one) => one.name));
            const { detects } = FAULTS[fault];
            const wanted =
              typeof detects === "string" ? detects : detects[width];
            const coverage =
              red.failures.some(
                (one) =>
                  COVERAGE_FAILURES.has(one.name) &&
                  one.name !== "never-wrapped-mid-title",
              ) || !red.faultApplied;
            record({
              name: `self-test:${fault}@${width}`,
              status:
                red.faultApplied && !coverage && names.has(wanted)
                  ? "pass"
                  : "fail",
              coverage,
              expected: wanted,
              seen: [...names],
            });
          }
        }
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
    console.error(`ref-title-wrap-smoke: ${error.stack ?? error}`);
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
    name: "ref-title-wrap-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    cases,
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "ref-title-wrap-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
