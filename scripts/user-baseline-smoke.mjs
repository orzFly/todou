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
  assessSplitHeaders,
  probeHeaderCopy,
  probeSplitHeader,
  probeSplitHeaderCount,
} from "./split-header-probe.mjs";
import {
  assessT359FreshPageRestore,
  assessT416FreshPageRestore,
  probeT359AvatarFault,
  probeT416BadgeClippingFault,
} from "./user-baseline-faults.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_URL = "/test/browser/user-baseline.html";
const EPSILON = 0.125;
const round2 = (value) => Math.round(value * 100) / 100;
const VIEWPORTS = [
  { name: "390-mobile", width: 390, height: 844 },
  { name: "639-mobile-boundary", width: 639, height: 844 },
  { name: "640-desktop-boundary", width: 640, height: 800 },
  { name: "768-tablet", width: 768, height: 800 },
  { name: "1280-desktop", width: 1280, height: 800 },
];

/**
 * T-445's own widths. A separate list rather than five more entries in
 * `VIEWPORTS`: that one drives every T-433 and T-435 family too, and the
 * widths below were chosen for where a comment header wraps, not for where a
 * baseline is measurable. 639/640 straddle the breakpoint and 1280 is the
 * desktop the card promises not to touch.
 */
const SPLIT_VIEWPORTS = [320, 360, 390, 430, 520, 600, 620, 639, 640, 1280].map(
  (width) => ({
    name: `${width}-split`,
    width,
    height: width < 640 ? 844 : 800,
  }),
);

/**
 * Where the seven entry points are drawn. The fixture opens both previews
 * and the annotation bubble through their real triggers, so one load reaches
 * five of them; each spec shape needs its own URL, because which renderer
 * draws an annotation is decided by the address and not by the markup (the
 * same reason `ROUTE_URLS` has two source entries).
 */
const SPLIT_SURFACES = [
  { id: "timeline", fixture: true },
  {
    id: "spec-rendered",
    search: "?file=plan.md&v=2&compare=1&view=rendered",
  },
  { id: "spec-source", search: "?file=plan.md&v=2&compare=1&view=source" },
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

/**
 * `author` and `peer` are T-433's original pair and stay exactly what they
 * were — for a comment header `peer` is still the timestamp link, so that
 * sample survives T-435 unchanged. `badge`, `id` and `time` are the text
 * T-435 put on the same baseline; each role marks the visible text node,
 * never the box around it.
 */
const DEFAULT_ROLES = ["author", "peer"];

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
    /flex flex-wrap items-baseline gap-2 border-b/,
    ["author", "peer", "id"],
  ),
  guard(
    "comment-item-agent-session",
    "author",
    "projects/web/src/components/timeline/comment-item.tsx",
    /items-baseline \[&>svg\]:self-center/,
    ["author", "badge", "peer", "id"],
  ),
  guard(
    "comment-item-agent-plain",
    "author",
    "projects/web/src/components/timeline/comment-item.tsx",
    /items-baseline \[&>svg\]:self-center/,
    ["author", "badge", "peer", "id"],
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
    /mb-2 flex flex-wrap items-baseline gap-2/,
    ["author", "peer", "id"],
  ),
  guard(
    "spec-annotation-hover-card",
    "author",
    "projects/web/src/components/shared/spec-annotation-hover-card.tsx",
    /mb-2 flex flex-wrap items-baseline gap-2/,
    ["author", "peer", "id"],
  ),
  guard(
    "unplaced-comment",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function UnplacedComment[\s\S]*?mb-1 flex flex-wrap items-baseline gap-2/,
    ["author", "peer", "id", "time"],
  ),
  guard(
    "diff-annotation",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function DiffAnnotation[\s\S]*?mb-1 flex flex-wrap items-baseline gap-2/,
    ["author", "peer", "id", "time"],
  ),
  guard(
    "spec-source-file",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function SpecSourceFile[\s\S]*?<SpecFileSource\n\s+slug=\{slug\}/,
    ["author", "peer", "id", "time"],
  ),
  guard(
    "spec-unfolded-file",
    "author",
    "projects/web/src/pages/spec-view.tsx",
    /function SpecUnfoldableFile[\s\S]*?<SpecFileSource\n\s+slug=\{slug\}/,
    ["author", "peer", "id", "time"],
  ),
  guard(
    "annotation-chip",
    "author",
    "projects/web/src/components/spec/annotated-markdown.tsx",
    /item\.item\.author[\s\S]*?items-baseline|items-baseline[\s\S]*?item\.item\.author/,
    ["author", "peer", "id", "time"],
  ),
];

/**
 * Read but never measured: these files have no row of their own, so drift in
 * them shows up as a source guard and nothing else. A guard is not a hit.
 */
const SOURCE_ONLY_GUARDS = [
  {
    id: "comment-header-meta",
    file: "projects/web/src/components/shared/comment-header-meta.tsx",
    pattern: /flex flex-wrap items-baseline justify-end gap-x-2/,
  },
  {
    id: "comment-header-meta-token",
    file: "projects/web/src/components/shared/comment-header-meta.tsx",
    pattern:
      /<span className="select-all">\{`#\$\{commentAnchor\(commentId\)\}`\}<\/span>/,
  },
  {
    id: "optimistic-split",
    file: "projects/web/src/pages/issue-detail.tsx",
    pattern:
      /pendingComments=\{composer\.pending\.filter\(\(p\) => !p\.failed\)\}/,
  },
];

/**
 * One fault per rule the implementation may lose, so a failure names which.
 * `row` is T-433's own mutation and every case carries it; the other two
 * restore exactly one of the rules T-435 changed, and each must leave the
 * roles it does not move inside the threshold — "something went red" is not
 * evidence that this rule is what holds the row together.
 */
const FAULTS = [
  ...CASES.map((entry) => ({
    id: entry.id,
    kind: "row",
    expectFail: entry.roles.slice(1),
    expectHold: [],
  })),
  {
    id: "comment-item-agent-session",
    kind: "badge",
    expectFail: ["badge"],
    expectHold: ["peer", "id"],
  },
  {
    id: "comment-item-agent-plain",
    kind: "badge",
    expectFail: ["badge"],
    expectHold: ["peer", "id"],
  },
  {
    id: "comment-item-agent-session",
    kind: "meta",
    // `peer` is the timestamp, which lives in the same group as the id.
    expectFail: ["id", "peer"],
    expectHold: ["badge"],
  },
];

/**
 * Which URL each route case is reached at, and what draws it there. The two
 * source-file entries exist because `MultiFileDiff` and `File` are different
 * pierre components: a comment header proven through the diff says nothing
 * about the one the source view renders.
 */
const ROUTE_URLS = {
  "unplaced-comment": { search: "?file=plan.md&v=2&compare=1&view=rendered" },
  "diff-annotation": { search: "?file=plan.md&v=2&compare=1&view=source" },
  // No baseline to compare against at v1, so the page reads one version
  // whole — and the presentation is session state, which is why this one
  // arrives through the toggle rather than through the URL (T-200).
  "spec-source-file": { search: "?file=plan.md&v=1", toggleToSource: true },
  "spec-unfolded-file": {
    search: "?file=steady.md&v=2&compare=1&view=source",
  },
};

