#!/usr/bin/env node
/**
 * Holds the overlay layer to three invariants a layout engine has to measure,
 * on an issue page scrolled to the places a thumb actually reaches (T-388):
 *
 *   I1  opening an overlay does not move `window.scrollY`
 *   I2  an open overlay's bounding box lies inside the viewport, 8px clear of
 *       every edge, and is not `visibility: hidden`
 *   I3  closing an overlay does not move `window.scrollY`
 *
 * Deliberately outside `pnpm test` and outside CI. `projects/web` runs on
 * happy-dom, which has no layout: nothing there can read a bounding box or a
 * scroll offset, and standing up vitest browser mode for three assertions was
 * weighed and declined on the card. Run it by hand when the overlay layer
 * changes — `--self-test` is the one command that says whether it still works:
 *
 *   node scripts/overlay-viewport-smoke.mjs --self-test
 *
 * Two things it does not do, because Chrome's device emulation cannot: an
 * Android address bar collapsing under an overlay's scroll lock, and a system
 * font scale that grows a menu without narrowing the layout. Those stay manual
 * acceptance steps on the card.
 *
 * Why it speaks CDP over a pipe rather than a WebSocket: `--remote-debugging-pipe`
 * needs no `WebSocket` global, so the script does not silently require a Node
 * newer than the one on PATH, and it hands back no debugging port for another
 * process on this machine to wander into. Touches go through
 * `Input.dispatchTouchEvent`, not synthesised `PointerEvent`s — the browser's
 * own tap behaviour (focusing what was tapped, scrolling the focused element
 * into view) is precisely what a synthetic event cannot reproduce, and it is
 * the prime suspect this check exists to rule out.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";

/** Clear space demanded on every side of an open overlay. */
const EDGE_PADDING = 8;

/**
 * Failures this check may report without going red — each with the reason it
 * is tolerated and the condition that retires it.
 *
 * Empty on purpose: everything the T-388 sweep turned up is fixed. It exists
 * for the next person who finds a failure they cannot fix that day, so the
 * choice is "record it with an expiry" rather than "delete the check" or
 * "remember which lines don't count".
 *
 * An entry that matches nothing in a run fails the run. A tolerated failure
 * that stops happening is a line saying something untrue about the code, and
 * the only way it gets deleted is if something makes it impossible to ignore.
 *
 *   { match: /^I2 \d+×\d+ y=\d+ submenu/,
 *     why:    "why this is allowed to be red today",
 *     retire: "what has to be true for this entry to be deleted" }
 */
const KNOWN_FAILURES = [];

/** Each `mobile: true`, each a width the card's screenshots could have come from. */
const VIEWPORTS = [
  { width: 412, height: 915 },
  { width: 360, height: 640 },
  { width: 360, height: 520 },
];

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    serverPort: 0,
    webPort: 0,
    seedFault: null,
    selfTest: false,
    // A default run takes a few minutes. Widen it (`--scan-height=900
    // --scan-step=10`) when chasing a report rather than guarding a change.
    scanHeight: 300,
    scanStep: 60,
    close: "outside",
    keep: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, null];
    switch (key) {
      case "--server-port":
      case "--web-port":
      case "--scan-height":
      case "--scan-step":
        if (value === null) fail(`${key} needs a value: ${key}=<n>`);
        opts[
          {
            "--server-port": "serverPort",
            "--web-port": "webPort",
            "--scan-height": "scanHeight",
            "--scan-step": "scanStep",
          }[key]
        ] = Number(value);
        break;
      case "--seed-fault":
        if (!FAULTS[value]) fail(`unknown fault: ${value}`);
        opts.seedFault = value;
        break;
      case "--close":
        if (value !== "outside" && value !== "escape")
          fail("--close takes outside or escape");
        opts.close = value;
        break;
      case "--self-test":
        opts.selfTest = true;
        break;
      case "--keep":
        opts.keep = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`overlay-viewport-smoke: ${message}`);
  process.exit(2);
}

// ------------------------------------------------------------- the isolated stack

