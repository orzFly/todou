#!/usr/bin/env node
/**
 * Real-browser regression for the popovers attached to the comment composer
 * against its fold-when-empty rule (T-532, T-580).
 * Usage: node scripts/composer-popover-fold-smoke.mjs [--keep] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `composer-popover-fold-smoke — popovers inside an empty comment box

Usage: node scripts/composer-popover-fold-smoke.mjs [--keep] [--help]

Opens a card with an empty comment box and, with real mouse and touch input,
opens the keyboard-shortcuts popover and the watchers popover from inside it.
The box must stay unfolded while either is open or pressed, must fold once a
press outside takes focus away, and must stay unfolded when Escape hands focus
back to the button. Runs once with motion and once with reduced motion, where
the popover leaves no exit animation to blur from. Hovering the watchers line
must not take the caret out of the editor.

--keep  Retain isolated artifacts under .tmp/ after cleanup.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1 };

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
  const slug = "composer-popover-smoke";
  await call("POST", "/projects", { slug, name: "Popover", description: "" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Short thread",
    body: "A body to press on, outside the comment box.",
  });
  await call("POST", `/projects/${slug}/issues/${issue.number}/comments`, {
    body: "One comment.",
  });
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    slug,
    number: issue.number,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${issue.number}`,
  };
}

/**
 * No agent watches the seeded card, so the card's watcher read is answered
 * with one; the composer only draws the line when there is someone in it.
 * The line arrives with the fake, so its absence fails the page load rather
 * than any case.
 */
function fakeWatchers(path, number) {
  const watcher = {
    user: {
      id: 9001,
      login: "claude-agent",
      display_name: "Claude Agent",
      kind: "machine",
      avatar_url: null,
      owner: null,
    },
    agent_context: { agent: "claude-code", session_id: "s-1" },
    kind: "watch",
    scope: "issue",
    since: new Date().toISOString(),
  };
  const body = JSON.stringify({
    project: [],
    issues: { [String(number)]: [watcher] },
  });
  const original = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const pathname = new URL(url, location.href).pathname;
    // A 404 is how the client learns the server has no batch gateway, after
    // which every read goes out on its own, the watcher read included.
    if (pathname === "/api/batch")
      return Promise.resolve(new Response("{}", { status: 404 }));
    if (pathname === path)
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    return original(input, init);
  };
}

/** The composer and its popovers, read back from the rendered DOM. */
function readState() {
  const editor = document.querySelector('[aria-label="Write a comment"]');
  const root = editor.closest("form").parentElement;
  const open = [
    ...document.querySelectorAll('[data-slot="popover-content"]'),
  ].filter((node) => {
    const r = node.getBoundingClientRect();
    return node.dataset.state === "open" && r.width > 0 && r.height > 0;
  });
  const active = document.activeElement;
  // Every corner of an open popover is the topmost thing at that point, so
  // nothing on the page paints over it.
  const onTop = open.every((node) => {
    const r = node.getBoundingClientRect();
    return [
      [r.left + 8, r.top + 8],
      [r.right - 8, r.top + 8],
      [r.left + 8, r.bottom - 8],
      [r.right - 8, r.bottom - 8],
    ].every(([x, y]) => node.contains(document.elementFromPoint(x, y)));
  });
  return {
    onTop,
    folded: root.hasAttribute("data-collapsed"),
    help: open.some((node) => node.querySelector("table") !== null),
    watchers: open.some((node) => node.textContent.includes("Watching")),
    focusInEditor: editor.contains(active),
    focusInPopover: open.some((node) => node.contains(active)),
    focusOnHelp: active?.getAttribute("aria-label") === "Keyboard shortcuts",
    focus: active?.tagName ?? null,
  };
}

