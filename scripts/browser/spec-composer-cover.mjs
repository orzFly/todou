import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluate } from "../lib/browser-cdp.mjs";

const VIEWPORTS = [
  {
    name: "phone",
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  },
  {
    name: "desktop",
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  },
];
// The scan's grid. Rows sit closer than a file header is tall (~29px), so a
// header cannot slip between two rows of points; the inset keeps points off
// the composer's rounded corners and border.
const SCAN = { step: 20, columns: 4, rowGap: 12, inset: 8, minOverlap: 8 };
const FILES = ["design.md", "notes.md", "plan.md"];
const HEADER_SELECTOR =
  ":is([data-file-diff], [data-file-unchanged]) [data-header-follow]";

function failure(name, detail, viewport) {
  return { name, detail, ...(viewport ? { viewport } : {}) };
}

// Three files, every one changed between v1 and v2, so the compare view
// stacks three diffs. The first is long and changes every fourth line: the
// diff folds unchanged runs, and a long file with a handful of edits draws
// short. That keeps the second file's header below the fold at both
// viewports, so reaching the top it has to scroll past the composer.
function specFiles(version) {
  const design = Array.from({ length: 60 }, (_, index) =>
    index % 4 === 1
      ? `Design line ${index + 1}, revision ${version}.`
      : `Design line ${index + 1} stays as it was.`,
  );
  const notes = Array.from({ length: 24 }, (_, index) =>
    index % 6 === 2
      ? `Note ${index + 1}, revision ${version}.`
      : `Note ${index + 1} stays as it was.`,
  );
  const plan = Array.from({ length: 24 }, (_, index) =>
    index % 6 === 3
      ? `Step ${index + 1}, revision ${version}.`
      : `Step ${index + 1} stays as it was.`,
  );
  return [
    { path: FILES[0], body: ["# Design", "", ...design].join("\n") },
    { path: FILES[1], body: ["# Notes", "", ...notes].join("\n") },
    { path: FILES[2], body: ["# Plan", "", ...plan].join("\n") },
  ];
}

async function seedFixture(serverPort) {
  const base = `http://127.0.0.1:${serverPort}/api`;
  let cookie = "";
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  const slug = `layout-composer-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", {
    slug,
    name: `Composer cover ${slug}`,
    description: "",
  });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Spec composer above the stacked file headers",
    body: "",
  });
  const specPath = `/projects/${slug}/issues/${issue.number}/spec`;
  const first = await call("POST", `${specPath}/push`, {
    message: "Composer cover version one",
    files: specFiles(1),
  });
  const second = await call("POST", `${specPath}/push`, {
    message: "Composer cover version two",
    files: specFiles(2),
    if_version: first.version,
  });
  if (first.version !== 1 || second.version !== 2)
    throw new Error(
      `two distinct pushes did not create v1 and v2: ${first.version}, ${second.version}`,
    );
  return { slug, number: issue.number, cookie };
}

async function waitUntil(page, probe, timeoutMs, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(page, probe, ...args)) return true;
    await sleep(80);
  }
  return false;
}

async function click(page, label) {
  const clicked = await evaluate(
    page,
    (wanted) => {
      const control = document.querySelector(
        `[aria-label="${CSS.escape(wanted)}"]`,
      );
      if (!control || control.disabled) return false;
      control.click();
      return true;
    },
    label,
  );
  if (!clicked) throw new Error(`no enabled control labelled "${label}"`);
}

const labelled = (label) =>
  !!document.querySelector(`[aria-label="${CSS.escape(label)}"]:enabled`);

// "Comment file" is disabled while comparing, so the composer is opened on
// the single-version view and carried back into the compare view, which keeps
// it open.
async function openComposer(page, fixture, stack) {
  const search = new URLSearchParams({
    file: FILES[0],
    v: "2",
    view: "source",
  });
  await page.navigate(
    `http://127.0.0.1:${stack.webPort}/projects/${fixture.slug}/issues/${fixture.number}/spec?${search}`,
  );
  const comparing = "comparing against v1, turn comparing off";
  if (!(await waitUntil(page, labelled, 30_000, comparing)))
    throw new Error(`the compare view never offered "${comparing}"`);
  await click(page, comparing);
  if (!(await waitUntil(page, labelled, 15_000, "Comment file")))
    throw new Error('"Comment file" never became enabled');
  await click(page, "Comment file");
  if (!(await waitUntil(page, labelled, 15_000, "cancel comment")))
    return false;
  await click(page, "turn comparing on");
  const stacked = await waitUntil(
    page,
    (count) => document.querySelectorAll("[data-file-diff]").length === count,
    30_000,
    FILES.length,
  );
  if (!stacked)
    throw new Error("the compare view did not stack every changed file");
  // The diffs lay out after their wrappers mount: wait for the document to
  // stop growing, so the scan runs to the real end of the stack.
  const deadline = Date.now() + 15_000;
  let height = 0;
  for (let stable = 0; stable < 3; ) {
    if (Date.now() > deadline)
      throw new Error("the compare stack never settled its height");
    await sleep(150);
    const next = await evaluate(
      page,
      () => document.documentElement.scrollHeight,
    );
    stable = next === height ? stable + 1 : 0;
    height = next;
  }
  // `?file=` holds the first file in place until the reader's first input
  // (holdRevealed). A real key press ends the hold as a reader's touch
  // would, so a late resize cannot pull the scan's scrolls back.
  for (const type of ["keyDown", "keyUp"])
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
    });
  return await evaluate(page, labelled, "cancel comment");
}