async function freePort() {
  return await new Promise((ok, no) => {
    const probe = createServer();
    probe.on("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

/** Poll `url` until it answers or the budget runs out. */
async function waitForHttp(url, what, budgetMs = 60000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${what} never answered at ${url}`);
}

async function startStack(opts, dir) {
  const serverPort = opts.serverPort || (await freePort());
  const webPort = opts.webPort || (await freePort());

  writeFileSync(
    join(dir, "config.toml"),
    [
      "[auth]",
      'mode = "single"',
      "",
      "[http]",
      `port = ${serverPort}`,
      "",
      "[database]",
      `system = "pglite://${join(dir, "db")}"`,
      "auto_migrate = true",
      "",
      "[storage]",
      `path = "${join(dir, "attachments")}"`,
      "",
    ].join("\n"),
  );

  const server = spawn(
    process.execPath,
    [
      "projects/server/src/index.ts",
      "serve",
      "--config",
      join(dir, "config.toml"),
    ],
    // Its own process group, because `pnpm dev` is a wrapper around vite and
    // `pnpm exec` around tsx: killing the child this handle names leaves the
    // real listener holding the port for the next run to collide with.
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const web = spawn(
    "pnpm",
    [
      "--filter",
      "@todou/web",
      "dev",
      "--port",
      String(webPort),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TODOU_API: `http://127.0.0.1:${serverPort}` },
    },
  );

  const log = (child, name) => {
    let tail = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        tail = (tail + chunk).slice(-4000);
      });
    }
    child.on("exit", (code) => {
      if (code !== null && code !== 0)
        console.error(`${name} exited ${code}\n${tail}`);
    });
    return () => tail;
  };
  const serverTail = log(server, "server");
  const webTail = log(web, "web");

  try {
    await waitForHttp(`http://127.0.0.1:${serverPort}/api/auth/mode`, "server");
    await waitForHttp(`http://127.0.0.1:${webPort}/`, "web dev server");
  } catch (error) {
    console.error(`server log:\n${serverTail()}\nweb log:\n${webTail()}`);
    throw error;
  }

  return { serverPort, webPort, children: [server, web] };
}

// -------------------------------------------------------------------- seeding

/** Enough body and timeline that the sidebar sits far below the fold. */
function seedBody() {
  const paragraph =
    "The report arrives as a handful of key frames and no recording, so the " +
    "page under test has to be long enough that the sidebar lands past the " +
    "fold at every width being scanned.";
  return Array.from(
    { length: 12 },
    (_, i) => `### Section ${i + 1}\n\n${paragraph}`,
  ).join("\n\n");
}

async function seed(serverPort) {
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
    if (setCookie) cookie = setCookie.split(";")[0];
    if (!response.ok) {
      throw new Error(
        `${method} ${path} → ${response.status} ${await response.text()}`,
      );
    }
    return await response.json();
  };

  await call("POST", "/auth/login");
  const slug = "smoke";
  await call("POST", "/projects", {
    slug,
    name: "Overlay smoke",
    description: "",
  });

  const statuses = await call("GET", `/projects/${slug}/statuses`);
  const shipped = statuses.find((s) => s.name === "Shipped") ?? statuses.at(-1);

  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "the card the overlays sit on",
    body: seedBody(),
  });
  for (let i = 1; i <= 14; i++) {
    await call("POST", `/projects/${slug}/issues/${issue.number}/comments`, {
      body: `Comment ${i}. Another line of timeline, so the page keeps growing.`,
    });
  }
  // Last, so the timeline carries the status events too — the reported card
  // was sitting on Shipped when the menu misbehaved.
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    status_id: shipped.id,
  });

  return { slug, number: issue.number, cookie, status: shipped.name };
}

// ------------------------------------------------------------ CDP over a pipe

class Cdp {
  #child;
  #pending = new Map();
  #handlers = new Map();
  #nextId = 1;
  #buffer = Buffer.alloc(0);

  constructor(child) {
    this.#child = child;
    child.stdio[4].on("data", (chunk) => this.#consume(chunk));
  }

  #consume(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      // Chrome delimits pipe messages with NUL and splits them across reads.
      const end = this.#buffer.indexOf(0);
      if (end === -1) return;
      const message = JSON.parse(
        this.#buffer.subarray(0, end).toString("utf8"),
      );
      this.#buffer = this.#buffer.subarray(end + 1);
      if (message.id !== undefined) {
        const settle = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (!settle) continue;
        if (message.error) settle.no(new Error(JSON.stringify(message.error)));
        else settle.ok(message.result);
      } else {
        for (const handler of this.#handlers.get(message.method) ?? [])
          handler(message.params);
      }
    }
  }

