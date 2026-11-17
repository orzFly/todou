#!/usr/bin/env node
/**
 * Real-browser sweep across selection checkboxes (T-772): pressing a box and
 * dragging over other rows selects them (or deselects, starting on a checked
 * box), on the issue list, the board and the attachment list — with real
 * mouse input, against what only a real browser decides: hit testing, text
 * selection, the click a release sends, and dnd-kit's card drag.
 * Usage: node scripts/sweep-select-smoke.mjs [--keep] [--shots DIR] [--help]
 * Requires the same installed dependencies, Node 24+, flock and CHROMIUM
 * (default /usr/bin/chromium) as the other browser smokes.
 * Exit: 0 every case as expected; 1 an assertion; 2 infrastructure failure.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HELP = `sweep-select-smoke — drag across checkboxes to select (T-772)

Usage: node scripts/sweep-select-smoke.mjs [--keep] [--shots DIR] [--help]

Drives a real mouse over the issue list, the board and an issue's
attachments: a sweep from an unchecked box adds the rows it crosses, one from
a checked box removes them, a release back on the first box keeps it, a press
that never moves is a click, a drag from a title still selects text, a sweep
across board cards never picks a card up, and a drag from a card's body
still moves it.

Then a fault run strips every sweep start marker, and every sweep case must
turn red, so a pass is evidence the checks can fail.

--keep        Retain isolated artifacts under .tmp/ after cleanup.
--shots DIR   Write a PNG per step into DIR.
Exit codes: 0 pass, 1 assertion, 2 infrastructure error.
`;

const VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 };
const FAULT = `(() => {
  const strip = () => {
    for (const el of document.querySelectorAll("[data-sweep-start]"))
      el.removeAttribute("data-sweep-start");
  };
  new MutationObserver(strip).observe(document, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-sweep-start"],
  });
})();`;

async function seed(stack) {
  let cookie = "";
  const call = async (method, path, body, form) => {
    const response = await fetch(`${stack.serverUrl}/api${path}`, {
      method,
      headers: {
        ...(form ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  await call("POST", "/auth/login");
  const slug = "sweep-select";
  await call("POST", "/projects", { slug, name: "Sweep", description: "" });
  const statuses = await call("GET", `/projects/${slug}/statuses`);
  const todo = statuses.find((s) => s.name === "Todo") ?? statuses[0];
  const next = statuses.find((s) => s.name === "Next") ?? statuses[1];
  const numbers = [];
  for (let i = 1; i <= 8; i++) {
    const issue = await call("POST", `/projects/${slug}/issues`, {
      title: `Sweep target number ${i}`,
      body: "",
      status_id: i <= 5 ? todo.id : next.id,
    });
    numbers.push(issue.number);
  }
  const host = numbers[0];
  for (const name of ["one.txt", "two.txt", "three.txt", "four.txt"]) {
    const form = new FormData();
    form.append("file", new File([`${name}\n`], name, { type: "text/plain" }));
    form.append("issue_number", String(host));
    await call("POST", `/projects/${slug}/attachments`, undefined, form);
  }
  if (!cookie.includes("="))
    throw new Error("seed did not receive an auth cookie");
  return {
    cookie,
    call,
    slug,

    next: next.id,
    listUrl: `${stack.webUrl}/projects/${slug}`,
    boardUrl: `${stack.webUrl}/projects/${slug}/board`,
    issueUrl: `${stack.webUrl}/projects/${slug}/issues/${host}`,
  };
}

/** Rows of one surface, top to bottom: key, box centre, title centre. */
function rows(scope) {
  const root = scope ? document.querySelector(scope) : document;
  return [...(root?.querySelectorAll("[data-sweep-key]") ?? [])].map((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    const title = row.querySelector('a[href*="/issues/"], a[href]');
    const centre = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const rect = row.getBoundingClientRect();
    return {
      // Inside the row, clear of every control on it: where a board card is
      // picked up by its body.
      body: { x: rect.right - 12, y: rect.bottom - 6 },
      titleLeft: title ? title.getBoundingClientRect().left : null,
      key: row.getAttribute("data-sweep-key"),
      checked: box?.checked ?? false,
      box: box ? centre(box) : null,
      title: title ? centre(title) : null,
      lifted: row.className.includes("opacity-30"),
    };
  });
}

function pageState() {
  return {
    selection: window.getSelection()?.toString() ?? "",
    path: location.pathname,
    overlay: document.querySelector(".cursor-grabbing") !== null,
  };
}

