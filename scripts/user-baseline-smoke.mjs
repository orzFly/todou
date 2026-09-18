#!/usr/bin/env node
/**
 * Browser geometry smoke for the baseline-alignment sweep in T-433.
 *
 * The production change has three event-row parents and nine author-row
 * parents.  A hit means Chromium measured two inline baselines in a real
 * exported production component.  Reading the source is useful drift evidence,
 * but is deliberately reported as a guard and never promoted to a browser hit.
 * The low-frequency private spec-view rows are reached through the real
 * production spec route; the Vite-only fixture covers the exported components.
 * Shared stack/CDP infrastructure owns locking, process supervision, pipe
 * framing, and browser target lifecycle; this file retains the fixture,
 * source guards, measurement cases, and fault proofs.
 *
 * Run manually (this intentionally is not part of the happy-dom test suite):
 *   node scripts/user-baseline-smoke.mjs
 *   node scripts/user-baseline-smoke.mjs --self-test
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";
import {
  assessT359FreshPageRestore,
  assessT416FreshPageRestore,
  probeT359AvatarFault,
  probeT416BadgeClippingFault,
} from "./user-baseline-faults.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_URL = "/test/browser/user-baseline.html";
const EPSILON = 0.125;
const VIEWPORTS = [
  { name: "390-mobile", width: 390, height: 844 },
  { name: "639-mobile-boundary", width: 639, height: 844 },
  { name: "640-desktop-boundary", width: 640, height: 800 },
  { name: "768-tablet", width: 768, height: 800 },
  { name: "1280-desktop", width: 1280, height: 800 },
];

const AVATAR_CASES = [
  "human-none",
  "human-success",
  "human-failure",
  "human-delayed",
  "machine-none",
  "machine-success",
  "machine-failure",
  "machine-delayed",
];

const CASES = [
  guard(
    "event-row",
    "event",
    "projects/web/src/components/timeline/event-row.tsx",
    /sm:flex sm:items-baseline sm:gap-2/,
  ),
  guard(
    "list-group",
    "event",
    "projects/web/src/components/timeline/event-group.tsx",
    /sm:flex sm:items-baseline sm:gap-2/,
  ),
  guard(
    "collapsed-group",
    "event",
    "projects/web/src/components/timeline/event-group.tsx",
    /sm:flex sm:items-baseline sm:gap-2/,
  ),
  guard(
    "assignee-row",
    "event",
    "projects/web/src/components/timeline/event-group.tsx",
    /inline-flex flex-wrap items-baseline gap-1 align-baseline/,
  ),
  guard(
    "body-block",
    "author",
    "projects/web/src/pages/issue-detail.tsx",
    /flex items-baseline gap-2 border-b/,
  ),
  guard(
    "comment-item",
    "author",
    "projects/web/src/components/timeline/comment-item.tsx",
    /flex items-baseline gap-2 border-b/,
  ),
  guard(
    "revision-history",
    "author",
    "projects/web/src/components/shared/revision-history.tsx",
    /items-baseline gap-2 rounded-md/,
  ),
  guard(
    "spec-version-menu-row",
    "author",
    "projects/web/src/components/spec/spec-version-picker.tsx",
    /mt-1 flex items-baseline gap-1\.5/,
  ),
  guard(
    "comment-hover-card",
    "author",
    "projects/web/src/components/shared/comment-hover-card.tsx",
    /mb-2 flex items-baseline gap-2/,
  ),
  guard(
    "spec-annotation-hover-card",
    "author",
    "projects/web/src/components/shared/spec-annotation-hover-card.tsx",
    /mb-2 flex items-baseline gap-2/,
  ),
  guard(
    "unplaced-comment",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function UnplacedComment[\s\S]*?mb-1 flex items-baseline gap-2/,
  ),
  guard(
    "diff-annotation",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function DiffAnnotation[\s\S]*?mb-1 flex items-baseline gap-2/,
  ),
  guard(
    "annotation-chip",
    "author",
    "projects/web/src/components/spec/annotated-markdown.tsx",
    /item\.item\.author[\s\S]*?items-baseline|items-baseline[\s\S]*?item\.item\.author/,
  ),
];

const ROUTE_CASES = CASES.filter((entry) =>
  ["unplaced-comment", "diff-annotation"].includes(entry.id),
);
const REVISION_CASES = CASES.filter((entry) => entry.id === "revision-history");
const FIXTURE_CASES = CASES.filter(
  (entry) => !ROUTE_CASES.includes(entry) && !REVISION_CASES.includes(entry),
);

function guard(id, family, file, pattern) {
  return { id, family, file, pattern };
}

function parseArgs(argv) {
  const out = {
    selfTest: false,
    selfTestCase: null,
    keep: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s);
    if (key === "--self-test" && value === undefined) out.selfTest = true;
    else if (key === "--self-test-case" && value) {
      out.selfTest = true;
      out.selfTestCase = value;
    } else if (key === "--keep" && value === undefined) out.keep = true;
    else usage(`unknown argument: ${arg}`);
  }
  return out;
}

function usage(message) {
  console.error(`user-baseline-smoke: ${message}`);
  process.exit(2);
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
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    if (!response.ok)
      throw new Error(
        `${method} ${path} -> ${response.status} ${await response.text()}`,
      );
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  };
  await call("POST", "/auth/login");
  const viewer = await call("GET", "/me");
  await call("PATCH", "/me", { display_name: "Alice" });
  const slug = "baseline-smoke";
  await call("POST", "/projects", {
    slug,
    name: "Baseline smoke",
    description: "",
  });
  const statuses = await call("GET", `/projects/${slug}/statuses`);
  const bot = await call("POST", "/agents", {
    login: "bot-one",
    display_name: "Bot One",
  });
  await call("PUT", `/projects/${slug}/members/${bot.id}`, { role: "writer" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "baseline geometry",
    body: "A real issue body for the author header.",
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    body: "A real issue body for the author header, edited once for history.",
  });
  await call("POST", `/projects/${slug}/issues/${issue.number}/comments`, {
    body: "A real timeline comment for the author header.",
  });
  const statusA = statuses[1] ?? statuses[0];
  const statusB = statuses[2] ?? statuses.at(-1);
  if (!statusA || !statusB || statusA.id === statusB.id) {
    throw new Error("baseline fixture needs two distinct statuses");
  }
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    status_id: statusA.id,
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    status_id: statusB.id,
  });
  // A net-nonempty assignment run reaches CollapsedGroup; changing the title
  // between writes prevents command coalescing from being the only evidence.
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    assignee_ids: [viewer.id],
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    assignee_ids: [viewer.id, bot.id],
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    assignee_ids: [bot.id],
  });
  await call("POST", `/projects/${slug}/issues`, {
    title: "referrer",
    body: `See #${issue.number} for the baseline geometry.`,
  });
  const specPath = `/projects/${slug}/issues/${issue.number}/spec`;
  const firstSpec = [
    "# Baseline fixture",
    "",
    "An original line that will change.",
    "",
    "A stable paragraph with the annotation chip.",
  ].join("\n");
  await call("POST", `${specPath}/push`, {
    message: "Baseline fixture version one",
    files: [{ path: "plan.md", body: firstSpec }],
  });
  await call("POST", `${specPath}/reviews`, {
    version: 1,
    verdict: "comment",
    body: "Baseline review",
    comments: [
      { anchor: { path: "plan.md", version: 1 }, body: "File-level review" },
      {
        anchor: { path: "plan.md", version: 1, line_start: 3, line_end: 3 },
        body: "Changed line review",
      },
      {
        anchor: { path: "plan.md", version: 1, line_start: 5, line_end: 5 },
        body: "Stable line review",
      },
    ],
  });
  await call("POST", `${specPath}/push`, {
    message: "Baseline fixture version two",
    files: [
      {
        path: "plan.md",
        body: firstSpec.replace(
          "An original line that will change.",
          "A revised line.",
        ),
      },
    ],
  });
  return {
    slug,
    number: issue.number,
    cookie,
    botId: bot.id,
    viewerId: viewer.id,
  };
}

async function pageFor(browser, viewport, cookie, url) {
  const equals = cookie.indexOf("=");
  return await browser.newPage({
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 640,
    },
    cookie: {
      name: cookie.slice(0, equals),
      value: cookie.slice(equals + 1),
      url,
    },
  });
}

async function load(page, url) {
  await page.cdp.send("Page.navigate", { url }, page.sessionId);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await evaluate(page, () => ({
      ready: window.__USER_BASELINE_READY__ === true,
      errors: window.__USER_BASELINE_ERRORS__ ?? [],
    }));
    if (state.ready) {
      const font = await evaluate(page, async () => {
        await document.fonts.ready;
        return {
          loaded: document.fonts.check('12px "Geist Variable"'),
          family: getComputedStyle(document.body).fontFamily,
        };
      });
      return font.loaded && font.family.includes("Geist Variable")
        ? state.errors
        : [
            ...state.errors,
            `production Geist font unavailable (${font.family})`,
          ];
    }
    await sleep(100);
  }
  throw new Error("fixture never set window.__USER_BASELINE_READY__");
}

/**
 * Zero-size inline blocks expose the browser's actual first-line baseline.
 * Measuring text ink or the bottom of the flex items hides subpixel errors.
 */