  on(method, handler) {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    this.#child.stdio[3].write(`${JSON.stringify(payload)}\0`);
    return new Promise((ok, no) => this.#pending.set(id, { ok, no }));
  }
}

async function startBrowser(dir) {
  const child = spawn(
    CHROMIUM,
    [
      "--remote-debugging-pipe",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${join(dir, "chrome")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const cdp = new Cdp(child);
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  return { child, cdp, sessionId };
}

/** Run `fn` in the page with JSON-serialisable arguments, and return its value. */
async function evaluate(page, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const { result, exceptionDetails } = await page.cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    page.sessionId,
  );
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ??
        JSON.stringify(exceptionDetails),
    );
  }
  return result.value;
}

// ------------------------------------------------------------- the page probes

/**
 * Installed before every document: everything the checks need to read out of
 * the page, in one place, so a probe is one round trip rather than five.
 */
function pageHelpers() {
  const byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find(
      (element) => element.textContent.trim() === text,
    ) ?? null;

  const find = (name) => {
    switch (name) {
      case "status": {
        const section = [...document.querySelectorAll("aside section")].find(
          (s) => s.querySelector("h3")?.textContent.trim() === "Status",
        );
        return (
          section?.querySelector('[data-slot="dropdown-menu-trigger"]') ?? null
        );
      }
      case "labels":
        return byText("button", "Edit labels");
      case "assignees":
        return byText("button", "Edit assignees");
      case "notifications":
        return byText("button", "Notifying");
      case "more":
        return document.querySelector('button[aria-label="More actions"]');
      case "comment": {
        // Whichever comment menu is nearest the middle of the viewport: the
        // timeline holds a dozen, and the reachable one is the point.
        const middle = window.innerHeight / 2;
        return (
          [
            ...document.querySelectorAll(
              'button[aria-label="comment actions"]',
            ),
          ].sort(
            (a, b) =>
              Math.abs(a.getBoundingClientRect().top - middle) -
              Math.abs(b.getBoundingClientRect().top - middle),
          )[0] ?? null
        );
      }
      case "submenu-trigger":
        return byText(
          '[data-slot="dropdown-menu-sub-trigger"]',
          "Reference in a new issue",
        );
      default:
        throw new Error(`no such trigger: ${name}`);
    }
  };

  const OVERLAYS =
    '[data-slot="dropdown-menu-content"],[data-slot="popover-content"],' +
    '[data-slot="dropdown-menu-sub-content"]';

  // A dismissal tap is aimed blind, and a popover is non-modal, so the tap
  // reaches whatever is under it. Following a link from there would be scored
  // as the document scrolling to its top. Nothing here ever needs to leave the
  // page, and buttons still work — Radix acts on pointerdown, not on click.
  document.addEventListener(
    "click",
    (event) => {
      if (event.target?.closest?.("a[href]")) event.preventDefault();
    },
    true,
  );

  window.__smoke = {
    /** Where a thumb could land on the trigger, or null when none of it is reachable. */
    tapPoint(name) {
      const element = find(name);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      const top = Math.max(rect.top, 0);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      const left = Math.max(rect.left, 0);
      const right = Math.min(rect.right, window.innerWidth);
      if (bottom - top < 1 || right - left < 1) return null;
      const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
      // A point the trigger does not own is a point the finger would miss.
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && element.contains(hit) ? point : null;
    },

    /** Every open overlay, measured. */
    overlays() {
      return [...document.querySelectorAll(OVERLAYS)]
        .filter((element) => element.getAttribute("data-state") === "open")
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            slot: element.getAttribute("data-slot"),
            top: rect.top,
            left: rect.left,
            bottom: rect.bottom,
            right: rect.right,
            visibility: getComputedStyle(element).visibility,
          };
        });
    },

    /**
     * A closing overlay animates out and keeps the body's pointer-events
     * blocked meanwhile, so a tap sent the moment `data-state` flips lands on
     * nothing and the next check silently measures a menu that never opened.
     */
    settled() {
      return (
        document.querySelectorAll(OVERLAYS).length === 0 &&
        getComputedStyle(document.body).pointerEvents !== "none"
      );
    },

    /**
     * Somewhere a finger can land to dismiss: covered by no open overlay, and
     * over nothing that would act on the tap. A popover is non-modal, so an
     * outside tap really does reach what is under it — dismissing on the
     * navbar navigates, and a check that scored that would read a page load as
     * a scroll of the whole document.
     */
    outsidePoint() {
      const boxes = [...document.querySelectorAll(OVERLAYS)].map((element) =>
        element.getBoundingClientRect(),
      );
      const covered = (x, y) =>
        boxes.some(
          (box) =>
            x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
        );
      const ACTS_ON_A_TAP =
        "a,button,input,textarea,select,summary,label,[role='button']," +
        "[role='link'],[role='menuitem'],[role='option'],[tabindex]";
      for (let y = 8; y < window.innerHeight; y += 24) {
        for (const x of [window.innerWidth / 2, 8, window.innerWidth - 8]) {
          if (covered(x, y)) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit === null || hit.closest(ACTS_ON_A_TAP) !== null) continue;
          return { x, y };
        }
      }
      return null;
    },

    here: () => location.href,

    scrollY: () => window.scrollY,
    bottom: () => document.documentElement.scrollHeight - window.innerHeight,
    scrollTo(y) {
      window.scrollTo(0, y);
      return window.scrollY;
    },

    /**
     * Grow the page above a trigger until it leaves the viewport, without
     * touching the scroll position. This is the one route comment-4447 found
     * to a trigger that is off-screen while its menu is open — new timeline
     * entries arriving over SSE do exactly this — and it is what makes I3
     * falsifiable rather than vacuous.
     */
    displace(name, pixels) {
      const element = find(name);
      if (element === null) return false;
      const spacer = document.createElement("div");
      spacer.style.height = `${pixels}px`;
      spacer.dataset.smokeSpacer = "";
      element.parentElement.insertBefore(spacer, element);
      return element.getBoundingClientRect().top > window.innerHeight;
    },

    ready() {
      return find("status") !== null && find("comment") !== null;
    },
  };
}

