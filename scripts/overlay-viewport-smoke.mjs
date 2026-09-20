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
 * The metadata dialog is held to I3 alone, because its focus restore is code
 * of its own rather than the shared overlay one (T-430) while its size is
 * deliberately nothing I2 would accept.
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
 *
 * T-424's shared isolated-stack and CDP modules own process supervision,
 * locking, pipe framing, and browser target lifecycle. This file keeps only
 * overlay-specific scan, probe, fault, and reporting behavior.
 */
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Clear space demanded on every side of an open overlay. */
const EDGE_PADDING = 8;

/**
 * Failures this check may report without going red — each with the reason it
 * is tolerated and the condition that retires it.
 *
 * An entry that matches nothing in a run fails the run. A tolerated failure
 * that stops happening is a line saying something untrue about the code, and
 * the only way it gets deleted is if something makes it impossible to ignore.
 *
 * Match the measured cause as well as the key: a regex alone would excuse a
 * larger overflow, an unrelated edge, or hidden content on the same submenu.
 */
const KNOWN_FAILURES = [
  {
    name: "T-468 submenu DPR rounding",
    match(failure) {
      const o = failure.overlay;
      return (
        /^I2 360×640 y=\d+ submenu(?:-rounded)? dropdown-menu-sub-content$/.test(
          failure.key,
        ) &&
        failure.problems.length === 1 &&
        o.visibility === "visible" &&
        o.devicePixelRatio === 1 &&
        o.innerWidth === 360 &&
        o.visualViewportWidth === 360 &&
        o.side === "right" &&
        o.transform === "none" &&
        o.triggerRight === 224.703125 &&
        o.left === 225 &&
        o.width === 127.296875 &&
        o.right === 352.296875 &&
        o.availableWidth === "127.29687499999997px" &&
        o.wrapperTransform === `matrix(1, 0, 0, 1, 225, ${o.top})`
      );
    },
    why:
      "T-468: collisionPadding is 8. Floating UI core size() computes " +
      "availableWidth from unrounded x=224.703125; @floating-ui/react-dom roundByDPR() " +
      "places the wrapper at 225 (DPR 1), while the border box keeps width " +
      "127.296875. This exact 0.296875px residual is recorded, not an I2 tolerance.",
    retire:
      "After a Radix/Floating UI coordinate/size fix or a submenu placement fix, " +
      "run the default smoke: submenu-rounded must still measure its left-anchored " +
      "360×640 sample and every raw edge must pass I2. A stale entry fails the run; " +
      "delete this entry only after confirming those readings. A changed failing " +
      "fingerprint needs fresh investigation, not a wider match.",
  },
];

/**
 * The checks each trigger has to contribute before a run counts as having
 * covered it. A trigger that stops resolving does not fail anything by itself
 * — its samples move quietly into "out of reach" — so without a floor the
 * check can lose whole surfaces and still exit 0. `displaced-close` and
 * `metadata-close` matter most: they are the only probes that can tell a
 * focus restore of ours from Radix's own.
 *
 * Enforced only on a full default scan with no fault seeded, because a
 * narrowed --scan-height and a short-circuited fault pass both measure less
 * on purpose. The numbers are the observed counts less a small margin;
 * re-derive them from a run's own per-trigger line after changing the page.
 *
 * Note what that scope costs: the widened scan this file recommends for
 * chasing a report is itself a non-default scan, so the run with the most
 * samples is also the run with no floor under them. `--scan-height=0` reports
 * `comment 0/3 submenu 0/3` and still exits 0. Read the per-trigger line
 * yourself when the parameters are not the defaults — it is printed on every
 * run precisely so that it can be read.
 */
const MIN_CHECKS = {
  status: 10, // 14 observed
  labels: 14, // 18
  assignees: 11, // 15
  notifications: 9, // 12
  more: 4, // 6
  comment: 3, // 4
  submenu: 3, // 4
  "submenu-rounded": 1, // Fixed left anchor at 360×640; independent of timeline wrapping.
  // One per viewport, and no margin: this probe either finds the sidebar
  // block at some scroll position or it does not.
  "metadata-close": 3,
  // 2 observed, and no margin on purpose. The third sample is lost on
  // 360×520, and not to geometry: that viewport does find a sidebar trigger
  // (labels) and does open its menu — `displace()` then returns false,
  // because the spacer it inserts fails to push the trigger out of the
  // viewport there, so the probe takes its "trigger stayed on screen" exit.
  // Why the spacer does not move it has not been worked out. Treat this 2 as
  // an unexplained shortfall rather than a ceiling: fix the displacement and
  // a third sample is there to be had, at which point raise this number.
  "displaced-close": 2,
};