const ROUTE_CASES = CASES.filter((entry) =>
  Object.hasOwn(ROUTE_URLS, entry.id),
);
const REVISION_CASES = CASES.filter((entry) => entry.id === "revision-history");
const FIXTURE_CASES = CASES.filter(
  (entry) => !ROUTE_CASES.includes(entry) && !REVISION_CASES.includes(entry),
);

function guard(id, family, file, pattern, roles = DEFAULT_ROLES) {
  return { id, family, file, pattern, roles };
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
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...headers,
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
  // The badge's two shapes, written the way the CLI writes them: the header
  // is opt-in provenance on an ordinary authenticated POST, so these are
  // real agent-context comments rather than a DTO edited in the fixture.
  // With a session id the badge is a button, without one a span, and T-435
  // needs the visible model text of both on the header's baseline.
  await call(
    "POST",
    `/projects/${slug}/issues/${issue.number}/comments`,
    { body: "A real agent comment whose badge carries a session." },
    {
      "x-todou-agent-context": JSON.stringify({
        agent: "claude-code",
        model: "claude-opus-5",
        session_id: "0d6b1f52-baseline-smoke",
      }),
    },
  );
  await call(
    "POST",
    `/projects/${slug}/issues/${issue.number}/comments`,
    { body: "A real agent comment whose badge carries no session." },
    {
      "x-todou-agent-context": JSON.stringify({
        agent: "codex",
        model: "gpt-6-astra",
      }),
    },
  );
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
  // A second file both versions leave byte-for-byte alone: that is what the
  // stack draws as an unfoldable block, and the only way to reach
  // SpecFileSource through the compare view rather than through the diff.
  const steadySpec = ["# Steady", "", "A line nobody edits."].join("\n");
  await call("POST", `${specPath}/push`, {
    message: "Baseline fixture version one",
    files: [
      { path: "plan.md", body: firstSpec },
      { path: "steady.md", body: steadySpec },
    ],
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
      {
        anchor: { path: "steady.md", version: 1, line_start: 3, line_end: 3 },
        body: "Untouched file review",
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
      { path: "steady.md", body: steadySpec },
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
 *
 * Every marked role is measured against `author`, which is why a case that
 * gets its badge right and its id wrong still fails: one spread per role,
 * never one number for the row. Roles that wrapped onto another visual line
 * are reported as such rather than compared — and never as a pass, because
 * "it went to the next line" is how a real misalignment hides.
 */
async function measure(page, fault = null, cases = CASES) {
  return await evaluate(
    page,
    (specs, epsilon, faultSpec) => {
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
      const textLeaf = (element, role) => {
        const name =
          role === "author"
            ? [...element.querySelectorAll("span")].find((span) =>
                span.classList.contains("ml-1.5"),
              )
            : null;
        // The author participant must be UserChip's visible name. Falling
        // back to the whole chip can silently measure avatar initials.
        if (role === "author" && !name) return null;
        const host = name ?? element;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent.trim()) node = walker.nextNode();
        return node;
      };
      for (const spec of specs) {
        const { id, roles } = spec;
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
        const participants = roles.map((role) => {
          const selector = `[data-baseline-participant="${role}"]`;
          return root.matches(selector) ? root : root.querySelector(selector);
        });
        const unmarked = roles.filter((_role, index) => !participants[index]);
        if (unmarked.length > 0) {
          rows.push({
            id,
            status: "missing",
            reason: `unmarked participant(s): ${unmarked.join(", ")}`,
          });
          continue;
        }
        const roleOf = (role) => participants[roles.indexOf(role)];

        // What the fault moves, and what "moved" means for it. `row` is
        // T-433's own mutation; the other two restore exactly one of the
        // rules T-435 changed, so a failure names which.
        const kind = faultSpec && faultSpec.id === id ? faultSpec.kind : null;
        let mutationRoot = root;
        let property = "alignItems";
        if (kind === "row" && id === "assignee-row") {
          mutationRoot =
            root.querySelector("[data-baseline-fault-target]") ?? root;
        } else if (kind === "badge") {
          const badge = roleOf("badge");
          mutationRoot =
            badge?.closest('[data-testid="agent-context-badge"]') ?? badge;
          property = "alignSelf";
        } else if (kind === "meta") {
          const idPart = roleOf("id");
          mutationRoot =
            idPart?.closest('[data-testid="comment-header-meta"]') ?? idPart;
          if (!mutationRoot?.matches('[data-testid="comment-header-meta"]')) {
            rows.push({
              id,
              status: "invalid",
              reason: "no comment-header-meta group to move",
            });
            continue;
          }
          property = "alignSelf";
        }
        if (kind && !mutationRoot) {
          rows.push({
            id,
            status: "invalid",
            reason: `fault ${kind} has nothing to move`,
          });
          continue;
        }
        const beforeStyle = getComputedStyle(mutationRoot);
        const before = {
          alignItems: beforeStyle.alignItems,
          alignSelf: beforeStyle.alignSelf,
          display: beforeStyle.display,
          verticalAlign: beforeStyle.verticalAlign,
        };
        let mutation = null;
        if (kind) {
          mutationRoot.style[property] = "center";
          mutation =
            kind === "row"
              ? "text flex row restored to items-center"
              : kind === "badge"
                ? "agent badge restored to T-433's self-center"
                : "id/time group set to self-center";
          if (kind === "badge") {
            // Both halves, or the restore is not the old rule: the pill and
            // the row are the same height here, so moving the box alone
            // leaves the text exactly where it was and the fault proves
            // nothing. What T-435 changed is where the text sits inside the
            // pill, and that is `align-items` on the badge.
            mutationRoot.style.alignItems = "center";
            for (const icon of mutationRoot.querySelectorAll(":scope > svg")) {
              icon.style.alignSelf = "auto";
            }
          }
          if (kind === "row" && id === "assignee-row") {
            mutationRoot.style.verticalAlign = "middle";
            mutation = "assignee alignment restored to center/middle";
          }
          if (
            kind === "row" &&
            ["unplaced-comment", "annotation-chip"].includes(id)
          ) {
            root.style.whiteSpace = "nowrap";
            root.style.width = "max-content";
            root.style.zoom = "2";
            mutation += " at 200% zoom without wrapping";
          }
          const after = getComputedStyle(mutationRoot);
          if (
            id === "diff-annotation" &&
            after.display === "" &&
            mutationRoot.style[property] === "center"
          ) {
            // Pierre may detach and replace a shadow-root annotation while
            // its diff is painting. The inline style took effect on the
            // selected node, but an uncomputed node gives no layout verdict.
            rows.push({
              id,
              status: "invalid",
              reason: "diff annotation detached during old-style mutation",
            });
            continue;
          }
          if (
            after[property] !== "center" ||
            (kind === "row" &&
              id === "assignee-row" &&
              after.verticalAlign !== "middle") ||
            (before[property] === after[property] &&
              (kind !== "row" ||
                id !== "assignee-row" ||
                before.verticalAlign === after.verticalAlign))
          ) {
            rows.push({
              id,
              status: "invalid",
              reason: `fault did not take effect: ${mutation} (${before.display}/${before[property]} → ${after.display}/${after[property]})`,
            });
            continue;
          }
        }

        const rowBox = rect(root.getBoundingClientRect());
        const baselines = [];
        const styles = [];
        let invalid = null;
        let perturbed = false;
        for (const [index, element] of participants.entries()) {
          const node = textLeaf(element, roles[index]);
          if (!node) {
            invalid =
              roles[index] === "author"
                ? "author UserChip visible name span (.ml-1.5) is missing"
                : `${roles[index]} participant lacks text`;
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
            invalid = `baseline marker changed geometry for ${roles[index]} (row ${JSON.stringify(rowBeforeMarker)} → ${JSON.stringify(rowAfter)}, participant ${JSON.stringify(participantBefore)} → ${JSON.stringify(participantAfter)}, text rects ${textBefore.length} → ${textAfter.length})`;
            perturbed = true;
            break;
          }
          const css = getComputedStyle(element);
          styles.push({
            role: roles[index],
            font: css.font,
            lineHeight: css.lineHeight,
            display: css.display,
            verticalAlign: css.verticalAlign,
          });
          baselines.push(y);
        }
        if (invalid) {
          rows.push({
            // The zero-size marker is an atomic inline box, so inserting it
            // takes away a line-break opportunity. On a row that is already
            // wrapping that can move the break, and the number would then
            // describe a layout the reader never sees. Below 640 the header
            // is allowed to wrap, so this is recorded rather than called a
            // pass or a failure; at desktop widths it stays fatal.
            status: perturbed ? "unmeasurable" : "invalid",
            id,
            count: 0,
            mutation,
            reason: invalid,
          });
          continue;
        }
        const lineHeight = Math.max(
          ...styles.map((style) => Number.parseFloat(style.lineHeight) || 20),
        );
        const pairs = roles.slice(1).map((role, index) => {
          const spread = Math.abs(baselines[0] - baselines[index + 1]);
          return {
            role,
            spread: Number(spread.toFixed(5)),
            sameLine: spread <= lineHeight * 0.75,
          };
        });
        const compared = pairs.filter((pair) => pair.sameLine);
        const wrapped = pairs.filter((pair) => !pair.sameLine);
        const failed = compared.filter((pair) => pair.spread > epsilon);
        const status =
          compared.length === 0
            ? // Nothing left on the author's line. Below `sm` that is what a
              // comment header is now *for*: T-445 gives the id and the time
              // a line of their own there, and where they sit on it is graded
              // by that card's own criteria further down. Recorded rather
              // than called a pass — and the main loop still treats it as
              // fatal at 640 and above, where no header may wrap at all.
              "unmeasurable"
            : failed.length > 0
              ? "failure"
              : "hit";
        rows.push({
          id,
          status,
          count: 1,
          roles,
          baselines: baselines.map((value) => Number(value.toFixed(5))),
          pairs,
          wrapped: wrapped.map((pair) => pair.role),
          spread: compared.length
            ? Number(
                Math.max(...compared.map((pair) => pair.spread)).toFixed(5),
              )
            : null,
          row: {
            ...rowBox,
            display: before.display,
            alignItems: before.alignItems,
          },
          styles,
          mutation,
          reason:
            compared.length === 0
              ? `every participant wrapped away from author (${wrapped.map((p) => `${p.role} ${p.spread}`).join(", ")})`
              : failed.length > 0
                ? failed
                    .map(
                      (pair) =>
                        `${pair.role} minus author ${pair.spread.toFixed(5)} CSS px exceeds ${epsilon}`,
                    )
                    .join("; ")
                : null,
        });
      }
      return rows;
    },
    cases.map((entry) => ({ id: entry.id, roles: entry.roles })),
    EPSILON,
    fault,
  );
}

function sourceGuards() {
  return [...CASES, ...SOURCE_ONLY_GUARDS].map((entry) => {
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
  const route = ROUTE_URLS[kind];
  const url = `${base}/projects/${seeded.slug}/issues/${seeded.number}/spec${route.search}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    await page.cdp.send("Page.navigate", { url }, page.sessionId);
    const deadline = Date.now() + 25_000;
    let state = null;
    while (Date.now() < deadline) {
      state = await evaluate(
        page,
        async ([caseId, toggleToSource, faultKind]) => {
          if (toggleToSource) {
            // The page's own control, not a rewritten URL: reading one
            // version's source is session state with no address to link to.
            const toggle = [
              ...document.querySelectorAll(
                'fieldset[aria-label="comparison view"] button',
              ),
            ].find((button) => button.textContent.trim() === "source");
            if (toggle && toggle.getAttribute("aria-pressed") !== "true") {
              toggle.click();
              return { ready: false, text: "switching to the source view" };
            }
          }
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
            if (caseId === "unplaced-comment") {
              return !!row.closest(".space-y-2.rounded-lg.border.px-4.py-3");
            }
            // Every other route case is a DiffAnnotation; which renderer put
            // it there is decided by the URL, not by the markup.
            return !!row.closest(".border-y.bg-background.px-3.py-2");
          });
          if (!candidate) {
            return {
              ready: false,
              text: document.body?.innerText.slice(0, 500) ?? "",
            };
          }
          const author = candidate.querySelector('a[href^="/users/"]');
          // Through the author's own parent, not the row's children: T-445
          // wraps the identity of every comment header in a group, so the
          // row's first child is now that group and reading its text would
          // measure the group's baseline instead of the anchor's.
          const identity = author?.parentElement ?? candidate;
          const peer = [...identity.children].find(
            (element) =>
              element !== author && element.textContent.includes("v1"),
          );
          // The header meta's two links, told apart the way a reader does:
          // the id is the short suffix, the stamp is the `<time>`. Picking
          // "the first anchor to #comment-N" would land on whichever of the
          // two the markup happens to put first.
          const metaLinks = [
            ...candidate.querySelectorAll('a[href*="#comment-"]'),
          ];
          const idPart = metaLinks.find((link) => !link.querySelector("time"));
          const timePart = metaLinks.find((link) => link.querySelector("time"));
          if (!author || !peer || !idPart || !timePart)
            return { ready: false, text: candidate.outerHTML.slice(0, 600) };
          await document.fonts.ready;
          if (!document.fonts.check('12px "Geist Variable"')) {
            return { ready: true, error: "Geist Variable did not load" };
          }
          candidate.dataset.baselineCase = caseId;
          author.dataset.baselineParticipant = "author";
          peer.dataset.baselineParticipant = "peer";
          idPart.dataset.baselineParticipant = "id";
          timePart.dataset.baselineParticipant = "time";
          if (faultKind === "nowrap") {
            // The shape before the repair is both wraps gone. With only the
            // row pinned, the id/time group still wraps internally and the
            // row fits — the repair holding at its second level, which would
            // make a row-only fault prove nothing.
            candidate.style.flexWrap = "nowrap";
            for (const group of candidate.querySelectorAll(
              '[data-testid="comment-header-meta"]',
            )) {
              group.style.flexWrap = "nowrap";
            }
          }
          // Where the header actually ran out of room. A row that will not
          // wrap does not simply stick out: its children are squeezed and
          // their text stacks a character per line, which is the shape the
          // 390px spec containers showed. So all three are read — past the
          // row, past whatever clips it, and taller than one line of its own
          // text — because only one of them moves in any given case.
          const rowBox = candidate.getBoundingClientRect();
          let clipper = candidate.parentElement;
          while (clipper) {
            const overflow = getComputedStyle(clipper).overflowX;
            if (["hidden", "clip", "auto", "scroll"].includes(overflow)) break;
            clipper = clipper.parentElement;
          }
          const clipBox = (
            clipper ?? document.documentElement
          ).getBoundingClientRect();
          const parts = [
            author,
            peer,
            idPart,
            timePart,
            ...candidate.querySelectorAll("button"),
          ];
          const strained = parts
            .map((part) => {
              const box = part.getBoundingClientRect();
              const line =
                Number.parseFloat(getComputedStyle(part).lineHeight) || 16;
              return {
                text: (part.textContent ?? "").trim().slice(0, 24),
                overRow: Number((box.right - rowBox.right).toFixed(3)),
                overClip: Number((box.right - clipBox.right).toFixed(3)),
                lines: Number((box.height / line).toFixed(2)),
              };
            })
            .filter(
              (part) =>
                part.overRow > 0.5 || part.overClip > 0.5 || part.lines > 2.5,
            );
          return {
            ready: true,
            overflow: {
              scrolls: candidate.scrollWidth > candidate.clientWidth + 1,
              clipper: clipper ? clipper.className.slice(0, 40) : "viewport",
              clipped: strained,
              wrap: getComputedStyle(candidate).flexWrap,
            },
          };
        },
        [kind, route.toggleToSource === true, fault?.kind ?? null],
      );
      if (state?.ready) break;
      await sleep(150);
    }
    const errors = [];
    if (!state?.ready)
      errors.push(`${kind} route sample timed out: ${state?.text ?? ""}`);
    if (state?.error) errors.push(state.error);
    if (options.keep && !fault && state?.ready) {
      const shot = await page.cdp.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true },
        page.sessionId,
      );
      writeFileSync(
        join(dir, `route-${kind}-${viewport.name}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
    return {
      viewport: viewport.name,
      fault,
      overflow: state?.overflow ?? null,
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

/**
 * What a reader's own drag across the short id puts on the clipboard (T-427's
 * rule, applied to the header T-435 added). Real mouse events and a real
 * Ctrl+C: a `Selection` built from script would prove that the DOM can be
 * selected, not that dragging over it selects the right thing.
 *
 * The drag starts and ends outside the token, so it crosses the whole of it
 * from both sides — starting inside a link is a native drag-and-drop in some
 * browsers, and that boundary is recorded rather than worked around.
 */
async function selectionRun(browser, base, seeded, viewport, fault = null) {
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    await browser.send("Browser.grantPermissions", {
      origin: base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const fixtureErrors = await load(page, url);
    const box = await evaluate(
      page,
      (faultKind) => {
        const row = document.querySelector(
          "#fixture-comment-item .border-b.bg-muted\\/40",
        );
        const token = row?.querySelector(
          '[data-testid="comment-header-meta"] .select-all',
        );
        if (!row || !token)
          return { error: "no id token in the comment header" };
        const stamp = row.querySelector(
          '[data-testid="comment-header-meta"] time',
        );
        if (faultKind === "time-in-token") {
          if (!stamp) return { error: "no timestamp to move into the token" };
          token.append(stamp);
        } else if (faultKind === "unselectable") {
          token.style.userSelect = "none";
          token.style.webkitUserSelect = "none";
        }
        row.scrollIntoView({ block: "center" });
        const style = getComputedStyle(token);
        const rect = token.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
          return { error: "id token has no box" };
        // A textarea is measurement apparatus, not product markup: the paste
        // has to land somewhere a read can see it.
        let sink = document.querySelector("#baseline-clipboard-sink");
        if (!sink) {
          sink = document.createElement("textarea");
          sink.id = "baseline-clipboard-sink";
          sink.style.cssText =
            "position:fixed;left:0;bottom:0;width:200px;height:40px;z-index:9999";
          document.body.append(sink);
        }
        sink.value = "";
        const sinkRect = sink.getBoundingClientRect();
        return {
          token: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          userSelect: style.userSelect || style.webkitUserSelect,
          text: token.textContent,
          sink: { x: sinkRect.x + 20, y: sinkRect.y + 10 },
        };
      },
      fault,
    );
    if (box.error) {
      return {
        viewport: viewport.name,
        fault,
        fixtureErrors,
        error: box.error,
      };
    }
    const mouse = async (type, x, y, extra = {}) =>
      await page.cdp.send(
        "Input.dispatchMouseEvent",
        { type, x, y, button: "left", clickCount: 1, buttons: 1, ...extra },
        page.sessionId,
      );
    const midY = box.token.y + box.token.height / 2;
    const from = box.token.x - 6;
    const to = box.token.x + box.token.width + 6;
    await mouse("mousePressed", from, midY);
    for (let step = 1; step <= 6; step++) {
      await mouse("mouseMoved", from + ((to - from) * step) / 6, midY);
    }
    await mouse("mouseReleased", to, midY);
    const selected = await evaluate(page, () =>
      (document.getSelection()?.toString() ?? "").trim(),
    );
    const key = async (type, extra) =>
      await page.cdp.send(
        "Input.dispatchKeyEvent",
        { type, modifiers: 2, ...extra },
        page.sessionId,
      );
    await key("rawKeyDown", {
      key: "c",
      code: "KeyC",
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
    });
    await key("keyUp", {
      key: "c",
      code: "KeyC",
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
    });
    await sleep(120);
    const pasted = await evaluate(
      page,
      async (point) => {
        const sink = document.querySelector("#baseline-clipboard-sink");
        if (!sink) return { error: "clipboard sink vanished" };
        sink.focus();
        try {
          const text = await navigator.clipboard.readText();
          sink.value = text;
          return { value: sink.value, via: "clipboard.readText after Ctrl+C" };
        } catch (error) {
          return { error: String(error), point };
        }
      },
      box.sink,
    );
    return {
      viewport: viewport.name,
      fault,
      fixtureErrors,
      selected,
      pasted,
      userSelect: box.userSelect,
      tokenText: box.text,
    };
  } finally {
    await page.close();
  }
}

/**
 * The reverse side of the card's scope: what the header still has to carry at
 * each width, and what must not happen to the page around it. The id and the
 * time moving in is not a licence to drop an action or let the page scroll
 * sideways, so both are read back rather than assumed.
 */
async function scopeRun(
  browser,
  base,
  seeded,
  viewport,
  fault = null,
  scheme = "light",
) {
  const url = `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}`;
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    const fixtureErrors = await load(page, url);
    const rows = await evaluate(
      page,
      ([faultKind, colorScheme]) => {
        // The `.dark` class is how `lib/theme.ts` itself switches palettes,
        // so this is the product's own switch rather than a second one.
        document.documentElement.classList.toggle(
          "dark",
          colorScheme === "dark",
        );
        const out = [];
        const visible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        };
        // What each sample's reader may do, by the role it is rendered for.
        // Counting controls alone would let an edit button appear for a
        // reader who may not edit and still read as "actions present".
        const expected = {
          "comment-item": ["comment actions"],
          "comment-item-author": ["comment actions", "edit comment"],
          "comment-item-agent-session": ["comment actions"],
          "comment-item-agent-plain": ["comment actions"],
        };
        for (const id of Object.keys(expected)) {
          const row = document
            .querySelector(`#fixture-${id}`)
            ?.querySelector(".border-b.bg-muted\\/40");
          if (!row) {
            out.push({ id, status: "missing", reason: "no comment header" });
            continue;
          }
          if (faultKind === "hide-desktop-actions") {
            for (const action of row.querySelectorAll(
              "[aria-label='comment actions'], [aria-label='edit comment']",
            )) {
              action.style.display = "none";
            }
          } else if (faultKind === "unshrinkable-header") {
            // Both halves: with the row wrapping, unshrinkable children move
            // to the next line rather than overflowing, so a fault that only
            // pins `flex-shrink` proves nothing about the repair.
            row.style.flexWrap = "nowrap";
            for (const child of row.children) {
              child.style.flexShrink = "0";
              child.style.whiteSpace = "nowrap";
              child.style.minWidth = "max-content";
            }
          }
          const meta = row.querySelector('[data-testid="comment-header-meta"]');
          const token = meta?.querySelector(".select-all");
          const stamp = meta?.querySelector("time");
          const actions = [
            ...row.querySelectorAll("[aria-label='comment actions']"),
            ...row.querySelectorAll("[aria-label='edit comment']"),
          ];
          const rowBox = row.getBoundingClientRect();
          out.push({
            id,
            idVisible: visible(token),
            idText: token?.textContent ?? null,
            timeVisible: visible(stamp),
            actions: actions.filter(visible).length,
            actionLabels: actions
              .filter(visible)
              .map((element) => element.getAttribute("aria-label"))
              .sort(),
            expectedActions: [...expected[id]].sort(),
            // "the id and the time in the same muted colour" is a claim about
            // rendered colour, so it is read back rather than inferred from a
            // shared class name.
            idColor: token ? getComputedStyle(token).color : null,
            timeColor: stamp ? getComputedStyle(stamp).color : null,
            // Nothing pushed past the right edge of its own header.
            withinRow: [token, stamp, ...actions].every((element) => {
              if (!element) return false;
              const box = element.getBoundingClientRect();
              return box.right <= rowBox.right + 0.5 && box.width > 0;
            }),
            rowScrolls: row.scrollWidth > row.clientWidth + 1,
          });
        }
        return {
          rows: out,
          scheme: colorScheme,
          background: getComputedStyle(document.body).backgroundColor,
          documentOverflows:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 1,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      },
      [fault, scheme],
    );
    return { viewport: viewport.name, fault, fixtureErrors, ...rows };
  } finally {
    await page.close();
  }
}

function splitUrl(base, seeded, surface) {
  return surface.fixture
    ? `${base}${FIXTURE_URL}?slug=${encodeURIComponent(seeded.slug)}&number=${seeded.number}`
    : `${base}/projects/${seeded.slug}/issues/${seeded.number}/spec${surface.search}`;
}

/**
 * One surface at one width, measured by `probeSplitHeader`. The spec routes
 * are polled rather than awaited on a ready signal: they are the production
 * page, which has no fixture handshake, and an annotation arrives with its
 * version's files.
 */
async function splitHeaderRun(
  browser,
  base,
  seeded,
  viewport,
  surface,
  options = {},
) {
  const url = splitUrl(base, seeded, surface);
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    let fixtureErrors = [];
    if (surface.fixture) {
      fixtureErrors = await load(page, url);
    } else {
      await page.cdp.send("Page.navigate", { url }, page.sessionId);
    }
    const deadline = Date.now() + 25_000;
    let measured = { status: "error", reason: "never rendered a header" };
    while (Date.now() < deadline) {
      if ((await evaluate(page, probeSplitHeaderCount)) === 0) {
        await sleep(250);
        continue;
      }
      measured = await evaluate(page, probeSplitHeader, options);
      if (measured.status === "ok") break;
      await sleep(250);
    }
    return {
      surface: surface.id,
      viewport: viewport.name,
      fixtureErrors,
      ...measured,
    };
  } finally {
    await page.close();
  }
}

/**
 * Criterion 6. A `Range` over the whole header, a real Ctrl+C, and a paste
 * read back from a textarea outside the app — and the comparison is against
 * the same page with the new classes stripped, taken in this same run,
 * because the timestamp inside the payload differs between runs.
 */
async function splitCopyRun(browser, base, seeded, viewport, strip) {
  const url = splitUrl(base, seeded, SPLIT_SURFACES[0]);
  const page = await pageFor(browser, viewport, seeded.cookie, url);
  try {
    await browser.send("Browser.grantPermissions", {
      origin: base,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const fixtureErrors = await load(page, url);
    const selection = await evaluate(page, probeHeaderCopy, { strip });
    if (selection.error) return { fixtureErrors, error: selection.error };
    const key = async (type) =>
      await page.cdp.send(
        "Input.dispatchKeyEvent",
        {
          type,
          modifiers: 2,
          key: "c",
          code: "KeyC",
          windowsVirtualKeyCode: 67,
          nativeVirtualKeyCode: 67,
        },
        page.sessionId,
      );
    await key("rawKeyDown");
    await key("keyUp");
    await sleep(120);
    const pasted = await evaluate(page, probeHeaderCopy, { mode: "read" });
    return { fixtureErrors, selected: selection.selected, pasted };
  } finally {
    await page.close();
  }
}

function printRun(run) {
  const label = run.fault
    ? `FAULT ${run.fault.id}/${run.fault.kind}`
    : `CLEAN ${run.viewport}`;
  const hits = run.rows.filter((r) => r.status === "hit").map((r) => r.id);
  const failures = run.rows.filter(
    (row) => !["hit", "missing", "unmeasurable"].includes(row.status),
  );
  const missing = run.rows.filter((row) => row.status === "missing");
  const unmeasurable = run.rows.filter((row) => row.status === "unmeasurable");
  console.log(`\n${label}`);
  console.log(`  hits (${hits.length}): ${hits.join(", ") || "none"}`);
  console.log(
    `  failures (${failures.length}): ${failures.map((row) => `${row.id} [${row.reason}]`).join(", ") || "none"}`,
  );
  console.log(
    `  missing (${missing.length}): ${missing.map((row) => `${row.id} [${row.reason}]`).join(", ") || "none"}`,
  );
  console.log(
    `  unmeasurable (${unmeasurable.length}): ${unmeasurable.map((row) => `${row.id} [${row.reason}]`).join(", ") || "none"}`,
  );
  for (const row of run.rows) {
    if (row.status !== "hit") continue;
    const perRole =
      row.pairs
        ?.map(
          (pair) =>
            `${pair.role}=${pair.spread}${pair.sameLine ? "" : " (wrapped)"}`,
        )
        .join(" ") ?? "";
    console.log(
      `    ${row.id}: expected ≤${EPSILON}, actual ${row.spread ?? 0} CSS px [${perRole}]; ` +
        `${row.styles?.map((style) => `${style.role}:${style.font}/${style.lineHeight}/${style.display}/${style.verticalAlign}`).join(" | ") ?? "route styles recorded"}`,
    );
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
// Module scope so `browserRun` can reach it: `--keep` writes its screenshots
// through that function, which cannot see a binding block-scoped to the try.
let dir = null;
let fatal = false;
let environmentFailure = false;
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
  dir = stack.dir;
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
        run.routeOverflow = [
          ...(run.routeOverflow ?? []),
          { id: route.id, ...(actual.overflow ?? {}) },
        ];
      }
    }
    if (viewport.width === 390 || viewport.width === 1280) {
      const untouched = await untouchedRun(browser, base, seeded, viewport);
      run.untouched = untouched.rows;
      run.fixtureErrors.push(...untouched.errors);
    }
    const scope = await scopeRun(browser, base, seeded, viewport);
    const scopeDark = await scopeRun(
      browser,
      base,
      seeded,
      viewport,
      null,
      "dark",
    );
    run.scope = scope;
    run.scopeDark = scopeDark;
    run.fixtureErrors.push(...scope.fixtureErrors, ...scopeDark.fixtureErrors);
    cleanRuns.push(run);
    printRun(run);
    // Desktop keeps every action it had; every width keeps the id, the time
    // and a page that does not scroll sideways.
    const scopeBad = [];
    if (scope.documentOverflows)
      scopeBad.push(
        `page scrolls sideways (${scope.scrollWidth} > ${scope.clientWidth})`,
      );
    for (const entry of scope.rows ?? []) {
      if (entry.status === "missing") scopeBad.push(`${entry.id} missing`);
      else if (!entry.idVisible) scopeBad.push(`${entry.id} id not visible`);
      else if (!entry.timeVisible)
        scopeBad.push(`${entry.id} time not visible`);
      else if (!entry.withinRow)
        scopeBad.push(`${entry.id} pushed past its row`);
      else if (entry.rowScrolls) scopeBad.push(`${entry.id} header scrolls`);
      else if (
        viewport.width >= 1280 &&
        entry.actionLabels.join("|") !== entry.expectedActions.join("|")
      )
        scopeBad.push(
          `${entry.id} desktop actions are ${entry.actionLabels.join(",") || "none"}, expected ${entry.expectedActions.join(",")}`,
        );
      else if (entry.actions < 1)
        scopeBad.push(`${entry.id} has no reachable action`);
    }
    for (const palette of [scope, scopeDark]) {
      if (palette.documentOverflows && palette !== scope)
        scopeBad.push(`page scrolls sideways in ${palette.scheme}`);
      for (const entry of palette.rows ?? []) {
        if (entry.status === "missing") continue;
        if (!entry.idColor || entry.idColor !== entry.timeColor)
          scopeBad.push(
            `${entry.id} id/time colours differ in ${palette.scheme} (${entry.idColor} vs ${entry.timeColor})`,
          );
      }
    }
    for (const entry of run.routeOverflow ?? []) {
      if (entry.scrolls || (entry.clipped?.length ?? 0) > 0) {
        scopeBad.push(
          `${entry.id} header overflows its container (wrap=${entry.wrap}, clipped ${entry.clipped.map((c) => `${JSON.stringify(c.text)}+${c.over}px`).join(", ")})`,
        );
      }
    }
    if (run.routeOverflow) {
      console.log(
        `  spec rows: ${run.routeOverflow.map((entry) => `${entry.id} wrap=${entry.wrap} clipped=${entry.clipped?.length ?? "?"}`).join("; ")}`,
      );
    }
    console.log(
      `  scope (${(scope.rows ?? []).length} header(s)): ${scopeBad.join("; ") || "id + time + actions reachable, no sideways scroll"}`,
    );
    console.log(
      `    colours: light ${(scope.rows ?? [])[0]?.idColor ?? "?"} on ${scope.background}; ` +
        `dark ${(scopeDark.rows ?? [])[0]?.idColor ?? "?"} on ${scopeDark.background}`,
    );
    if (scopeBad.length) fatal = true;
    // Below 640 the header is allowed to wrap, and each visual line is
    // compared on its own. At desktop widths it is not: a participant that
    // left the author's line there is the misalignment, not an excuse.
    const wrappedOnDesktop =
      viewport.width >= 640
        ? run.rows.filter((row) => (row.wrapped?.length ?? 0) > 0)
        : [];
    for (const row of wrappedOnDesktop) {
      console.log(
        `  wrapped at ${viewport.name}: ${row.id} [${row.wrapped.join(", ")}]`,
      );
    }
    if (
      run.fixtureErrors.length ||
      run.rows.some(
        (row) =>
          row.status !== "hit" &&
          !(row.status === "unmeasurable" && viewport.width < 640),
      ) ||
      wrappedOnDesktop.length > 0 ||
      run.avatars.settled.some((row) => row.status !== "hit") ||
      run.untouched?.some((row) => row.status !== "hit")
    )
      fatal = true;
  }

  // T-445: the shape a comment header takes below `sm`, and the promise that
  // it takes none above it.
  console.log("\nSPLIT HEADERS (T-445)");
  for (const viewport of SPLIT_VIEWPORTS) {
    const desktop = viewport.width >= 640;
    for (const surface of SPLIT_SURFACES) {
      // Criterion 5 compares against the same page with every `max-sm:`
      // class removed, measured in this same run: a log from a previous
      // build would carry that build's font-loading and clock with it.
      const baseline = desktop
        ? await splitHeaderRun(browser, base, seeded, viewport, surface, {
            fault: "strip",
          })
        : null;
      for (const stress of desktop ? [false] : [false, true]) {
        const measured = await splitHeaderRun(
          browser,
          base,
          seeded,
          viewport,
          surface,
          { stress },
        );
        const { failures } = assessSplitHeaders(
          measured,
          viewport.width,
          baseline,
        );
        const rows = measured.rows ?? [];
        const label = `${viewport.width}/${surface.id}${stress ? " [stubbed #comment-99999]" : ""}`;
        console.log(
          `  ${label}: ${rows.length} header(s) ` +
            (desktop
              ? `identical to the stripped baseline: ${failures.length === 0 ? "yes" : "NO"}`
              : `inset ${rows.map((row) => row.actionInset ?? "—").join("/")} ` +
                `overflow ${rows.map((row) => row.overflowRight).join("/")} ` +
                `indent ${rows.map((row) => (row.nameLeft === null ? "—" : round2(row.metaLeft - row.nameLeft))).join("/")} ` +
                `identity gap ${rows.map((row) => (row.identityGaps.length === 0 ? "—" : Math.min(...row.identityGaps))).join("/")}`),
        );
        for (const failure of failures) {
          console.log(
            `    criterion ${failure.criterion} FAIL ${failure.row}: ${failure.detail}`,
          );
        }
        if (measured.fixtureErrors?.length) {
          for (const error of measured.fixtureErrors) {
            console.log(`    fixture failure: ${error}`);
          }
        }
        if (failures.length || measured.fixtureErrors?.length) fatal = true;
      }
    }
  }

  {
    const viewport = SPLIT_VIEWPORTS.find((entry) => entry.width === 390);
    const after = await splitCopyRun(browser, base, seeded, viewport, false);
    const before = await splitCopyRun(browser, base, seeded, viewport, true);
    const payload = after.pasted?.value ?? null;
    const was = before.pasted?.value ?? null;
    // Byte for byte, trailing newline included: T-435's reader accepted that
    // newline knowing what it was, and this card does not get to spend it.
    const same = typeof payload === "string" && payload === was;
    console.log(
      `  copy @390: ${same ? "unchanged" : "CHANGED"} ${JSON.stringify(payload)} ` +
        `vs stripped ${JSON.stringify(was)}${after.error || before.error ? ` ${after.error ?? before.error}` : ""}`,
    );
    if (!same) fatal = true;
  }

  if (options.selfTest) {
    const viewport = VIEWPORTS.at(-1);
    const selfTestCases = options.selfTestCase
      ? FAULTS.filter((entry) => entry.id === options.selfTestCase)
      : FAULTS;
    const historicalCases = ["T-359", "T-416"].filter(
      (id) => !options.selfTestCase || options.selfTestCase === id,
    );
    // The sections below are not rule mutations of a `CASES` entry, so they
    // are named rather than derived; a typo has to stay an error.
    const SECTION_CASES = ["selection", "scope", "split"];
    if (
      selfTestCases.length === 0 &&
      historicalCases.length === 0 &&
      !SECTION_CASES.includes(options.selfTestCase)
    ) {
      throw new Error(`unknown self-test case: ${options.selfTestCase}`);
    }
    console.log(
      `\nSELF-TEST: ${selfTestCases.length} rule mutation(s), each followed by a clean page`,
    );
    for (const spec of selfTestCases) {
      const entry = CASES.find((item) => item.id === spec.id);
      const execute = (fault) =>
        ROUTE_CASES.includes(entry)
          ? specRouteRun(browser, base, seeded, viewport, entry.id, fault)
          : REVISION_CASES.includes(entry)
            ? revisionRun(browser, base, seeded, viewport, fault)
            : browserRun(browser, base, seeded, viewport, fault);
      const run = await execute({ id: spec.id, kind: spec.kind });
      const target = run.rows.find((row) => row.id === spec.id);
      const unexpected = run.rows.filter(
        (row) =>
          row.id !== spec.id && !["hit", "unmeasurable"].includes(row.status),
      );
      const restored = await execute(null);
      const restoredTarget = restored.rows.find((row) => row.id === spec.id);
      // Which role moved, not merely that the row went red: a badge fault
      // that fails because the id drifted proves nothing about the badge.
      const spreadOf = (role) =>
        target?.pairs?.find((pair) => pair.role === role);
      const moved = spec.expectFail.filter((role) => {
        const pair = spreadOf(role);
        return pair?.sameLine === true && pair.spread > EPSILON;
      });
      const held = spec.expectHold.filter((role) => {
        const pair = spreadOf(role);
        return pair?.sameLine === true && pair.spread <= EPSILON;
      });
      const detected =
        target?.status === "failure" &&
        target.mutation !== null &&
        moved.length > 0 &&
        held.length === spec.expectHold.length &&
        unexpected.length === 0 &&
        !run.fixtureErrors.length &&
        restoredTarget?.status === "hit" &&
        !restored.fixtureErrors.length;
      console.log(
        `  ${spec.id}/${spec.kind}: ${detected ? "RED → restored GREEN" : "NOT PROVEN"} ` +
          `(moved ${moved.join(",") || "none"} of ${spec.expectFail.join(",")}; ` +
          `held ${held.join(",") || "none"} of ${spec.expectHold.join(",") || "none"}; ` +
          `fault ${target?.spread ?? target?.status ?? "missing"}px ${target?.reason ?? ""}, ` +
          `restore ${restoredTarget?.spread ?? restoredTarget?.status ?? "missing"}px, ` +
          `unexpected ${unexpected.map((row) => `${row.id}:${row.status}`).join(",") || "none"})`,
      );
      if (!detected) fatal = true;
    }
    if (!options.selfTestCase || options.selfTestCase === "selection") {
      const desktop = VIEWPORTS.at(-1);
      const clean = await selectionRun(browser, base, seeded, desktop);
      const expected = clean.tokenText;
      const payload = clean.pasted?.value ?? null;
      // Chromium serialises a `user-select: all` block with a newline after
      // it. That is the browser's framing, not content, so the comparison
      // trims — and then checks that nothing else rode along, which is the
      // part that would otherwise be trimmed away with it.
      const carries = (value) =>
        typeof value === "string" &&
        value.trim() === expected &&
        /^\s*#comment-\d+\s*$/.test(value);
      const cleanOk =
        !clean.error &&
        !clean.fixtureErrors.length &&
        clean.selected === expected &&
        carries(payload);
      console.log(
        `\nSELECTION (drag across the id, native Ctrl+C)\n` +
          `  clean: ${cleanOk ? "PASS" : "FAIL"} selected=${JSON.stringify(clean.selected)} ` +
          `pasted=${JSON.stringify(payload)} expected=${JSON.stringify(expected)} ` +
          `user-select=${clean.userSelect} ${clean.error ?? clean.pasted?.error ?? ""}`,
      );
      if (!cleanOk) fatal = true;
      for (const kind of ["time-in-token", "unselectable"]) {
        const broken = await selectionRun(browser, base, seeded, desktop, kind);
        const brokenPayload = broken.pasted?.value ?? null;
        // Each fault has to change the payload, and a fresh page has to put
        // it back — the restore below is a new target, never this document.
        const detected =
          !broken.error &&
          (broken.selected !== expected || !carries(brokenPayload));
        const restored = await selectionRun(browser, base, seeded, desktop);
        const backOk =
          !restored.error && carries(restored.pasted?.value ?? null);
        console.log(
          `  ${kind}: ${detected && backOk ? "RED → restored GREEN" : "NOT PROVEN"} ` +
            `selected=${JSON.stringify(broken.selected)} pasted=${JSON.stringify(brokenPayload)} ` +
            `restore=${JSON.stringify(restored.pasted?.value ?? null)} ${broken.error ?? ""}`,
        );
        if (!detected || !backOk) fatal = true;
      }
    }

    if (!options.selfTestCase || options.selfTestCase === "scope") {
      console.log("\nSCOPE FAULTS");
      // The narrow spec containers, with the wrap taken away: this is the
      // shape the header had before the fix, and what it costs is Resolve.
      for (const id of ["diff-annotation", "unplaced-comment"]) {
        const narrow = VIEWPORTS[0];
        const broken = await specRouteRun(browser, base, seeded, narrow, id, {
          id,
          kind: "nowrap",
        });
        const restored = await specRouteRun(browser, base, seeded, narrow, id);
        const spills = (run) =>
          run.overflow?.scrolls === true ||
          (run.overflow?.clipped?.length ?? 0) > 0;
        const detected = spills(broken);
        const backOk = !spills(restored) && !restored.fixtureErrors.length;
        console.log(
          `  nowrap-${id} @${narrow.name}: ${detected && backOk ? "RED → restored GREEN" : "NOT PROVEN"} ` +
            `(fault wrap=${broken.overflow?.wrap} clipped=${broken.overflow?.clipped?.length ?? "?"}; ` +
            `restore wrap=${restored.overflow?.wrap} clipped=${restored.overflow?.clipped?.length ?? "?"})`,
        );
        if (!detected || !backOk) fatal = true;
      }
      for (const [kind, viewport, breaks] of [
        [
          "hide-desktop-actions",
          VIEWPORTS.at(-1),
          (scope) =>
            (scope.rows ?? []).some(
              (row) =>
                row.status !== "missing" &&
                row.actionLabels.join("|") !== row.expectedActions.join("|"),
            ),
        ],
        [
          "unshrinkable-header",
          VIEWPORTS[0],
          (scope) =>
            scope.documentOverflows ||
            (scope.rows ?? []).some((row) => row.rowScrolls || !row.withinRow),
        ],
      ]) {
        const broken = await scopeRun(browser, base, seeded, viewport, kind);
        const restored = await scopeRun(browser, base, seeded, viewport);
        const detected = breaks(broken);
        const backOk = !breaks(restored) && !restored.documentOverflows;
        console.log(
          `  ${kind} @${viewport.name}: ${detected && backOk ? "RED → restored GREEN" : "NOT PROVEN"} ` +
            `(fault overflow=${broken.documentOverflows} actions=${(broken.rows ?? []).map((r) => r.actions).join("/")}; ` +
            `restore overflow=${restored.documentOverflows} actions=${(restored.rows ?? []).map((r) => r.actions).join("/")})`,
        );
        if (!detected || !backOk) fatal = true;
      }
    }

    if (!options.selfTestCase || options.selfTestCase === "split") {
      console.log("\nSPLIT-HEADER FAULTS (T-445)");
      // One fault per criterion, and two for the two that have a likely
      // wrong answer rather than merely a missing one: criterion 1 can be
      // satisfied-looking with the rule on the meta, and criterion 5 can be
      // lost either by dropping a `max-sm:` or by giving the identity group
      // a box above the breakpoint.
      const splitFaults = [
        [1, "strip", 320, "timeline", false, "the header as it stood before"],
        [1, "meta-auto", 430, "timeline", false, "right-alignment on the meta"],
        [2, "nowrap", 320, "spec-rendered", true, "a meta that will not wrap"],
        [
          3,
          "no-indent",
          390,
          "timeline",
          false,
          "no indent on the second line",
        ],
        [
          4,
          "no-time-auto",
          390,
          "timeline",
          false,
          "the time not claiming the space",
        ],
        [
          4,
          "justify-end",
          320,
          "spec-rendered",
          true,
          "the base justify-end once it wraps",
        ],
        // At a width where the identity still fits on one line: below that,
        // a block-level group wraps its items onto lines of their own and
        // there is no adjacent pair left to have lost its gap.
        [
          7,
          "identity-block",
          520,
          "timeline",
          false,
          "the identity group as a block",
        ],
        [
          5,
          "desktop-grid",
          1280,
          "timeline",
          false,
          "a max-sm: rule made unconditional",
        ],
        [
          5,
          "desktop-identity-flex",
          1280,
          "timeline",
          false,
          "an identity group with a box",
        ],
        [
          5,
          "drop-spacer",
          1280,
          "spec-rendered",
          false,
          "the spacer span swept up as dead code",
        ],
      ];
      for (const [
        criterion,
        kind,
        width,
        surfaceId,
        stress,
        why,
      ] of splitFaults) {
        const view = SPLIT_VIEWPORTS.find((entry) => entry.width === width);
        const surface = SPLIT_SURFACES.find((entry) => entry.id === surfaceId);
        const baseline =
          width >= 640
            ? await splitHeaderRun(browser, base, seeded, view, surface, {
                fault: "strip",
              })
            : null;
        const broken = await splitHeaderRun(
          browser,
          base,
          seeded,
          view,
          surface,
          {
            fault: kind,
            stress,
          },
        );
        const brokenVerdict = assessSplitHeaders(broken, width, baseline);
        const restored = await splitHeaderRun(
          browser,
          base,
          seeded,
          view,
          surface,
          {
            stress,
          },
        );
        const restoredVerdict = assessSplitHeaders(restored, width, baseline);
        // Which criterion went red, not merely that something did: a fault
        // aimed at the indent that fails because the page stopped rendering
        // proves nothing about the indent.
        const hit = brokenVerdict.failures.filter(
          (failure) => failure.criterion === criterion,
        );
        const detected = hit.length > 0;
        const backOk = restoredVerdict.failures.length === 0;
        console.log(
          `  ${kind} @${width}/${surfaceId}${stress ? " [stubbed id]" : ""} → criterion ${criterion}: ` +
            `${detected && backOk ? "RED → restored GREEN" : "NOT PROVEN"} (${why}; ` +
            `${hit[0]?.detail ?? "no failure on that criterion"}; ` +
            `restore ${restoredVerdict.failures.map((f) => `${f.criterion}:${f.row}`).join(",") || "clean"})`,
        );
        if (!detected || !backOk) fatal = true;
      }

      const view = SPLIT_VIEWPORTS.find((entry) => entry.width === 390);
      const clean = await splitCopyRun(browser, base, seeded, view, false);
      const expected = clean.pasted?.value ?? null;
      const stripped = await splitCopyRun(browser, base, seeded, view, true);
      console.log(
        `  copy baseline: ${expected === (stripped.pasted?.value ?? null) ? "identical" : "DIFFERENT"} ` +
          `${JSON.stringify(expected)}`,
      );
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
  environmentFailure = true;
  fatal = true;
  console.error(`user-baseline-smoke: ${error.stack ?? error}`);
} finally {
  try {
    await stack?.cleanup();
  } catch (error) {
    environmentFailure = true;
    fatal = true;
    console.error(`user-baseline-smoke cleanup: ${error.stack ?? error}`);
  }
}
process.exitCode = environmentFailure ? 2 : fatal ? 1 : 0;