// ------------------------------------------------------------------- the faults

/**
 * Each fault must make exactly one invariant fail. A run that seeds a fault and
 * still comes back green is a broken check, not a passing one — which is what
 * `--self-test` exists to notice, and why each one names the invariant it owns.
 */
const FAULTS = {
  scroll: {
    invariant: "I1",
    // An arrow, not a method: this is stringified into the page, and
    // `inject() {…}` is a method shorthand rather than an expression there.
    inject: () => {
      const move = () => {
        // react-remove-scroll pins the page with
        // `body[data-scroll-locked] { overflow: hidden !important }`, so a
        // plain scrollTo while an overlay is open is clamped to where it
        // already is. The fault has to lift the lock, or it seeds nothing.
        document.body.removeAttribute("data-scroll-locked");
        document.body.style.setProperty("overflow", "auto", "important");
        window.scrollTo(0, Math.max(0, window.scrollY - 300));
      };
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (
              node.dataset?.slot?.endsWith("-content") ||
              node.querySelector?.('[data-slot$="-content"]')
            )
              setTimeout(move, 0);
          }
        }
      }).observe(document, { childList: true, subtree: true });
    },
  },
  geometry: {
    invariant: "I2",
    // An arrow, not a method: this is stringified into the page, and
    // `inject() {…}` is a method shorthand rather than an expression there.
    inject: () => {
      const style = document.createElement("style");
      style.textContent =
        '[data-slot="dropdown-menu-content"],[data-slot="popover-content"],' +
        '[data-slot="dropdown-menu-sub-content"]' +
        "{max-height:none !important;min-height:200vh !important}";
      document.head.append(style);
    },
  },
};

// ------------------------------------------------------------------ the checks

async function tap(page, point) {
  await page.cdp.send(
    "Input.dispatchTouchEvent",
    { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] },
    page.sessionId,
  );
  await page.cdp.send(
    "Input.dispatchTouchEvent",
    { type: "touchEnd", touchPoints: [] },
    page.sessionId,
  );
}