async function measure(page, faultId = null, cases = CASES) {
  return await evaluate(
    page,
    (ids, epsilon, fault) => {
      const rows = [];
      const rect = (box) => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      const deepQuery = (selector, host = document) => {
        const match = host.querySelector(selector);
        if (match) return match;
        for (const element of host.querySelectorAll("*")) {
          if (element.shadowRoot) {
            const nested = deepQuery(selector, element.shadowRoot);
            if (nested) return nested;
          }
        }
        return null;
      };
      const textLeaf = (element, preferName) => {
        const name = preferName
          ? [...element.querySelectorAll("span")].find((span) =>
              span.classList.contains("ml-1.5"),
            )
          : null;
        // The first participant must be UserChip's visible name. Falling back
        // to the whole chip can silently measure avatar initials instead.
        if (preferName && !name) return null;
        const host = name ?? element;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent.trim()) node = walker.nextNode();
        return node;
      };
      for (const id of ids) {
        const root = deepQuery(`[data-baseline-case="${CSS.escape(id)}"]`);
        if (!root) {
          rows.push({
            id,
            status: "missing",
            reason: "real component did not render",
          });
          continue;
        }
        if (
          !root.isConnected ||
          root.getClientRects().length === 0 ||
          root.getBoundingClientRect().width <= 0 ||
          root.getBoundingClientRect().height <= 0 ||
          getComputedStyle(root).display === ""
        ) {
          rows.push({
            id,
            status: "invalid",
            reason: "sample is detached, hidden, or has no computed layout",
          });
          continue;
        }
        const participants = ["author", "peer"].map((part) => {
          const selector = `[data-baseline-participant="${part}"]`;
          return root.matches(selector) ? root : root.querySelector(selector);
        });
        if (participants.some((part) => !part)) {
          rows.push({
            id,
            status: "missing",
            reason: "author/peer text not marked",
          });
          continue;
        }
        let mutationRoot = root;
        if (id === "assignee-row") {
          mutationRoot =
            root.querySelector("[data-baseline-fault-target]") ?? root;
        }
        const beforeStyle = getComputedStyle(mutationRoot);
        const before = {
          alignItems: beforeStyle.alignItems,
          display: beforeStyle.display,
          verticalAlign: beforeStyle.verticalAlign,
        };
        let mutation = null;
        if (fault === id) {
          if (id === "assignee-row") {
            mutationRoot.style.alignItems = "center";
            mutationRoot.style.verticalAlign = "middle";
            mutation = "assignee alignment restored to center/middle";
          } else {
            mutationRoot.style.alignItems = "center";
            mutation = "text flex row restored to items-center";
          }
          if (["unplaced-comment", "annotation-chip"].includes(id)) {
            root.style.whiteSpace = "nowrap";
            root.style.width = "max-content";
            root.style.zoom = "2";
            mutation += " at 200% zoom without wrapping";
          }
          const after = getComputedStyle(mutationRoot);
          if (
            id === "diff-annotation" &&
            after.display === "" &&
            mutationRoot.style.alignItems === "center"
          ) {
            // Pierre may detach and replace a shadow-root annotation while its
            // diff is painting. The inline style took effect on the selected
            // node, but an uncomputed node cannot supply a layout verdict.
            rows.push({
              id,
              status: "invalid",
              reason: "diff annotation detached during old-style mutation",
            });
            continue;
          }
          if (
            after.alignItems !== "center" ||
            (id === "assignee-row" && after.verticalAlign !== "middle") ||
            (before.alignItems === after.alignItems &&
              (id !== "assignee-row" ||
                before.verticalAlign === after.verticalAlign))
          ) {
            rows.push({
              id,
              status: "invalid",
              reason: `fault did not take effect: ${mutation} (${before.display}/${before.alignItems} → ${after.display}/${after.alignItems})`,
            });
            continue;
          }
        }
        const rowBox = rect(root.getBoundingClientRect());
        const baselines = [];
        const styles = [];
        let invalid = null;
        for (const [index, element] of participants.entries()) {
          const node = textLeaf(element, index === 0);
          if (!node) {
            invalid =
              index === 0
                ? "author UserChip visible name span (.ml-1.5) is missing"
                : "peer participant lacks text";
            break;
          }
          const host = node.parentNode;
          const range = document.createRange();
          range.selectNodeContents(node);
          const textBefore = [...range.getClientRects()].map(rect);
          const participantBefore = rect(element.getBoundingClientRect());
          const rowBeforeMarker = rect(root.getBoundingClientRect());
          const marker = document.createElement("span");
          marker.setAttribute("aria-hidden", "true");
          marker.style.cssText =
            "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline";
          host.insertBefore(marker, node);
          const y = marker.getBoundingClientRect().top;
          const rowAfter = rect(root.getBoundingClientRect());
          const participantAfter = rect(element.getBoundingClientRect());
          const textAfter = [...range.getClientRects()].map(rect);
          marker.remove();
          const same = (a, b) =>
            Math.abs(a.width - b.width) <= epsilon &&
            Math.abs(a.height - b.height) <= epsilon;
          if (
            !same(rowBeforeMarker, rowAfter) ||
            !same(participantBefore, participantAfter) ||
            textBefore.length !== textAfter.length ||
            textBefore.some(
              (box, textIndex) =>
                Math.abs(box.y - textAfter[textIndex].y) > epsilon ||
                Math.abs(box.width - textAfter[textIndex].width) > epsilon,
            )
          ) {
            invalid = `baseline marker changed geometry (row ${JSON.stringify(rowBeforeMarker)} → ${JSON.stringify(rowAfter)}, participant ${JSON.stringify(participantBefore)} → ${JSON.stringify(participantAfter)}, text rects ${textBefore.length} → ${textAfter.length})`;
            break;
          }
          const css = getComputedStyle(element);
          styles.push({
            font: css.font,
            lineHeight: css.lineHeight,
            display: css.display,
            verticalAlign: css.verticalAlign,
          });
          baselines.push(y);
        }
        const spread = Math.abs(baselines[0] - baselines[1]);
        const lineHeight = Math.max(
          ...styles.map((style) => Number.parseFloat(style.lineHeight) || 20),
        );
        if (!invalid && spread > lineHeight * 0.75) {
          invalid = "participants are on different text lines";
        }
        const status = invalid
          ? "invalid"
          : spread <= epsilon
            ? "hit"
            : "failure";
        rows.push({
          id,
          status,
          count: invalid ? 0 : 1,
          baselines: baselines.map((value) => Number(value.toFixed(5))),
          spread: Number.isFinite(spread) ? Number(spread.toFixed(5)) : null,
          row: {
            ...rowBox,
            display: before.display,
            alignItems: before.alignItems,
          },
          styles,
          mutation,
          reason:
            invalid ??
            (status === "failure"
              ? `name minus text ${spread.toFixed(5)} CSS px exceeds ${epsilon}`
              : null),
        });
      }
      return rows;
    },
    cases.map((entry) => entry.id),
    EPSILON,
    faultId,
  );
}