// Runs in the page, once per scroll step: scrolls to `target`, clamped to the
// end of the document, and asks what is painted at a grid of points inside
// the composer's sticky bar. Anything that is not the bar or inside it is
// drawn on top of it.
async function sampleInPage({
  target,
  columns,
  rowGap,
  inset,
  minOverlap,
  headerSelector,
  fault,
}) {
  const round = (value) => Number(value.toFixed(1));
  const end = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  );
  window.scrollTo(0, Math.min(target, end));
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  const sample = { end, scrollY: round(window.scrollY), points: 0 };
  // SpecComposer's outer bar: the first sticky ancestor of its cancel button.
  let bar = document.querySelector('[aria-label="cancel comment"]');
  while (bar && getComputedStyle(bar).position !== "sticky")
    bar = bar.parentElement;
  if (!bar) return { ...sample, missing: true };
  // The value the bar carried before the fix.
  if (fault) bar.style.zIndex = "10";
  const box = bar.getBoundingClientRect();
  const covered = [];
  for (let y = box.top + inset; y <= box.bottom - inset; y += rowGap) {
    for (let column = 0; column < columns; column += 1) {
      const x =
        box.left + inset + ((box.width - 2 * inset) * column) / (columns - 1);
      if (y < 0 || y >= window.innerHeight || x < 0 || x >= window.innerWidth)
        continue;
      sample.points += 1;
      const hit = document.elementFromPoint(x, y);
      if (hit && bar.contains(hit)) continue;
      const text = (hit?.textContent ?? "").trim().slice(0, 40);
      covered.push({
        key: hit ? `${hit.tagName}|${hit.getAttribute("class")}|${text}` : "",
        x: round(x),
        y: round(y),
        hit: hit
          ? {
              tag: hit.tagName.toLowerCase(),
              className: hit.getAttribute("class"),
              text,
            }
          : null,
        fileHeader: !!hit?.closest(headerSelector),
      });
    }
  }
  return {
    ...sample,
    composer: {
      className: bar.getAttribute("class"),
      zIndex: getComputedStyle(bar).zIndex,
      height: round(box.height),
    },
    underHeader: [...document.querySelectorAll(headerSelector)].some(
      (header) => {
        const rect = header.getBoundingClientRect();
        return (
          Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top) >
            minOverlap &&
          Math.min(rect.right, box.right) - Math.max(rect.left, box.left) >
            minOverlap
        );
      },
    ),
    covered,
  };
}

// Scrolls the document top to bottom, one round trip per step, and folds the
// steps together: each element seen over the composer is reported once, with
// how many points it covered.
async function scanComposer(page, fault) {
  const scan = {
    steps: 0,
    points: 0,
    missingSteps: 0,
    headerSteps: 0,
    maxScrollY: 0,
    injectionConfirmed: fault,
    composer: null,
  };
  const covered = new Map();
  for (let target = 0; ; target += SCAN.step) {
    const sample = await evaluate(page, sampleInPage, {
      ...SCAN,
      target,
      headerSelector: HEADER_SELECTOR,
      fault,
    });
    scan.steps += 1;
    scan.maxScrollY = Math.max(scan.maxScrollY, sample.scrollY);
    if (sample.missing) {
      scan.missingSteps += 1;
    } else {
      scan.composer ??= sample.composer;
      if (fault && sample.composer.zIndex !== "10")
        scan.injectionConfirmed = false;
      if (sample.underHeader) scan.headerSteps += 1;
      scan.points += sample.points;
      for (const { key, ...entry } of sample.covered) {
        const seen = covered.get(key);
        if (seen) seen.count += 1;
        else covered.set(key, { count: 1, scrollY: sample.scrollY, ...entry });
      }
    }
    if (target >= sample.end) break;
  }
  return { ...scan, covered: [...covered.values()] };
}