/**
 * How the overlay gets dismissed. A phone has no Escape key, so the tap
 * outside is the close a reported symptom would have come through; both run
 * the same `onCloseAutoFocus`, and which one was used is worth being able to
 * show rather than assert.
 */
async function closeOverlay(page, how) {
  if (how === "outside") {
    const point = await evaluate(page, () => window.__smoke.outsidePoint());
    if (point !== null) return await tap(page, point);
  }
  return await pressEscape(page);
}

async function pressEscape(page) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.cdp.send(
      "Input.dispatchKeyEvent",
      { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      page.sessionId,
    );
  }
}

async function waitForOverlays(page, want, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const overlays = await evaluate(page, () => window.__smoke.overlays());
    if (overlays.length === want) return overlays;
    if (Date.now() > deadline) return overlays;
    await sleep(25);
  }
}

/**
 * Read the overlays once their boxes stop moving. Capping a width feeds back
 * into floating-ui's next recompute — size() runs after flip(), so the
 * available width it publishes is the one for the placement before the cap —
 * and measuring mid-convergence reports a position no user ever sees. Returns
 * the last reading either way, so an overlay that never settles is still
 * judged rather than silently skipped.
 */
async function settleOverlays(page, want, budgetMs = 1000) {
  const deadline = Date.now() + budgetMs;
  let previous = await waitForOverlays(page, want);
  for (;;) {
    await sleep(50);
    const current = await evaluate(page, () => window.__smoke.overlays());
    const same =
      current.length === previous.length &&
      current.every((overlay, i) => {
        const before = previous[i];
        return (
          Math.round(overlay.top) === Math.round(before.top) &&
          Math.round(overlay.left) === Math.round(before.left) &&
          Math.round(overlay.bottom) === Math.round(before.bottom) &&
          Math.round(overlay.right) === Math.round(before.right)
        );
      });
    if (same || Date.now() > deadline) return current;
    previous = current;
  }
}

/** Wait out the close animation, then read the scroll position it settled on. */
async function scrollYAfterClose(page, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs;
  while (!(await evaluate(page, () => window.__smoke.settled()))) {
    if (Date.now() > deadline) break;
    await sleep(25);
  }
  return await evaluate(page, () => window.__smoke.scrollY());
}

/**
 * A failure is keyed on what broke and where, and carries the numbers
 * separately — see the self-test, which has to tell a fault's failure from one
 * the tree already had.
 */
function moved(invariant, where, when, from, to) {
  return {
    invariant,
    key: `${invariant} ${where} ${when}`,
    detail: `page moved on ${when}, ${from} → ${to}`,
  };
}

function clipped(overlays, viewport, where) {
  return overlays.flatMap((overlay) => {
    const problems = offViewport(overlay, viewport);
    if (problems.length === 0) return [];
    return [
      {
        invariant: "I2",
        key: `I2 ${where} ${overlay.slot}`,
        detail: `${overlay.slot} outside the viewport — ${problems.join(", ")}`,
      },
    ];
  });
}

/** I2, against one measured overlay. */
function offViewport(overlay, viewport) {
  const problems = [];
  if (overlay.top < EDGE_PADDING)
    problems.push(`top ${Math.round(overlay.top)} < ${EDGE_PADDING}`);
  if (overlay.left < EDGE_PADDING)
    problems.push(`left ${Math.round(overlay.left)} < ${EDGE_PADDING}`);
  if (overlay.bottom > viewport.height - EDGE_PADDING)
    problems.push(
      `bottom ${Math.round(overlay.bottom)} > ${viewport.height - EDGE_PADDING}`,
    );
  if (overlay.right > viewport.width - EDGE_PADDING)
    problems.push(
      `right ${Math.round(overlay.right)} > ${viewport.width - EDGE_PADDING}`,
    );
  if (overlay.visibility === "hidden") problems.push("visibility: hidden");
  return problems;
}

/**
 * Open one overlay from one trigger at the current scroll position and judge
 * all three invariants. Returns a list of failures, or null when the trigger
 * had no reachable pixel here.
 */