function sourceGuards() {
  return CASES.map((entry) => {
    const source = readFileSync(resolve(ROOT, entry.file), "utf8");
    return { id: entry.id, pass: entry.pattern.test(source), file: entry.file };
  });
}

async function armAvatarNetwork(page) {
  await page.cdp.send(
    "Fetch.enable",
    {
      patterns: [
        { urlPattern: "*avatar-missing.svg*" },
        { urlPattern: "*avatar-delayed.svg*" },
      ],
    },
    page.sessionId,
  );
  let delayedRequest = null;
  const immediate = [];
  const unsubscribe = page.on("Fetch.requestPaused", (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.endsWith("/avatar-delayed.svg")) {
      delayedRequest = event.requestId;
    } else if (url.pathname.endsWith("/avatar-missing.svg")) {
      immediate.push(
        page.cdp.send(
          "Fetch.fulfillRequest",
          {
            requestId: event.requestId,
            responseCode: 404,
            responseHeaders: [{ name: "content-type", value: "image/svg+xml" }],
            body: "",
          },
          page.sessionId,
        ),
      );
    } else {
      immediate.push(
        page.cdp.send(
          "Fetch.continueRequest",
          {
            requestId: event.requestId,
          },
          page.sessionId,
        ),
      );
    }
  });
  return {
    release: async () => {
      try {
        const deadline = Date.now() + 5_000;
        while (delayedRequest === null && Date.now() < deadline)
          await sleep(25);
        if (delayedRequest === null)
          throw new Error("delayed avatar request never paused");
        await Promise.all(immediate);
        await page.cdp.send(
          "Fetch.continueRequest",
          {
            requestId: delayedRequest,
          },
          page.sessionId,
        );
      } finally {
        unsubscribe();
      }
    },
  };
}