function centreOf(selector) {
  const node = document.querySelector(selector);
  if (node === null) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function input(page) {
  const mouse = (type, x, y) =>
    page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const touch = (type, points) =>
    page.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  // A target that is not there is skipped rather than thrown: what it was
  // meant to change then fails the next check, which names the case.
  const at = (selector) => evaluate(page, centreOf, selector);
  return {
    state: async (ms = 500) => {
      await sleep(ms);
      return evaluate(page, readState);
    },
    hover: async (selector) => {
      const point = await at(selector);
      if (point !== null) await mouse("mouseMoved", point.x, point.y);
    },
    click: async (selector) => {
      const point = await at(selector);
      if (point === null) return;
      await mouse("mouseMoved", point.x, point.y);
      await mouse("mousePressed", point.x, point.y);
      await mouse("mouseReleased", point.x, point.y);
    },
    tap: async (selector) => {
      const point = await at(selector);
      if (point === null) return;
      await touch("touchStart", [[point.x, point.y]]);
      await touch("touchEnd", []);
    },
    key: async (key, code, keyCode) => {
      for (const type of ["keyDown", "keyUp"])
        await page.send("Input.dispatchKeyEvent", {
          type,
          key,
          code,
          windowsVirtualKeyCode: keyCode,
        });
    },
  };
}

const EDITOR = '[aria-label="Write a comment"]';
const HELP_BUTTON = '[aria-label="Keyboard shortcuts"]';
const HELP_ROW = '[data-slot="popover-content"] tr';
const WATCHERS_LINE = "[data-composer-watchers] button";
// The comment's text, just above the composer: pressing it focuses nothing.
const OUTSIDE = '[id^="comment-"] p';

async function openCard(context, fixture, viewport, reducedMotion) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url: fixture.issueUrl,
    },
    scripts: [
      `(${fakeWatchers})(${JSON.stringify(`/api/projects/${fixture.slug}/watchers`)}, ${fixture.number})`,
    ],
  });
  if (viewport.mobile)
    await page.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-reduced-motion",
        value: reducedMotion ? "reduce" : "no-preference",
      },
    ],
  });
  await page.navigate(fixture.issueUrl);
  const deadline = Date.now() + 30_000;
  let missing = [];
  while (Date.now() < deadline) {
    missing = await evaluate(
      page,
      (selectors) => selectors.filter((s) => !document.querySelector(s)),
      [EDITOR, WATCHERS_LINE, OUTSIDE],
    );
    if (missing.length === 0) {
      await sleep(1000);
      return page;
    }
    await sleep(200);
  }
  await page.close();
  throw new Error(`card never rendered ${missing.join(", ")}`);
}

async function desktopCases(page) {
  const io = input(page);
  const out = [];
  const check = (name, ok, detail) =>
    out.push({ name, ok: Boolean(ok), detail });

  await io.click(EDITOR);
  const s0 = await io.state();
  check("editor-click-unfolds", !s0.folded && s0.focusInEditor, s0);

  await io.click(HELP_BUTTON);
  const s1 = await io.state();
  check("help-opens-and-box-stays", !s1.folded && s1.help && s1.onTop, s1);

  await io.click(HELP_ROW);
  const s2 = await io.state();
  check("press-in-help-keeps-both", !s2.folded && s2.help, s2);

  await io.click(OUTSIDE);
  const s3 = await io.state();
  check("press-outside-folds-and-closes", s3.folded && !s3.help, s3);

  // Each wait lets the action row finish growing in before it is aimed at.
  await io.click(EDITOR);
  await io.state();
  await io.click(HELP_BUTTON);
  const s3b = await io.state();
  check("help-reopens", !s3b.folded && s3b.help, s3b);
  await io.key("Escape", "Escape", 27);
  const s4 = await io.state();
  check(
    "escape-returns-to-button-unfolded",
    !s4.folded && !s4.help && s4.focusOnHelp,
    s4,
  );
  await io.click(OUTSIDE);
  const s5 = await io.state();
  check("then-press-outside-folds", s5.folded, s5);

  await io.click(EDITOR);
  await io.state();
  await io.hover(WATCHERS_LINE);
  const s6 = await io.state(1200);
  check(
    "hovering-watchers-keeps-caret",
    !s6.folded && s6.watchers && s6.focusInEditor,
    s6,
  );
  // Away until the hover closes it, so the click below opens rather than
  // toggles it shut.
  await io.hover(OUTSIDE);
  await io.state(1200);

  await io.click(EDITOR);
  await io.state();
  await io.click(WATCHERS_LINE);
  const s7 = await io.state();
  check(
    "clicked-watchers-box-stays",
    !s7.folded && s7.watchers && s7.onTop,
    s7,
  );

  await io.click(OUTSIDE);
  const s8 = await io.state(1200);
  check("press-outside-folds-after-watchers", s8.folded && !s8.watchers, s8);
  return out;
}