async function probe(page, viewport, trigger, y, how) {
  // Re-scrolled per trigger, not per position: a probe that moved the page
  // would otherwise hand the next one a baseline it never stood on, and every
  // trigger after the first would report a failure belonging to the first.
  const before = await evaluate(page, (to) => window.__smoke.scrollTo(to), y);
  const point = await evaluate(
    page,
    (name) => window.__smoke.tapPoint(name),
    trigger,
  );
  if (point === null) return null;

  const where = `${viewport.width}×${viewport.height} y=${before} ${trigger}`;
  const failures = [];
  await tap(page, point);
  const overlays = await settleOverlays(page, 1);
  const afterOpen = await evaluate(page, () => window.__smoke.scrollY());

  if (overlays.length === 0) return { inert: "no overlay opened", where };
  if (afterOpen !== before) {
    failures.push(moved("I1", where, "open", before, afterOpen));
  }
  failures.push(...clipped(overlays, viewport, where));

  const here = await evaluate(page, () => window.__smoke.here());
  await closeOverlay(page, how);
  const afterClose = await scrollYAfterClose(page);
  if ((await evaluate(page, () => window.__smoke.here())) !== here) {
    return { inert: "the dismissal navigated", where };
  }
  if (afterClose !== afterOpen) {
    failures.push(moved("I3", where, "close", afterOpen, afterClose));
  }
  return { failures, where };
}

/** The submenu, which only exists once its parent menu is open. */
async function probeSubmenu(page, viewport, y, how) {
  const before = await evaluate(page, (to) => window.__smoke.scrollTo(to), y);
  const where = `${viewport.width}×${viewport.height} y=${before} submenu`;
  const point = await evaluate(page, () => window.__smoke.tapPoint("comment"));
  if (point === null) return null;
  await tap(page, point);
  if ((await waitForOverlays(page, 1)).length === 0) {
    return { inert: "comment menu did not open", where };
  }

  const failures = [];
  const subPoint = await evaluate(page, () =>
    window.__smoke.tapPoint("submenu-trigger"),
  );
  if (subPoint === null) {
    await closeOverlay(page, how);
    await scrollYAfterClose(page);
    return { skipped: "submenu trigger out of reach", where };
  }
  await tap(page, subPoint);
  const overlays = await settleOverlays(page, 2);
  if (overlays.length < 2) {
    await closeOverlay(page, how);
    await closeOverlay(page, how);
    await scrollYAfterClose(page);
    return { inert: "submenu did not open", where };
  }
  const afterOpen = await evaluate(page, () => window.__smoke.scrollY());
  if (afterOpen !== before) {
    failures.push(moved("I1", where, "open", before, afterOpen));
  }
  failures.push(...clipped(overlays, viewport, where));
  await closeOverlay(page, how);
  await closeOverlay(page, how);
  const afterClose = await scrollYAfterClose(page);
  if (afterClose !== afterOpen) {
    failures.push(moved("I3", where, "close", afterOpen, afterClose));
  }
  return { failures, where };
}

/**
 * I3 with the trigger off-screen at close time — the only shape in which the
 * focus restore can move the page, and therefore the only one that tells the
 * override in DropdownMenuContent from Radix's own restore.
 */
async function probeDisplacedClose(page, viewport, how) {
  await evaluate(page, () => window.__smoke.scrollTo(window.__smoke.bottom()));
  const point = await evaluate(page, () => window.__smoke.tapPoint("status"));
  if (point === null)
    return { skipped: "status pill out of reach", where: "displaced" };

  const where = `${viewport.width}×${viewport.height} displaced-close`;
  await tap(page, point);
  if ((await waitForOverlays(page, 1)).length === 0) {
    return { inert: "status menu did not open", where };
  }
  const displaced = await evaluate(
    page,
    (name, pixels) => window.__smoke.displace(name, pixels),
    "status",
    3000,
  );
  const before = await evaluate(page, () => window.__smoke.scrollY());
  await closeOverlay(page, how);
  const after = await scrollYAfterClose(page);
  if (!displaced) return { skipped: "trigger stayed on screen", where };
  return {
    where,
    failures:
      after === before ? [] : [moved("I3", where, "close", before, after)],
  };
}

// ------------------------------------------------------------------- one pass