async function measureAvatars(page, settle = "initial") {
  return await evaluate(
    page,
    async (ids, epsilon, phase) => {
      await document.fonts.ready;
      if (phase === "settled") {
        await Promise.all(
          [
            ...document.querySelectorAll(
              '[data-avatar-case$="-success"] img, [data-avatar-case$="-delayed"] img',
            ),
          ].map((image) => image.decode().catch(() => undefined)),
        );
      }
      return ids.map((id) => {
        const row = document.querySelector(`[data-avatar-case="${id}"]`);
        const author = row?.querySelector('[data-avatar-participant="author"]');
        const name = author?.querySelector(":scope > span.ml-1\\.5");
        const peer = row?.querySelector('[data-avatar-participant="peer"]');
        if (!row || !author || !name || !peer) {
          return {
            id,
            status: "missing",
            reason: "real UserChip sample not rendered",
          };
        }
        const baseline = (element) => {
          const marker = document.createElement("span");
          marker.style.cssText =
            "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
          element.insertBefore(marker, element.firstChild);
          const y = marker.getBoundingClientRect().top;
          marker.remove();
          return y;
        };
        const nameY = baseline(name);
        const peerY = baseline(peer);
        const image = author.querySelector("img");
        const avatar = author.querySelector('[data-slot="avatar"]');
        const rowBox = row.getBoundingClientRect();
        const spread = Math.abs(nameY - peerY);
        return {
          id,
          status: spread <= epsilon ? "hit" : "failure",
          phase,
          spread: Number(spread.toFixed(5)),
          rowHeight: Number(rowBox.height.toFixed(5)),
          nameY: Number(nameY.toFixed(5)),
          avatar: avatar
            ? {
                width: Number(avatar.getBoundingClientRect().width.toFixed(5)),
                height: Number(
                  avatar.getBoundingClientRect().height.toFixed(5),
                ),
              }
            : null,
          image: image
            ? { complete: image.complete, naturalWidth: image.naturalWidth }
            : null,
          reason:
            spread <= epsilon
              ? null
              : `name minus sentence ${spread.toFixed(5)} CSS px`,
        };
      });
    },
    AVATAR_CASES,
    EPSILON,
    settle,
  );
}