class Mouse {
  constructor(page) {
    this.page = page;
    this.at = { x: 0, y: 0 };
    this.down = false;
  }
  async event(type, { x, y }) {
    await this.page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" && !this.down ? "none" : "left",
      buttons: this.down || type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
    this.at = { x, y };
  }
  async move(to, steps = 6) {
    const from = this.at;
    for (let i = 1; i <= steps; i++) {
      await this.event("mouseMoved", {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await sleep(16);
    }
  }
  async press(at) {
    await this.move(at, 1);
    this.down = true;
    await this.event("mousePressed", at);
  }
  async release(at = this.at) {
    if (at !== this.at) await this.move(at, 2);
    this.down = false;
    await this.event("mouseReleased", at);
    await sleep(120);
  }
}

async function openPage(context, fixture, url, fault, scope) {
  const equals = fixture.cookie.indexOf("=");
  const page = await context.newPage({
    viewport: VIEWPORT,
    cookie: {
      name: fixture.cookie.slice(0, equals),
      value: fixture.cookie.slice(equals + 1),
      url,
    },
    scripts: fault ? [FAULT] : [],
  });
  await page.navigate(url);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await evaluate(page, rows, scope).catch(() => []);
    if (found.length > 0 && found.every((r) => r.box)) return page;
  }
  await page.close();
  throw new Error(`${url} never showed selectable rows`);
}

async function main() {
  const args = process.argv.slice(2);
  const shotsAt = args.indexOf("--shots");
  const shots = shotsAt === -1 ? null : resolve(args[shotsAt + 1] ?? ".");
  const flags = args.filter((_, i) => shotsAt === -1 || i !== shotsAt + 1);
  if (
    flags.some((arg) => !["--keep", "--help", "--shots"].includes(arg)) ||
    (shotsAt !== -1 && !args[shotsAt + 1])
  ) {
    console.error("Unknown argument. Try --help.");
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (shots) mkdirSync(shots, { recursive: true });
  const keep = args.includes("--keep");
  let stack;
  let exitCode = 0;
  const runs = [];
  const record = (name, results, requiredRed = []) => {
    const red = results.filter((c) => !c.ok).map((c) => c.name);
    const pass =
      requiredRed.length === 0
        ? red.length === 0
        : requiredRed.every((n) => red.includes(n));
    runs.push({ name, status: pass ? "pass" : "fail", requiredRed, red });
    console.log(`RUN ${JSON.stringify({ name, pass, requiredRed, red })}`);
    for (const c of results)
      console.log(
        `  ${c.ok ? "ok  " : "RED "} ${c.name} ${JSON.stringify(c.detail)}`,
      );
    if (!pass) exitCode = Math.max(exitCode, 1);
  };

  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "sweep-select-smoke-",
      keep,
    });
    const fixture = await seed(stack);
    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());

    const pass = async (fault) => {
      const results = [];
      const tag = fault ? "fault" : "real";
      const check = (name, ok, detail) => results.push({ name, ok, detail });
      const shoot = async (page, name) => {
        if (!shots || fault) return;
        const { data } = await page.send("Page.captureScreenshot", {
          format: "png",
        });
        writeFileSync(
          resolve(shots, `${name}.png`),
          Buffer.from(data, "base64"),
        );
      };
      const on = (list) => list.filter((r) => r.checked).map((r) => r.key);

      // Issue list.
      let context = await browser.newContext();
      try {
        const page = await openPage(context, fixture, fixture.listUrl, fault);
        const mouse = new Mouse(page);
        let r = await evaluate(page, rows);
        const keys = r.map((row) => row.key);
        await mouse.press(r[0].box);
        await mouse.move(r[1].box);
        await mouse.move(r[2].title);
        await mouse.move(r[3].title);
        await shoot(page, "list-1-adding-mid-sweep");
        await mouse.release();
        r = await evaluate(page, rows);
        let state = await evaluate(page, pageState);
        check("list:adds", on(r).join() === keys.slice(0, 4).join(), {
          on: on(r),
        });
        check("list:no-text-selected", state.selection === "", state);
        check("list:stayed", state.path === `/projects/${fixture.slug}`, state);
        await shoot(page, "list-2-added");

        await mouse.press(r[2].box);
        await mouse.move(r[5].box);
        await shoot(page, "list-3-removing-mid-sweep");
        await mouse.release();
        r = await evaluate(page, rows);
        check("list:removes", on(r).join() === keys.slice(0, 2).join(), {
          on: on(r),
        });

        await mouse.press(r[5].box);
        await mouse.move(r[6].box);
        await mouse.move(r[5].box);
        await mouse.release();
        r = await evaluate(page, rows);
        check(
          "list:release-on-start-keeps",
          on(r).join() === [...keys.slice(0, 2), keys[5], keys[6]].join(),
          { on: on(r) },
        );
        await shoot(page, "list-4-after-return-to-start");

        // These two hold whether or not a sweep can start, so the fault
        // run leaves them out rather than asking them to go red.
        if (!fault) {
          await mouse.press(r[7].box);
          await mouse.release();
          r = await evaluate(page, rows);
          check("list:click-still-toggles", r[7].checked, { on: on(r) });

          const before = on(r).join();
          // Left of the link, on the ref: a press on the link itself would
          // start the browser's link drag rather than a text selection.
          await mouse.press({ x: r[0].titleLeft - 14, y: r[0].title.y });
          await mouse.move({ x: r[1].title.x, y: r[1].title.y });
          await mouse.release();
          r = await evaluate(page, rows);
          state = await evaluate(page, pageState);
          check(
            "list:title-drag-selects-text",
            state.selection.length > 0 && on(r).join() === before,
            { selection: state.selection, on: on(r) },
          );
          await shoot(page, "list-5-title-drag-selects-text");
        }
        await page.close();
      } finally {
        await context.close();
      }

      // Board.
      context = await browser.newContext();
      try {
        const page = await openPage(context, fixture, fixture.boardUrl, fault);
        const mouse = new Mouse(page);
        let r = await evaluate(page, rows);
        // The real pass moves a card on purpose, so the fault pass compares
        // against the board as it found it.
        const statusBefore = new Map(
          (
            await fixture.call(
              "GET",
              `/projects/${fixture.slug}/issues?limit=50`,
            )
          ).items.map((i) => [i.number, i.status.id]),
        );
        // Todo holds the first five, Next the other three; the sweep goes
        // down Todo's corner line, then across into Next.
        await mouse.press(r[0].box);
        await mouse.move(r[1].box);
        await mouse.move(r[2].box);
        await mouse.move(r[5].title);
        const mid = await evaluate(page, rows);
        const midState = await evaluate(page, pageState);
        await shoot(page, "board-1-mid-sweep-across-columns");
        await mouse.release();
        r = await evaluate(page, rows);
        const state = await evaluate(page, pageState);
        const swept = [r[0], r[1], r[2], r[5]].map((x) => x.key);
        check("board:adds-across-columns", on(r).join() === swept.join(), {
          on: on(r),
        });
        check(
          "board:no-card-lifted",
          !midState.overlay && mid.every((x) => !x.lifted),
          midState,
        );
        check("board:no-text-selected", state.selection === "", state);
        await shoot(page, "board-2-swept");
        const issues = await fixture.call(
          "GET",
          `/projects/${fixture.slug}/issues?limit=50`,
        );
        const moved = issues.items.filter(
          (i) => i.status.id !== statusBefore.get(i.number),
        );
        check("board:nothing-moved", moved.length === 0, {
          moved: moved.map((i) => i.number),
        });

        if (!fault) {
          // A drag from the card's body, not its box, is still a move.
          const card = r[3];
          await mouse.press(card.body);
          await mouse.move({ x: r[5].title.x, y: r[7].title.y + 60 }, 12);
          await shoot(page, "board-3-card-drag-still-lifts");
          await mouse.release();
          await sleep(800);
          const after = await fixture.call(
            "GET",
            `/projects/${fixture.slug}/issues?limit=50`,
          );
          const target = after.items.find((i) => String(i.number) === card.key);
          check(
            "board:card-drag-still-moves",
            target?.status.id === fixture.next,
            {
              status: target?.status.name,
            },
          );
        }
        await page.close();
      } finally {
        await context.close();
      }

      // Attachments.
      context = await browser.newContext();
      try {
        const page = await openPage(
          context,
          fixture,
          fixture.issueUrl,
          fault,
          "#attachments",
        );
        const mouse = new Mouse(page);
        let r = await evaluate(page, rows, "#attachments");
        await mouse.press(r[0].box);
        await mouse.move(r[2].title);
        await mouse.release();
        r = await evaluate(page, rows, "#attachments");
        const state = await evaluate(page, pageState);
        check(
          "attachments:adds",
          on(r).join() ===
            r
              .slice(0, 3)
              .map((x) => x.key)
              .join(),
          { on: on(r) },
        );
        check("attachments:no-text-selected", state.selection === "", state);
        await shoot(page, "attachments-1-swept");
        await page.close();
      } finally {
        await context.close();
      }
      record(tag, results, fault ? SWEEP_CASES : []);
    };

    await pass(false);
    await pass(true);
  } catch (error) {
    exitCode = 2;
    runs.push({ name: "runner-error", status: "fail", error: String(error) });
    console.error(`sweep-select-smoke: ${error.stack ?? error}`);
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
          error: String(error),
        });
      }
    }
  }
  console.log(
    `REPORT ${JSON.stringify({ status: exitCode === 0 ? "pass" : "fail", exitCode })}`,
  );
  if (stack?.dir && existsSync(stack.dir)) {
    writeFileSync(
      resolve(stack.dir, "sweep-select-smoke-report.json"),
      `${JSON.stringify({ exitCode, runs }, null, 2)}\n`,
    );
  }
  return exitCode;
}

// Every case a sweep alone can satisfy; the fault run must turn each red.
const SWEEP_CASES = [
  "list:adds",
  "list:removes",
  "list:release-on-start-keeps",
  "board:adds-across-columns",
  "attachments:adds",
];

process.exitCode = await main();