async function runPass(page, target, opts, { stopWhen = null } = {}) {
  // `skipped` is the honest one — no pixel of the trigger was inside the
  // viewport, so a finger could not have started this. `inert` is the
  // suspicious one: the tap landed on the trigger and nothing opened, which
  // means the check measured nothing and must not read as a pass.
  const tally = {
    checks: 0,
    skipped: 0,
    inert: [],
    failures: [],
    known: [],
    // Which KNOWN_FAILURES entries this run actually saw. One that saw nothing
    // is stale, and the run says so rather than carrying it another year.
    matched: new Set(),
  };
  const record = (result) => {
    if (result === null || result.skipped) tally.skipped++;
    else if (result.inert) tally.inert.push(`${result.where}: ${result.inert}`);
    else {
      tally.checks++;
      for (const failure of result.failures) {
        const known = KNOWN_FAILURES.find((entry) =>
          entry.match.test(failure.key),
        );
        if (known === undefined) tally.failures.push(failure);
        else {
          tally.matched.add(known);
          tally.known.push({ ...failure, why: known.why });
        }
      }
    }
  };
  /** Fault passes stop at the failure they were seeded to cause, not at any. */
  const done = () => stopWhen !== null && tally.failures.some(stopWhen);

  for (const viewport of VIEWPORTS) {
    await page.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 0,
        mobile: true,
      },
      page.sessionId,
    );
    await page.cdp.send(
      "Emulation.setTouchEmulationEnabled",
      { enabled: true, maxTouchPoints: 1 },
      page.sessionId,
    );

    await page.cdp.send(
      "Page.navigate",
      { url: `${target.url}/projects/${target.slug}/issues/${target.number}` },
      page.sessionId,
    );
    const deadline = Date.now() + 30000;
    while (!(await evaluate(page, () => window.__smoke?.ready() ?? false))) {
      if (Date.now() > deadline)
        throw new Error("the issue page never rendered");
      await sleep(200);
    }

    const bottom = await evaluate(page, () => window.__smoke.bottom());
    const positions = [];
    for (let offset = 0; offset <= opts.scanHeight; offset += opts.scanStep) {
      positions.push(Math.max(0, bottom - offset));
    }

    for (const y of positions) {
      for (const trigger of [
        "status",
        "labels",
        "assignees",
        "notifications",
        "more",
        "comment",
      ]) {
        record(await probe(page, viewport, trigger, y, opts.close));
        if (done()) return tally;
      }
      record(await probeSubmenu(page, viewport, y, opts.close));
      if (done()) return tally;
    }

    record(await probeDisplacedClose(page, viewport, opts.close));
    if (done()) return tally;
  }

  return tally;
}

/** Install the helpers, plus a fault when one is asked for, before every document. */
async function arm(page, fault) {
  for (const id of page.injected ?? []) {
    await page.cdp.send(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier: id },
      page.sessionId,
    );
  }
  page.injected = [];
  const sources = [`(${pageHelpers.toString()})()`];
  // A document-start script runs before the parser has made <html>, so a fault
  // that touches the DOM at once throws and installs nothing — silently, and
  // the run then reads as a clean pass. Hold each one until there is a
  // document. pageHelpers only defines a global, so it needs no such wait.
  if (fault) {
    sources.push(
      `(() => { const run = ${FAULTS[fault].inject.toString()};
         if (document.readyState === "loading")
           document.addEventListener("DOMContentLoaded", run, { once: true });
         else run(); })()`,
    );
  }
  for (const source of sources) {
    const { identifier } = await page.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      page.sessionId,
    );
    page.injected.push(identifier);
  }
}

function report(label, tally) {
  console.log(
    `${label}: ${tally.checks} checks, ${tally.skipped} out of reach, ` +
      `${tally.inert.length} opened nothing, ${tally.failures.length} failures` +
      (tally.known.length > 0 ? `, ${tally.known.length} known` : ""),
  );
  for (const failure of tally.failures)
    console.log(`  ${failure.key}: ${failure.detail}`);
  for (const known of tally.known)
    console.log(`  known ${known.key}: ${known.detail} — ${known.why}`);
  for (const inert of tally.inert) console.log(`  ? ${inert}`);
  return tally;
}

/** Entries that saw nothing this run, which is a failure of the list itself. */
function stale(tally) {
  return KNOWN_FAILURES.filter((entry) => !tally.matched.has(entry));
}

function reportStale(tally) {
  const gone = stale(tally);
  for (const entry of gone) {
    console.log(
      `stale known failure, delete it: ${entry.match} — ${entry.retire}`,
    );
  }
  return gone.length === 0;
}