async function browserRun(browser, base, seeded, viewport, fault = null) {
  // Every clean viewport and every fault gets a new target. Mutation isolation
  // is data-driven over CASES and does not rely on undoing styles correctly.
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    const network = await armAvatarNetwork(page);
    const fixtureErrors = await load(page, url);
    const avatarInitial = await measureAvatars(page, "initial");
    await network.release();
    await sleep(250);
    const avatarSettled = await measureAvatars(page, "settled");
    const initialById = new Map(
      avatarInitial.map((entry) => [entry.id, entry]),
    );
    for (const entry of avatarSettled) {
      const initial = initialById.get(entry.id);
      const requiresImage =
        entry.id.endsWith("-success") || entry.id.endsWith("-delayed");
      const requiresFailure = entry.id.endsWith("-failure");
      if (
        !initial ||
        Math.abs(entry.rowHeight - initial.rowHeight) > EPSILON ||
        Math.abs(entry.nameY - initial.nameY) > EPSILON
      ) {
        entry.status = "failure";
        entry.reason = "fallback-to-image changed name baseline or row height";
      } else if (requiresImage && entry.image?.naturalWidth <= 0) {
        entry.status = "failure";
        entry.reason = "successful avatar image did not load";
      } else if (
        requiresFailure &&
        entry.image &&
        entry.image.naturalWidth !== 0
      ) {
        entry.status = "failure";
        entry.reason = "failed avatar request unexpectedly loaded";
      }
    }
    const result = {
      viewport: viewport.name,
      fault,
      fixtureErrors,
      rows: await measure(page, fault, FIXTURE_CASES),
      avatars: { initial: avatarInitial, settled: avatarSettled },
    };
    if (options.keep && !fault) {
      const screenshot = await page.cdp.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
        },
        page.sessionId,
      );
      writeFileSync(
        join(dir, `clean-${viewport.name}.png`),
        Buffer.from(screenshot.data, "base64"),
      );
    }
    return result;
  } finally {
    await page.close();
  }
}

const UNTOUCHED_CASES = [
  "issue-list-assignees",
  "board-card-assignees",
  "auth-target-fieldset",
  "assignee-picker",
  "mention-link",
  "issue-sidebar-assignees",
  "project-members-table",
];