async function phoneCases(page) {
  const io = input(page);
  const out = [];
  const check = (name, ok, detail) =>
    out.push({ name, ok: Boolean(ok), detail });

  await io.tap(EDITOR);
  const s0 = await io.state();
  check("tap-unfolds", !s0.folded && s0.focusInEditor, s0);

  await io.tap(HELP_BUTTON);
  const s1 = await io.state();
  check("tap-help-opens-and-box-stays", !s1.folded && s1.help && s1.onTop, s1);

  await io.tap(HELP_ROW);
  const s2 = await io.state();
  check("tap-in-help-keeps-both", !s2.folded && s2.help, s2);

  await io.tap(OUTSIDE);
  const s3 = await io.state();
  check("tap-outside-folds-and-closes", s3.folded && !s3.help, s3);
  return out;
}

/** The other page with the help button, outside any folding box. */
async function newIssueCase(page, fixture) {
  const io = input(page);
  await page.navigate(fixture.issueUrl.replace(/\/\d+$/, "/new"));
  const deadline = Date.now() + 30_000;
  while (
    Date.now() < deadline &&
    !(await evaluate(
      page,
      (s) => document.querySelector(s) !== null,
      HELP_BUTTON,
    ))
  )
    await sleep(200);
  await io.click(HELP_BUTTON);
  await sleep(500);
  const shown = await evaluate(page, () => {
    const node = document.querySelector('[data-slot="popover-content"]');
    if (node === null) return { open: false };
    const r = node.getBoundingClientRect();
    const corners = [
      [r.left + 8, r.top + 8],
      [r.right - 8, r.top + 8],
      [r.left + 8, r.bottom - 8],
      [r.right - 8, r.bottom - 8],
    ];
    return {
      open: node.dataset.state === "open" && r.width > 0,
      onTop: corners.every(([x, y]) =>
        node.contains(document.elementFromPoint(x, y)),
      ),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
    };
  });
  return [
    {
      name: "new-issue-help-shows-on-top",
      ok: shown.open && shown.onTop && shown.inViewport,
      detail: shown,
    },
  ];
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
  const record = (name, cases) => {
    const red = cases.filter((c) => !c.ok).map((c) => c.name);
    runs.push({ name, status: red.length ? "fail" : "pass", red, cases });
    console.log(`RUN ${JSON.stringify({ name, pass: !red.length, red })}`);
    for (const c of cases)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (red.length) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "composer-popover-fold-smoke-",
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
    try {
      for (const [name, viewport, reduced, cases] of [
        ["desktop", DESKTOP, false, desktopCases],
        ["desktop-reduced-motion", DESKTOP, true, desktopCases],
        ["phone", PHONE, false, phoneCases],
        ["phone-reduced-motion", PHONE, true, phoneCases],
      ]) {
        const page = await openCard(context, fixture, viewport, reduced);
        try {
          record(name, await cases(page));
        } finally {
          await page.close();
        }
      }
      const page = await openCard(context, fixture, DESKTOP, false);
      try {
        record("new-issue", await newIssueCase(page, fixture));
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    exitCode = 2;
    runs.push({
      name: "runner-error",
      status: "fail",
      error: error.stack ?? String(error),
    });
    console.error(`composer-popover-fold-smoke: ${error.stack ?? error}`);
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
    name: "composer-popover-fold-smoke",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    runs,
  };
  console.log(`REPORT ${JSON.stringify({ status: report.status, exitCode })}`);
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "composer-popover-fold-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return exitCode;
}

process.exitCode = await main();