// ----------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (Number(process.versions.node.split(".")[0]) < 24) {
    fail(
      `needs Node 24 (the server entry is run as TypeScript); this is ${process.version}. ` +
        "Use the devshell's node.",
    );
  }

  const dir = mkdtempSync(join(ROOT, ".tmp", "overlay-smoke-"));
  const started = [];
  let browser = null;
  try {
    const stack = await startStack(opts, dir);
    started.push(...stack.children);
    const seeded = await seed(stack.serverPort);

    browser = await startBrowser(dir);
    const page = { cdp: browser.cdp, sessionId: browser.sessionId };
    const url = `http://127.0.0.1:${stack.webPort}`;
    await page.cdp.send(
      "Network.setCookie",
      {
        name: seeded.cookie.split("=")[0],
        value: seeded.cookie.split(/=(.*)/s)[1],
        domain: "127.0.0.1",
        path: "/",
      },
      page.sessionId,
    );
    const target = { url, slug: seeded.slug, number: seeded.number };
    console.log(
      `issue ${seeded.slug}#${seeded.number} on ${seeded.status}, web ${url}, ` +
        `scan ${opts.scanHeight}px up in ${opts.scanStep}px steps, ` +
        `closing by ${opts.close === "outside" ? "a tap outside" : "Escape"}`,
    );

    if (!opts.selfTest) {
      await arm(page, opts.seedFault);
      const tally = report(
        opts.seedFault ? `fault:${opts.seedFault}` : "clean",
        await runPass(page, target, opts),
      );
      const fresh = reportStale(tally);
      if (tally.inert.length > 0 || !fresh) return 1;
      if (opts.seedFault === null) return tally.failures.length === 0 ? 0 : 1;
      const invariant = FAULTS[opts.seedFault].invariant;
      const bit = tally.failures.some((f) => f.invariant === invariant);
      if (!bit)
        console.log(`the ${opts.seedFault} fault broke no ${invariant}`);
      return bit ? 0 : 1;
    }

    await arm(page, null);
    const clean = report("clean", await runPass(page, target, opts));

    // A failure the clean run already had proves nothing about the fault, so
    // each fault pass has to produce one the clean run did not — otherwise a
    // pre-existing breakage would sign off the check on the fault's behalf.
    // Keyed on what failed and where, never on the numbers: a clipped overlay
    // measures -76px on one run and -78px on the next, and a string compare
    // would read that jitter as a brand-new failure and sign the fault off.
    // Tolerated failures count as pre-existing too: a fault must not be signed
    // off by something the tree was already doing, listed or not.
    const already = new Set(
      [...clean.failures, ...clean.known].map((failure) => failure.key),
    );
    const isNew = (invariant) => (failure) =>
      failure.invariant === invariant && !already.has(failure.key);

    const faulted = {};
    for (const [fault, { invariant }] of Object.entries(FAULTS)) {
      await arm(page, fault);
      faulted[fault] = report(
        `fault:${fault}`,
        await runPass(page, target, opts, { stopWhen: isNew(invariant) }),
      );
    }

    const verdicts = [
      ["clean run is green", clean.failures.length === 0],
      ["every known failure still happens", reportStale(clean)],
      ["clean run measured something", clean.checks > 0],
      ["every clean tap opened its overlay", clean.inert.length === 0],
      [
        "fault:scroll breaks I1 anew",
        faulted.scroll.failures.some(isNew("I1")),
      ],
      [
        "fault:geometry breaks I2 anew",
        faulted.geometry.failures.some(isNew("I2")),
      ],
    ];
    console.log("");
    for (const [what, held] of verdicts)
      console.log(`${held ? "ok  " : "FAIL"} ${what}`);
    return verdicts.every(([, held]) => held) ? 0 : 1;
  } finally {
    if (browser) {
      browser.child.kill();
      await Promise.race([
        new Promise((ok) => browser.child.once("exit", ok)),
        sleep(5000).then(() => browser.child.kill("SIGKILL")),
      ]);
    }
    for (const child of started) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGKILL");
      }
    }
    await sleep(500);
    if (!opts.keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`kept ${dir}`);
  }
}

process.exitCode = await main();