function inspectScan(scan, viewport, fault) {
  const failures = [];
  if (scan.missingSteps > 0)
    failures.push(
      failure(
        "composer-missing",
        `the composer's sticky bar was missing at ${scan.missingSteps} of ${scan.steps} scroll steps`,
        viewport,
      ),
    );
  if (!(scan.maxScrollY > 0))
    failures.push(
      failure(
        "real-scroll-not-observed",
        "window.scrollTo never moved scrollY off the top",
        viewport,
      ),
    );
  if (scan.headerSteps === 0)
    failures.push(
      failure(
        "header-never-under-composer",
        `no stacked file header overlapped the composer by more than ${SCAN.minOverlap}px at any of ${scan.steps} steps, so the scan proves nothing`,
        viewport,
      ),
    );
  if (fault && !scan.injectionConfirmed)
    failures.push(
      failure(
        "fault-injection-not-confirmed",
        "inline z-index: 10 on the composer bar did not take effect at every step",
        viewport,
      ),
    );
  for (const entry of scan.covered)
    failures.push(
      failure(
        "composer-covered",
        `${entry.count} point(s) of the composer hit <${entry.hit?.tag ?? "nothing"}${entry.fileHeader ? " in a file header" : ""}> first at scrollY ${entry.scrollY} (${entry.x}, ${entry.y}): class=${JSON.stringify(entry.hit?.className ?? null)} text=${JSON.stringify(entry.hit?.text ?? "")}`,
        viewport,
      ),
    );
  return failures;
}

async function screenshot(page, file, scrollY) {
  await evaluate(
    page,
    async (y) => {
      window.scrollTo(0, y);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    },
    scrollY,
  );
  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const failures = [];
  const measurements = [];
  // One page per viewport: switching the emulated viewport between phone and
  // desktop reloads the page and drops the composer.
  for (const { name, ...viewport } of VIEWPORTS) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage({ viewport, cookie: fixture.cookie });
      if (!(await openComposer(page, fixture, stack))) {
        failures.push(
          failure(
            "composer-missing",
            '"Comment file" did not open the composer',
            name,
          ),
        );
        continue;
      }
      const scan = await scanComposer(page, fault);
      const found = inspectScan(scan, name, fault);
      measurements.push({ viewport: name, width: viewport.width, ...scan });
      failures.push(...found);
      if (found.length) {
        await screenshot(
          page,
          join(stack.dir, `spec-composer-cover-${label}-${name}.png`),
          scan.covered[0]?.scrollY ?? 0,
        );
      }
    } finally {
      await context.close();
    }
  }
  const injectionConfirmed = fault
    ? measurements.length === VIEWPORTS.length &&
      measurements.every((measurement) => measurement.injectionConfirmed)
    : undefined;
  const result = {
    name: `spec-composer-cover:${label}`,
    fixture: { slug: fixture.slug, number: fixture.number, files: FILES },
    injectionConfirmed,
    failures,
    measurements,
  };
  if (failures.length)
    writeFileSync(
      join(stack.dir, `spec-composer-cover-${label}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  return result;
}

export async function runSpecComposerCover(options) {
  const fixture = await seedFixture(options.stack.serverPort);
  if (!options.selfTest) {
    return {
      name: "spec-composer-cover",
      passes: [
        await runPass({ ...options, fixture, fault: false, label: "clean" }),
      ],
    };
  }
  const baseline = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "baseline",
  });
  const fault = await runPass({
    ...options,
    fixture,
    fault: true,
    label: "fault",
  });
  const restored = await runPass({
    ...options,
    fixture,
    fault: false,
    label: "restored",
  });
  const coverageNames = new Set([
    "composer-missing",
    "real-scroll-not-observed",
    "header-never-under-composer",
    "fault-injection-not-confirmed",
  ]);
  const failures = [];
  for (const [pass, name] of [
    [baseline, "self-test-baseline-coverage"],
    [fault, "self-test-fault-coverage"],
    [restored, "self-test-restoration-coverage"],
  ]) {
    if (pass.failures.some((item) => coverageNames.has(item.name)))
      failures.push(
        failure(
          name,
          `${pass.name} lacked composer/scroll/header/injection coverage`,
        ),
      );
  }
  if (baseline.failures.length)
    failures.push(
      failure(
        "self-test-baseline-not-clean",
        `pre-existing failures cannot prove the injected fault: ${baseline.failures.map((item) => `${item.name}:${item.viewport ?? "all"}`).join(", ")}`,
      ),
    );
  if (!fault.injectionConfirmed)
    failures.push(
      failure("self-test-injection", "fault z-index was not confirmed"),
    );
  const coveredAt = new Set(
    fault.failures
      .filter((item) => item.name === "composer-covered")
      .map((item) => item.viewport),
  );
  if (
    baseline.failures.length ||
    !VIEWPORTS.every((viewport) => coveredAt.has(viewport.name))
  )
    failures.push(
      failure(
        "self-test-new-targeted-failure",
        "the pre-fix z-index did not add a composer-covered failure at every viewport over a green baseline",
      ),
    );
  if (restored.failures.length)
    failures.push(
      failure(
        "self-test-fresh-restoration",
        `fresh clean rerun failed: ${restored.failures.map((item) => item.name).join(", ")}`,
      ),
    );
  return {
    name: "spec-composer-cover",
    passes: [baseline, fault, restored],
    failures,
  };
}