async function measureUntouched(page) {
  return await evaluate(
    page,
    (ids, epsilon) => {
      const rows = [];
      for (const id of ids) {
        const root = document.querySelector(
          `[data-untouched-case="${CSS.escape(id)}"]`,
        );
        if (!root) {
          rows.push({
            id,
            status: "missing",
            reason: "real context did not render",
          });
          continue;
        }
        const targets = [
          ...root.querySelectorAll("[data-untouched-target]"),
          ...document.querySelectorAll(
            `[data-untouched-portal-for="${CSS.escape(id)}"] [data-untouched-target]`,
          ),
        ];
        if (["issue-sidebar-assignees", "project-members-table"].includes(id)) {
          for (const avatar of root.querySelectorAll('[data-slot="avatar"]')) {
            const chip = avatar.closest('a[href^="/users/"]');
            if (chip) targets.push(chip, avatar);
          }
        }
        const unique = [...new Set(targets)];
        if (!unique.length) {
          rows.push({
            id,
            status: "missing",
            reason: "context has no user target",
          });
          continue;
        }
        const boxes = unique.map((target) => {
          const box = target.getBoundingClientRect();
          const rootBox = root.getBoundingClientRect();
          const badge = target.querySelector?.('svg[aria-label="agent"]');
          const badgeBox = badge?.getBoundingClientRect();
          return {
            kind:
              target.dataset.untouchedTarget ??
              target.getAttribute("data-slot") ??
              target.tagName,
            x: Number((box.x - rootBox.x).toFixed(5)),
            y: Number((box.y - rootBox.y).toFixed(5)),
            width: Number(box.width.toFixed(5)),
            height: Number(box.height.toFixed(5)),
            badge: badgeBox
              ? {
                  right: Number((badgeBox.right - box.right).toFixed(5)),
                  bottom: Number((badgeBox.bottom - box.bottom).toFixed(5)),
                  width: Number(badgeBox.width.toFixed(5)),
                  height: Number(badgeBox.height.toFixed(5)),
                }
              : null,
          };
        });
        let mentionSpread = null;
        if (id === "mention-link") {
          const mention = root.querySelector("[data-mention-link]");
          const textNode = [...(mention?.childNodes ?? [])].find(
            (node) =>
              node.nodeType === Node.TEXT_NODE &&
              node.textContent.includes("@"),
          );
          if (mention && textNode) {
            const marker = document.createElement("span");
            marker.style.cssText =
              "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
            mention.insertBefore(marker, textNode);
            const mentionY = marker.getBoundingClientRect().top;
            const peer = document.createElement("span");
            peer.style.cssText = marker.style.cssText;
            root.insertBefore(peer, mention);
            const peerY = peer.getBoundingClientRect().top;
            marker.remove();
            peer.remove();
            mentionSpread = Number(Math.abs(mentionY - peerY).toFixed(5));
          }
        }
        rows.push({
          id,
          status:
            boxes.every((box) => box.width > 0 && box.height > 0) &&
            (mentionSpread === null || mentionSpread <= epsilon)
              ? "hit"
              : "failure",
          count: boxes.length,
          boxes,
          mentionSpread,
        });
      }
      return rows;
    },
    UNTOUCHED_CASES,
    EPSILON,
  );
}

async function untouchedRun(browser, base, seeded, viewport) {
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}&surface=untouched`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    const errors = await load(page, url);
    return { errors, rows: await measureUntouched(page) };
  } finally {
    await page.close();
  }
}

async function revisionRun(browser, base, seeded, viewport, fault = null) {
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}&surface=revision`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    const fixtureErrors = await load(page, url);
    return {
      viewport: viewport.name,
      fault,
      fixtureErrors,
      rows: await measure(page, fault, REVISION_CASES),
    };
  } finally {
    await page.close();
  }
}