/** Each `mobile: true`, each a width the card's screenshots could have come from. */
const VIEWPORTS = [
  { width: 412, height: 915 },
  { width: 360, height: 640 },
  { width: 360, height: 520 },
];

// ---------------------------------------------------------------- arguments

/**
 * A default run takes a few minutes. Widen it (`--scan-height=900
 * --scan-step=10`) when chasing a report rather than guarding a change —
 * MIN_CHECKS is calibrated against these, and stands down when they change,
 * which leaves a widened run's coverage unguarded. See MIN_CHECKS.
 */
const DEFAULTS = { scanHeight: 300, scanStep: 60 };

function parseArgs(argv) {
  const opts = {
    serverPort: 0,
    webPort: 0,
    seedFault: null,
    selfTest: false,
    selfTestReadings: false,
    ...DEFAULTS,
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
      case "--self-test-readings":
        opts.selfTestReadings = true;
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

  // The metadata probe gets a card of its own. Entries on the scanned card
  // would lengthen its sidebar, and every scan position is measured from the
  // foot of the document — one extra summary line moves all of them, and the
  // probes calibrated against those positions would quietly measure a
  // different page.
  const withMetadata = await call("POST", `/projects/${slug}/issues`, {
    title: "the card the metadata dialog sits on",
    body: seedBody(),
  });
  await call(
    "PATCH",
    `/projects/${slug}/issues/${withMetadata.number}/metadata`,
    {
      entries: [
        { namespace: "orch", key: "phase", value: "impl" },
        { namespace: "ci", key: "run", value: "green" },
      ],
    },
  );

  return {
    slug,
    number: issue.number,
    metadataNumber: withMetadata.number,
    cookie,
    status: shipped.name,
  };
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
        return document.querySelector('button[aria-label="Edit labels"]');
      case "assignees":
        return document.querySelector('button[aria-label="Edit assignees"]');
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
      case "metadata":
        return document.querySelector('[data-testid="metadata-open"]');
      case "submenu-trigger":
        return byText(
          '[data-slot="dropdown-menu-sub-trigger"]',
          "Reference in a new issue",
        );
      default:
        throw new Error(`no such trigger: ${name}`);
    }
  };

  // The dialog is here for `settled()` and `outsidePoint()` — the metadata
  // probe below needs both — and never reaches `clipped()`, which grades a
  // popper against the viewport and would read a deliberately large modal as
  // an overflowing menu.
  const OVERLAYS =
    '[data-slot="dropdown-menu-content"],[data-slot="popover-content"],' +
    '[data-slot="dropdown-menu-sub-content"],[data-slot="dialog-content"]';

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

  let pinnedComment = null;

  window.__smoke = {
    // Natural scan positions can all flip the submenu left as timestamps wrap.
    // Keep one explicit left-edge anchor to exercise right-side rounding, using
    // the real menu and its real width/collision middleware.
    pinComment() {
      const element = find("comment");
      if (!element) return false;
      pinnedComment = { element, style: element.getAttribute("style") };
      Object.assign(element.style, {
        position: "fixed",
        left: "8px",
        top: `${window.innerHeight / 2}px`,
      });
      return true;
    },
    unpinComment() {
      if (!pinnedComment) return;
      const { element, style } = pinnedComment;
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
      pinnedComment = null;
    },

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
          const style = getComputedStyle(element);
          const wrapper = element.closest(
            "[data-radix-popper-content-wrapper]",
          );
          const trigger =
            element.getAttribute("data-slot") === "dropdown-menu-sub-content"
              ? find("submenu-trigger")?.getBoundingClientRect()
              : null;
          return {
            slot: element.getAttribute("data-slot"),
            top: rect.top,
            left: rect.left,
            bottom: rect.bottom,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            visibility: style.visibility,
            devicePixelRatio,
            innerWidth,
            visualViewportWidth: visualViewport?.width ?? null,
            availableWidth: style.getPropertyValue(
              "--radix-popper-available-width",
            ),
            transform: style.transform,
            wrapperTransform: wrapper
              ? getComputedStyle(wrapper).transform
              : null,
            side: element.getAttribute("data-side"),
            triggerRight: trigger?.right ?? null,
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

    /**
     * Every trigger a scan walks, not just two: a lookup that silently stops
     * resolving turns into "out of reach" samples, which cost nothing and
     * look like a narrower page rather than a broken check.
     * `submenu-trigger` is absent here because it only exists once the
     * comment menu is open; MIN_CHECKS is what guards that one.
     */
    /** One trigger, for a page `ready()` deliberately says nothing about. */
    has: (name) => find(name) !== null,

    ready() {
      return [
        "status",
        "labels",
        "assignees",
        "notifications",
        "more",
        "comment",
      ].every((name) => find(name) !== null);
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
  "restore-scrolls": {
    invariant: "I3",
    // The scan's own I3 samples would satisfy `stopWhen` long before a
    // displaced close, and a displaced close is the only shape that grades
    // the restore rather than the lock that held the page while it was open.
    stops: (failure) => failure.key.includes("metadata-close"),
    // An arrow, not a method: this is stringified into the page, and
    // `inject() {…}` is a method shorthand rather than an expression there.
    inject: () => {
      const focus = HTMLElement.prototype.focus;
      // `preventScroll` dropped from the call — the one-word edit the
      // argument exists to stop from landing unnoticed.
      HTMLElement.prototype.focus = function () {
        return focus.call(this);
      };
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
function recordFailure(tally, failure) {
  const known = KNOWN_FAILURES.find((entry) => entry.match(failure));
  if (known === undefined) tally.failures.push(failure);
  else {
    tally.matched.add(known);
    tally.known.push({ ...failure, why: known.why });
  }
}

function clipped(overlays, viewport, where) {
  return overlays.flatMap((overlay) => {
    const problems = offViewport(overlay, viewport);
    if (problems.length === 0) return [];
    return [
      {
        invariant: "I2",
        key: `I2 ${where} ${overlay.slot}`,
        overlay,
        problems,
        detail:
          `${overlay.slot} outside the viewport — ${problems.join(", ")}; ` +
          `rect=${overlay.left},${overlay.top}..${overlay.right},${overlay.bottom} ` +
          `layout=${overlay.innerWidth} visual=${overlay.visualViewportWidth} ` +
          `dpr=${overlay.devicePixelRatio} available=${overlay.availableWidth} ` +
          `transform=${overlay.transform} wrapper=${overlay.wrapperTransform} ` +
          `side=${overlay.side} triggerRight=${overlay.triggerRight}`,
      },
    ];
  });
}

/** I2, against one measured overlay. */
function offViewport(overlay, viewport) {
  const problems = [];
  if (overlay.top < EDGE_PADDING)
    problems.push(`top ${overlay.top} < ${EDGE_PADDING}`);
  if (overlay.left < EDGE_PADDING)
    problems.push(`left ${overlay.left} < ${EDGE_PADDING}`);
  if (overlay.bottom > viewport.height - EDGE_PADDING)
    problems.push(
      `bottom ${overlay.bottom} > ${viewport.height - EDGE_PADDING}`,
    );
  if (overlay.right > viewport.width - EDGE_PADDING)
    problems.push(`right ${overlay.right} > ${viewport.width - EDGE_PADDING}`);
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
async function probeSubmenu(page, viewport, y, how, name = "submenu") {
  const before = await evaluate(page, (to) => window.__smoke.scrollTo(to), y);
  const where = `${viewport.width}×${viewport.height} y=${before} ${name}`;
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

async function probeRoundedSubmenu(page, viewport, how) {
  const y = await evaluate(page, () =>
    window.__smoke.scrollTo(window.__smoke.bottom()),
  );
  if (!(await evaluate(page, () => window.__smoke.pinComment()))) {
    return { inert: "no comment trigger to anchor", where: "submenu-rounded" };
  }
  try {
    return await probeSubmenu(page, viewport, y, how, "submenu-rounded");
  } finally {
    await evaluate(page, () => window.__smoke.unpinComment());
  }
}

/**
 * I3 with the trigger off-screen at close time — the only shape in which the
 * focus restore can move the page, and therefore the only one that tells the
 * override in DropdownMenuContent from Radix's own restore.
 */
async function probeDisplacedClose(page, viewport, how) {
  await evaluate(page, () => window.__smoke.scrollTo(window.__smoke.bottom()));
  const where = `${viewport.width}×${viewport.height} displaced-close`;
  // Whichever sidebar trigger this viewport can actually reach at the foot of
  // the document. Insisting on the status pill cost two of the three viewports
  // — and this is the one probe that tells the override from Radix's own
  // restore, so it is the last one that should go quiet.
  let name = null;
  let point = null;
  for (const candidate of [
    "status",
    "labels",
    "assignees",
    "notifications",
    "more",
  ]) {
    point = await evaluate(page, (n) => window.__smoke.tapPoint(n), candidate);
    if (point !== null) {
      name = candidate;
      break;
    }
  }
  if (name === null) {
    return { skipped: "no sidebar trigger within reach", where };
  }

  await tap(page, point);
  if ((await waitForOverlays(page, 1)).length === 0) {
    return { inert: `${name} menu did not open`, where };
  }
  const displaced = await evaluate(
    page,
    (n, pixels) => window.__smoke.displace(n, pixels),
    name,
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

/**
 * The same shape for the metadata dialog, whose restore is its own code rather
 * than the shared overlay one (T-430): the opener is displaced out of the
 * viewport while the dialog is up, so only a restore that scrolls can move the
 * page. A modal is graded on I3 alone — `clipped()` measures a popper against
 * the viewport, and a dialog is meant to be large.
 *
 * It looks for its own scroll position instead of taking the foot of the
 * document: the sidebar stacks below the timeline on these widths, and where
 * the section lands is a layout question this check has no business pinning.
 * On its own card, too — see `seed`.
 */
async function probeMetadataClose(page, target, viewport, how) {
  const where = `${viewport.width}×${viewport.height} metadata-close`;
  await page.cdp.send(
    "Page.navigate",
    {
      url: `${target.url}/projects/${target.slug}/issues/${target.metadataNumber}`,
    },
    page.sessionId,
  );
  const deadline = Date.now() + 30000;
  while (
    (await evaluate(page, () => window.__smoke?.has?.("metadata"))) !== true
  ) {
    if (Date.now() > deadline)
      return { inert: "the metadata card never rendered", where };
    await sleep(200);
  }
  const bottom = await evaluate(page, () => window.__smoke.bottom());
  let point = null;
  for (let offset = 0; offset <= 1200; offset += 100) {
    await evaluate(
      page,
      (to) => window.__smoke.scrollTo(to),
      Math.max(0, bottom - offset),
    );
    point = await evaluate(page, () => window.__smoke.tapPoint("metadata"));
    if (point !== null) break;
  }
  if (point === null) return { skipped: "metadata block out of reach", where };

  await tap(page, point);
  if ((await waitForOverlays(page, 1)).length === 0) {
    return { inert: "the metadata dialog did not open", where };
  }
  const displaced = await evaluate(
    page,
    (pixels) => window.__smoke.displace("metadata", pixels),
    3000,
  );
  const before = await evaluate(page, () => window.__smoke.scrollY());
  await closeOverlay(page, how);
  const after = await scrollYAfterClose(page);
  if (!displaced) return { skipped: "the block stayed on screen", where };
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
    // Per trigger, because a total cannot say which surface stopped being
    // measured: dropping one trigger moves its samples into `skipped`, and
    // both counts stay plausible.
    byTrigger: {},
    // Which KNOWN_FAILURES entries this run actually saw. One that saw nothing
    // is stale, and the run says so rather than carrying it another year.
    matched: new Set(),
  };
  const record = (name, result) => {
    tally.byTrigger[name] ??= { checks: 0, skipped: 0, inert: 0 };
    const seen = tally.byTrigger[name];
    if (result === null || result.skipped) {
      tally.skipped++;
      seen.skipped++;
    } else if (result.inert) {
      tally.inert.push(`${result.where}: ${result.inert}`);
      seen.inert++;
    } else {
      seen.checks++;
      tally.checks++;
      for (const failure of result.failures) {
        recordFailure(tally, failure);
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
      if (Date.now() > deadline) {
        const state = await evaluate(page, () => {
          const names = [
            "status",
            "labels",
            "assignees",
            "notifications",
            "more",
            "comment",
          ];
          return {
            url: location.href,
            title: document.title,
            helper: typeof window.__smoke,
            missing: names.filter(
              (name) => window.__smoke?.tapPoint(name) === null,
            ),
          };
        });
        throw new Error(
          `the issue page never rendered: ${JSON.stringify(state)}`,
        );
      }
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
        record(trigger, await probe(page, viewport, trigger, y, opts.close));
        if (done()) return tally;
      }
      record("submenu", await probeSubmenu(page, viewport, y, opts.close));
      if (done()) return tally;
    }

    if (viewport.width === 360 && viewport.height === 640) {
      record(
        "submenu-rounded",
        await probeRoundedSubmenu(page, viewport, opts.close),
      );
      if (done()) return tally;
    }

    record(
      "displaced-close",
      await probeDisplacedClose(page, viewport, opts.close),
    );
    if (done()) return tally;

    // Last in the viewport, because it navigates away from the scanned card.
    record(
      "metadata-close",
      await probeMetadataClose(page, target, viewport, opts.close),
    );
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
  const perTrigger = Object.entries(tally.byTrigger)
    .map(([name, t]) => `${name} ${t.checks}/${t.checks + t.skipped + t.inert}`)
    .join("  ");
  if (perTrigger !== "") console.log(`  checked  ${perTrigger}`);
  for (const failure of tally.failures)
    console.log(`  ${failure.key}: ${failure.detail}`);
  for (const known of tally.known)
    console.log(`  known ${known.key}: ${known.detail} — ${known.why}`);
  for (const inert of tally.inert) console.log(`  ? ${inert}`);
  return tally;
}

/**
 * Triggers that came back under their floor. Only meaningful on a full default
 * scan; anything narrower is measuring less by request.
 */
function underFloor(tally, opts) {
  if (opts.seedFault !== null) return [];
  if (
    opts.scanHeight !== DEFAULTS.scanHeight ||
    opts.scanStep !== DEFAULTS.scanStep
  ) {
    return [];
  }
  return Object.entries(MIN_CHECKS)
    .filter(([name, floor]) => (tally.byTrigger[name]?.checks ?? 0) < floor)
    .map(
      ([name, floor]) =>
        `${name}: ${tally.byTrigger[name]?.checks ?? 0} checks, floor ${floor}`,
    );
}

function reportFloors(tally, opts) {
  const short = underFloor(tally, opts);
  for (const line of short) console.log(`coverage below its floor — ${line}`);
  return short.length === 0;
}

/** Entries that saw nothing this run, which is a failure of the list itself. */
function stale(tally) {
  return KNOWN_FAILURES.filter((entry) => !tally.matched.has(entry));
}

function reportStale(tally) {
  const gone = stale(tally);
  for (const entry of gone) {
    console.log(
      `stale known failure, delete it: ${entry.name} — ${entry.retire}`,
    );
  }
  return gone.length === 0;
}

/** Replay actual T-468 readings through the same classifier and retirement check. */
function selfTestReadings() {
  const viewport = { width: 360, height: 640 };
  const reading = {
    slot: "dropdown-menu-sub-content",
    top: 284,
    left: 225,
    bottom: 324,
    right: 352.296875,
    width: 127.296875,
    height: 40,
    visibility: "visible",
    devicePixelRatio: 1,
    innerWidth: 360,
    visualViewportWidth: 360,
    availableWidth: "127.29687499999997px",
    transform: "none",
    wrapperTransform: "matrix(1, 0, 0, 1, 225, 284)",
    side: "right",
    triggerRight: 224.703125,
  };
  const cases = [
    ["observed", {}, viewport, 0, 1, 0],
    [
      "good: right edge repaired",
      { right: 352, width: 127 },
      viewport,
      0,
      0,
      1,
    ],
    [
      "bad: larger overflow",
      { right: 353.296875, width: 128.296875 },
      viewport,
      1,
      0,
      1,
    ],
    [
      "bad: tiny extra overflow",
      { right: 352.3125, width: 127.3125 },
      viewport,
      1,
      0,
      1,
    ],
    ["bad: another edge", { top: 7 }, viewport, 1, 0, 1],
    ["bad: hidden", { visibility: "hidden" }, viewport, 1, 0, 1],
    ["bad: unrelated cause", { triggerRight: 224 }, viewport, 1, 0, 1],
    ["bad: another viewport", {}, { width: 360, height: 520 }, 1, 0, 1],
  ];
  let passed = true;
  for (const [name, patch, size, unexpected, known, obsolete] of cases) {
    const tally = { failures: [], known: [], matched: new Set() };
    for (const failure of clipped(
      [{ ...reading, ...patch }],
      size,
      `${size.width}×${size.height} y=3886 submenu-rounded`,
    ))
      recordFailure(tally, failure);
    const fresh = reportStale(tally);
    const held =
      tally.failures.length === unexpected &&
      tally.known.length === known &&
      Number(!fresh) === obsolete;
    const exit = tally.failures.length === 0 && fresh ? 0 : 1;
    console.log(
      `${held ? "ok" : "FAIL"} reading ${name}: ${tally.failures.length} unexpected, ` +
        `${tally.known.length} known, ${stale(tally).length} stale; run would exit ${exit}`,
    );
    for (const failure of tally.failures) console.log(`  ${failure.detail}`);
    passed &&= held;
  }
  return passed ? 0 : 1;
}

// ----------------------------------------------------------------------- main

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTestReadings) return selfTestReadings();
  let stack = null;
  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "overlay-smoke-",
      keep: opts.keep,
      serverPort: opts.serverPort,
      webPort: opts.webPort,
    });
    const seeded = await seed(stack.serverPort);

    const browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const context = await browser.newContext();
    const equals = seeded.cookie.indexOf("=");
    const page = await context.newPage({
      cookie: {
        name: seeded.cookie.slice(0, equals),
        value: seeded.cookie.slice(equals + 1),
        domain: "127.0.0.1",
        path: "/",
      },
    });
    const url = stack.webUrl;
    const target = {
      url,
      slug: seeded.slug,
      number: seeded.number,
      metadataNumber: seeded.metadataNumber,
    };
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
      // Faults deliberately change the fingerprint; only clean readings can
      // establish that a known failure has actually been repaired.
      const fresh = opts.seedFault !== null || reportStale(tally);
      const covered = reportFloors(tally, opts);
      if (tally.inert.length > 0 || !fresh || !covered) return 1;
      if (opts.seedFault === null) return tally.failures.length === 0 ? 0 : 1;
      const invariant = FAULTS[opts.seedFault].invariant;
      const bit = tally.failures.some((f) => f.invariant === invariant);
      if (!bit)
        console.log(`the ${opts.seedFault} fault broke no ${invariant}`);
      return bit ? 0 : 1;
    }
    if (selfTestReadings() !== 0) return 1;

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
    for (const [fault, { invariant, stops }] of Object.entries(FAULTS)) {
      await arm(page, fault);
      const stopWhen =
        stops === undefined
          ? isNew(invariant)
          : (failure) => isNew(invariant)(failure) && stops(failure);
      faulted[fault] = report(
        `fault:${fault}`,
        await runPass(page, target, opts, { stopWhen }),
      );
    }

    const verdicts = [
      ["clean run is green", clean.failures.length === 0],
      ["every known failure still happens", reportStale(clean)],
      ["every trigger met its coverage floor", reportFloors(clean, opts)],
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
      // Keyed on the metadata sample rather than on I3 at large: the fault
      // reaches every restore on the page, and a menu going red would sign
      // this one off without the dialog's own restore ever being graded.
      [
        "fault:restore-scrolls breaks I3 at the metadata dialog anew",
        faulted["restore-scrolls"].failures.some(
          (failure) =>
            isNew("I3")(failure) && failure.key.includes("metadata-close"),
        ),
      ],
    ];
    console.log("");
    for (const [what, held] of verdicts)
      console.log(`${held ? "ok  " : "FAIL"} ${what}`);
    return verdicts.every(([, held]) => held) ? 0 : 1;
  } finally {
    await stack?.cleanup();
  }
}
async function main() {
  try {
    return await run();
  } catch (error) {
    console.error(`overlay-viewport-smoke: ${error.stack ?? error}`);
    return 2;
  }
}

process.exitCode = await main();