/** The two private spec author rows are exercised through the production router. */
async function specRouteRun(
  browser,
  base,
  seeded,
  viewport,
  kind,
  fault = null,
) {
  const url = `${base}/projects/${seeded.slug}/issues/${seeded.number}/spec?file=plan.md&v=2&compare=1&view=${kind === "diff-annotation" ? "source" : "rendered"}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    await page.cdp.send("Page.navigate", { url }, page.sessionId);
    const deadline = Date.now() + 25_000;
    let state = null;
    while (Date.now() < deadline) {
      state = await evaluate(
        page,
        async (caseId) => {
          const deepRows = (host = document) => {
            const rows = [...host.querySelectorAll(".mb-1.flex")];
            for (const element of host.querySelectorAll("*")) {
              if (element.shadowRoot)
                rows.push(...deepRows(element.shadowRoot));
            }
            return rows;
          };
          const candidate = deepRows().find((row) => {
            if (
              !row.isConnected ||
              row.getBoundingClientRect().width <= 0 ||
              row.getBoundingClientRect().height <= 0 ||
              getComputedStyle(row).display === "" ||
              !row.querySelector('a[href^="/users/"]')
            )
              return false;
            if (caseId === "diff-annotation") {
              return !!row.closest(".border-y.bg-background.px-3.py-2");
            }
            return !!row.closest(".space-y-2.rounded-lg.border.px-4.py-3");
          });
          if (!candidate) {
            return {
              ready: false,
              text: document.body?.innerText.slice(0, 500) ?? "",
            };
          }
          const author = candidate.querySelector('a[href^="/users/"]');
          const peer = [...candidate.children].find(
            (element) =>
              element !== author && element.textContent.includes("v1"),
          );
          if (!author || !peer)
            return { ready: false, text: candidate.outerHTML.slice(0, 600) };
          await document.fonts.ready;
          if (!document.fonts.check('12px "Geist Variable"')) {
            return { ready: true, error: "Geist Variable did not load" };
          }
          candidate.dataset.baselineCase = caseId;
          author.dataset.baselineParticipant = "author";
          peer.dataset.baselineParticipant = "peer";
          return { ready: true };
        },
        kind,
      );
      if (state?.ready) break;
      await sleep(150);
    }
    const errors = [];
    if (!state?.ready)
      errors.push(`${kind} route sample timed out: ${state?.text ?? ""}`);
    if (state?.error) errors.push(state.error);
    return {
      viewport: viewport.name,
      fault,
      fixtureErrors: errors,
      rows: await measure(
        page,
        fault,
        ROUTE_CASES.filter((entry) => entry.id === kind),
      ),
    };
  } finally {
    await page.close();
  }
}
async function historicalFaultRun(browser, base, seeded, kind, mode) {
  const viewport = kind === "T-359" ? VIEWPORTS[0] : VIEWPORTS.at(-1);
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    const network = await armAvatarNetwork(page);
    const fixtureErrors = await load(page, url);
    await network.release();
    await sleep(250);
    if (fixtureErrors.length) {
      return { id: kind, status: "invalid", reason: fixtureErrors.join("; ") };
    }
    return await evaluate(
      page,
      kind === "T-359" ? probeT359AvatarFault : probeT416BadgeClippingFault,
      { mode },
    );
  } finally {
    await page.close();
  }
}

function printRun(run) {
  const label = run.fault ? `FAULT ${run.fault}` : `CLEAN ${run.viewport}`;
  const hits = run.rows.filter((r) => r.status === "hit").map((r) => r.id);
  const failures = run.rows.filter(
    (row) => !["hit", "missing"].includes(row.status),
  );
  const missing = run.rows.filter((row) => row.status === "missing");
  console.log(`\n${label}`);
  console.log(`  hits (${hits.length}): ${hits.join(", ") || "none"}`);
  console.log(
    `  failures (${failures.length}): ${failures.map((row) => `${row.id} [${row.reason}]`).join(", ") || "none"}`,
  );
  console.log(
    `  missing (${missing.length}): ${missing.map((row) => `${row.id} [${row.reason}]`).join(", ") || "none"}`,
  );
  for (const row of run.rows) {
    if (row.status === "hit") {
      console.log(
        `    ${row.id}: expected ≤${EPSILON}, actual ${row.spread ?? 0} CSS px; ` +
          `${row.styles?.map((style) => `${style.font}/${style.lineHeight}/${style.display}/${style.verticalAlign}`).join(" | ") ?? "route styles recorded"}`,
      );
    }
  }
  if (run.avatars) {
    const avatarFailures = run.avatars.settled.filter(
      (entry) => entry.status !== "hit",
    );
    console.log(
      `  avatars (${run.avatars.settled.length - avatarFailures.length}/${run.avatars.settled.length}): ` +
        (avatarFailures
          .map((entry) => `${entry.id} [${entry.reason}]`)
          .join(", ") || "all hit"),
    );
  }
  if (run.untouched) {
    const untouchedFailures = run.untouched.filter(
      (entry) => entry.status !== "hit",
    );
    console.log(
      `  untouched (${run.untouched.length - untouchedFailures.length}/${run.untouched.length}): ` +
        (untouchedFailures
          .map((entry) => `${entry.id} [${entry.reason ?? entry.status}]`)
          .join(", ") || "all hit"),
    );
  }
  for (const error of run.fixtureErrors)
    console.log(`  fixture failure: ${error}`);
}

const options = parseArgs(process.argv.slice(2));
let stack = null;
let fatal = false;
try {
  const guards = sourceGuards();
  console.log("SOURCE GUARDS (never browser hits)");
  for (const item of guards)
    console.log(`  ${item.pass ? "pass" : "FAIL"} ${item.id}: ${item.file}`);
  if (guards.some((item) => !item.pass)) fatal = true;

  stack = await createBrowserStack({
    root: ROOT,
    prefix: "user-baseline-",
    webReadyPath: FIXTURE_URL,
    keep: options.keep
      ? { remove: ["db", "attachments", "chrome", "config.toml"] }
      : false,
  });
  const dir = stack.dir;
  const seeded = await seed(stack.serverPort);
  const browser = await startBrowser({
    dir,
    chromium: stack.chromium,
    registerChild: stack.registerChild,
  });
  stack.addCleanup(() => browser.close());
  const base = stack.webUrl;
  const browserVersion = await browser.send("Browser.getVersion");
  console.log(
    `ENV source=${stack.versions.source} chromium=${browserVersion.product} userAgent=${browserVersion.userAgent} ` +
      `dpr=1 font="Geist Variable" epsilon=${EPSILON}`,
  );
  const cleanRuns = [];
  for (const viewport of VIEWPORTS) {
    const run = await browserRun(browser, base, seeded, viewport);
    const revision = await revisionRun(browser, base, seeded, viewport);
    run.rows.push(...revision.rows);
    run.fixtureErrors.push(...revision.fixtureErrors);
    if (viewport.width === 390 || viewport.width === 1280) {
      for (const route of ROUTE_CASES) {
        const actual = await specRouteRun(
          browser,
          base,
          seeded,
          viewport,
          route.id,
        );
        run.rows.push(...actual.rows);
        run.fixtureErrors.push(...actual.fixtureErrors);
      }
    }
    if (viewport.width === 390 || viewport.width === 1280) {
      const untouched = await untouchedRun(browser, base, seeded, viewport);
      run.untouched = untouched.rows;
      run.fixtureErrors.push(...untouched.errors);
    }
    cleanRuns.push(run);
    printRun(run);
    if (
      run.fixtureErrors.length ||
      run.rows.some((row) => row.status !== "hit") ||
      run.avatars.settled.some((row) => row.status !== "hit") ||
      run.untouched?.some((row) => row.status !== "hit")
    )
      fatal = true;
  }

  if (options.selfTest) {
    const viewport = VIEWPORTS.at(-1);
    const selfTestCases = options.selfTestCase
      ? CASES.filter((entry) => entry.id === options.selfTestCase)
      : CASES;
    const historicalCases = ["T-359", "T-416"].filter(
      (id) => !options.selfTestCase || options.selfTestCase === id,
    );
    if (selfTestCases.length === 0 && historicalCases.length === 0) {
      throw new Error(`unknown self-test case: ${options.selfTestCase}`);
    }
    console.log(
      `\nSELF-TEST: ${selfTestCases.length} old-style mutation(s), each followed by a clean page`,
    );
    for (const entry of selfTestCases) {
      const execute = (fault) =>
        ROUTE_CASES.includes(entry)
          ? specRouteRun(browser, base, seeded, viewport, entry.id, fault)
          : REVISION_CASES.includes(entry)
            ? revisionRun(browser, base, seeded, viewport, fault)
            : browserRun(browser, base, seeded, viewport, fault);
      const run = await execute(entry.id);
      const target = run.rows.find((row) => row.id === entry.id);
      const unexpected = run.rows.filter(
        (row) => row.id !== entry.id && row.status !== "hit",
      );
      const restored = await execute(null);
      const restoredTarget = restored.rows.find((row) => row.id === entry.id);
      const detected =
        target?.status === "failure" &&
        target.mutation !== null &&
        unexpected.length === 0 &&
        !run.fixtureErrors.length &&
        restoredTarget?.status === "hit" &&
        !restored.fixtureErrors.length;
      console.log(
        `  ${entry.id}: ${detected ? "RED → restored GREEN" : "NOT PROVEN"} ` +
          `(fault ${target?.spread ?? target?.status ?? "missing"}px ${target?.reason ?? ""}, ` +
          `restore ${restoredTarget?.spread ?? restoredTarget?.status ?? "missing"}px, ` +
          `unexpected ${unexpected.map((row) => `${row.id}:${row.status}`).join(",") || "none"})`,
      );
      if (!detected) fatal = true;
    }
    for (const kind of historicalCases) {
      const fault = await historicalFaultRun(
        browser,
        base,
        seeded,
        kind,
        "fault",
      );
      const restored = await historicalFaultRun(
        browser,
        base,
        seeded,
        kind,
        "clean",
      );
      const verdict =
        kind === "T-359"
          ? assessT359FreshPageRestore(fault, restored)
          : assessT416FreshPageRestore(fault, restored);
      console.log(
        `  ${kind}: ${verdict.status === "pass" ? "RED → restored GREEN" : "NOT PROVEN"} ` +
          `(fault=${fault.status}, clean=${restored.status}, samples=${fault.samples?.length ?? 0}, ` +
          `reasons=${verdict.reasons.join("; ") || "none"})`,
      );
      if (verdict.status !== "pass") fatal = true;
    }
  }
} catch (error) {
  fatal = true;
  console.error(`user-baseline-smoke: ${error.stack ?? error}`);
} finally {
  try {
    await stack?.cleanup();
  } catch (error) {
    fatal = true;
    console.error(`user-baseline-smoke cleanup: ${error.stack ?? error}`);
  }
}
process.exitCode = fatal ? 1 : 0;
