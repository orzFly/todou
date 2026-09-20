#!/usr/bin/env node
/**
 * Manual real-Chromium checks for the edit history diff's line wrapping
 * (T-425) and for the modal scroll lock the diff sits under (T-450). It is
 * intentionally independent of `pnpm test`/CI: line numbers, soft wrapping,
 * the clipboard, horizontal scrolling and the fate of a trusted wheel all live
 * inside pierre's shadow root, and happy-dom lays none of it out.
 *
 * Usage: node scripts/revision-history-wrap-smoke.mjs [--self-test] [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium). The runner starts one
 * isolated API/Vite stack and one browser, and seeds its own project, issue,
 * comment and revisions through the real API.
 * Exit codes: 0 all checks pass; 1 a named assertion fails; 2 bad CLI input,
 * missing prerequisite, startup failure, or a check that could not reach the
 * thing it grades (a coverage failure).
 * Limitations: headless Chromium measures CSS geometry, not painted pixels or
 * OS scrollbar themes. Coarse-pointer CSS rules are not exercised: the narrow
 * viewport is emulated with `mobile: false` so widths stay literal, and the
 * finger drags go in without `setTouchEmulationEnabled` for the same reason —
 * injected touches are delivered and scroll either way, and leaving it off
 * keeps `(pointer: coarse)` false for every other check in the pass.
 */
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import { createBrowserStack } from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRAP_KEY = "todou-edit-history-wrap";
const SPEC_KEY = "todou-spec-diff-wrap";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "narrow", width: 390, height: 844 },
];
const EPSILON = 1;

const HELP = `revision-history-wrap-smoke — real-browser checks for T-425

Usage:
  pnpm exec node scripts/revision-history-wrap-smoke.mjs
  pnpm exec node scripts/revision-history-wrap-smoke.mjs --self-test

Options:
  --self-test  Prove each checker with an injected fault and a fresh clean page.
  --keep       Keep the isolated stack directory after the run.
  --help       Print this help and exit.

Exit codes:
  0 checks passed; 1 a named assertion failed; 2 usage, prerequisite,
  startup, cleanup, or a check that never reached its target.
`;

// A body whose every awkward shape matters to one of the checks below: a
// no-space URL and a run of CJK to force soft wrapping, indentation and
// interior runs of spaces to catch whitespace normalisation, a blank line, a
// fence, and no trailing newline so pierre draws its end-of-file marker.
const LONG_URL = `https://example.test/${"segment".repeat(30)}`;
const LONG_CJK = "中文长行".repeat(40);
function body(variant) {
  return [
    `First paragraph, ${variant}.`,
    "",
    "    indented   with   runs   of   spaces",
    variant === "before" ? LONG_URL : `${LONG_URL}/changed`,
    variant === "before" ? LONG_CJK : `${LONG_CJK}尾`,
    "adjacent line one, also quite long so that it has somewhere to wrap",
    "adjacent line two, also quite long so that it has somewhere to wrap",
    "```js",
    `const sample = "${(variant === "before" ? "a" : "b").repeat(200)}";`,
    "```",
    "tail without a trailing newline",
  ].join("\n");
}

function failure(name, detail, extra = {}) {
  return { name, detail, ...extra };
}

/** Failures that mean the check never reached its target, not that it failed. */
const COVERAGE_FAILURES = new Set([
  "case-exception",
  "dialog-never-opened",
  "no-wrapped-line",
  "no-scrolling-line",
  "gutter-line-count-mismatch",
  "fixture-missing-shapes",
  "clipboard-unavailable",
  "prose-fixture-missing",
  "fault-not-confirmed",
  "no-wheel-delivered",
  "wheel-target-not-retargeted",
  "no-touch-delivered",
  "touch-target-not-retargeted",
  "no-drag-room",
  "page-cannot-scroll",
  "page-already-at-top",
  "self-test-baseline-not-clean",
  "self-test-no-new-failure",
  "self-test-fresh-restoration",
]);

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
  await call("PATCH", "/me", { display_name: "Neutral Human" });
  const slug = `t425-wrap-${randomUUID().slice(0, 8)}`;
  await call("POST", "/projects", { slug, name: "Edit history wrapping" });
  const issue = await call("POST", `/projects/${slug}/issues`, {
    title: "Edit history wrapping fixture",
    body: body("before"),
  });
  await call("PATCH", `/projects/${slug}/issues/${issue.number}`, {
    body: body("after"),
  });
  const comment = await call(
    "POST",
    `/projects/${slug}/issues/${issue.number}/comments`,
    { body: body("before") },
  );
  await call(
    "PATCH",
    `/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
    { body: body("after") },
  );
  // Read back what the server stored: a fixture that lost its long lines or
  // its interior spaces on the way in would make every check below vacuous.
  const stored = await call("GET", `/projects/${slug}/issues/${issue.number}`);
  const revisions = await call(
    "GET",
    `/projects/${slug}/issues/${issue.number}/revisions`,
  );
  return {
    slug,
    number: issue.number,
    commentId: comment.id,
    cookie,
    storedBody: stored?.body ?? "",
    revisionBodies: (revisions?.items ?? []).map((item) => ({
      before: item.body_before,
      after: item.body_after,
    })),
  };
}

function fixtureShapeFailures(fixture) {
  const failures = [];
  const revision = fixture.revisionBodies[0];
  if (!revision)
    return [failure("fixture-missing-shapes", "no revision was recorded")];
  for (const [side, text] of [
    ["before", revision.before],
    ["after", revision.after],
  ]) {
    if (!text.includes(LONG_URL))
      failures.push(
        failure("fixture-missing-shapes", `${side} lost the long URL`),
      );
    if (!text.includes("   runs   of   spaces"))
      failures.push(
        failure("fixture-missing-shapes", `${side} lost its interior spaces`),
      );
    if (!text.includes("\n\n"))
      failures.push(
        failure("fixture-missing-shapes", `${side} lost its blank line`),
      );
    if (text.endsWith("\n"))
      failures.push(
        failure("fixture-missing-shapes", `${side} gained a trailing newline`),
      );
  }
  return failures;
}

/**
 * Everything that has to run inside the page. Kept as one source string
 * installed before navigation so it survives reloads, which B4 needs.
 */
function probeSource(fault) {
  return `(() => {
  const FAULT = ${JSON.stringify(fault)};
  const round = v => Number.isFinite(v) ? Number(v.toFixed(2)) : null;
  const rectOf = e => { const r = e.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height),
             top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right) }; };
  const textRectTop = node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()];
    return rects.length ? round(rects[0].top) : null;
  };
  const visualRects = node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].map(r => ({ top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right) }));
  };
  /**
   * How many lines the reader sees. Not the client-rect count: syntax
   * highlighting splits one visual line into a rect per token span, so a line
   * that never wrapped still reports four or five rects. Distinct tops is the
   * count that means what it says.
   */
  const visualLineCount = node => new Set(visualRects(node).map(r => r.top)).size;
  const dialog = () => document.querySelector('[data-slot="dialog-content"]');
  const container = () => dialog()?.querySelector('diffs-container') ?? null;
  const shadow = () => container()?.shadowRoot ?? null;
  const wrapButton = () => dialog()?.querySelector('button[aria-label="wrap long lines"]') ?? null;
  const scrollBox = () => dialog()?.querySelector('.overflow-auto') ?? null;
  const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise(r => requestAnimationFrame(r)); };

  const applyFault = () => {
    if (!FAULT) return { applied: false };
    const s = shadow();
    if (FAULT === 'gutter-unshared-rows') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      const style = document.createElement('style');
      style.dataset.t425Fault = FAULT;
      // Take the gutter off the shared subgrid: every number falls back to
      // one text line while the content rows still grow with the wrapping.
      style.textContent = '[data-gutter]{display:block !important;grid-template-rows:none !important}[data-column-number]{height:20px !important;display:block !important}';
      s.appendChild(style);
      return { applied: !!s.querySelector('style[data-t425-fault]') };
    }
    if (FAULT === 'copy-inserts-breaks') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      // Rewrite the line the way the design rejects: real <br> elements at
      // the soft wrap points, which the clipboard then serialises as newlines.
      let touched = 0;
      for (const line of s.querySelectorAll('[data-line]')) {
        if (visualLineCount(line) < 2) continue;
        // Syntax highlighting nests the text inside token spans, so the
        // long runs are never direct children of the line.
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
          if (node.data.length < 30) continue;
          const half = Math.floor(node.data.length / 2);
          const tail = node.splitText(half);
          tail.parentNode.insertBefore(document.createElement('br'), tail);
          touched += 1;
        }
      }
      return { applied: touched > 0, touched };
    }
    if (FAULT === 'scroll-clipped' || FAULT === 'scroll-hidden') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      const style = document.createElement('style');
      style.dataset.t425Fault = FAULT;
      // Two different ways to "solve" a long line by not showing it: clip
      // refuses to scroll at all, while hidden still scrolls under script
      // but takes the scrollbar away from the reader.
      style.textContent = FAULT === 'scroll-clipped'
        ? '[data-code]{overflow-x:clip !important}'
        : '[data-code]{overflow-x:hidden !important}';
      s.appendChild(style);
      return { applied: !!s.querySelector('style[data-t425-fault]') };
    }
    if (FAULT === 'wrap-over-close') {
      const button = wrapButton();
      if (!button) return { applied: false, reason: 'no wrap button' };
      // Let the title have the whole row and park the toggle where the
      // dialog's own Close already is.
      button.style.position = 'absolute';
      button.style.right = '6px';
      button.style.top = '10px';
      return { applied: getComputedStyle(button).position === 'absolute' };
    }
    if (FAULT === 'wheel-release-disabled') {
      // Precisely what dialog.tsx added, taken away again: the release still
      // runs and now achieves nothing, so the lock cancels as it used to.
      Object.defineProperty(WheelEvent.prototype, 'stopPropagation',
        { value() {}, configurable: true, writable: true });
      const probe = new WheelEvent('wheel');
      probe.stopPropagation();
      return { applied: probe.cancelBubble === false };
    }
    if (FAULT === 'touch-release-disabled') {
      // The touchmove half of what dialog.tsx added, taken away again. Kept
      // apart from the wheel fault so that each gesture's release is graded
      // by a fault only it can feel.
      Object.defineProperty(TouchEvent.prototype, 'stopPropagation',
        { value() {}, configurable: true, writable: true });
      const probe = new TouchEvent('touchmove');
      probe.stopPropagation();
      return { applied: probe.cancelBubble === false };
    }
    if (FAULT === 'scroll-lock-removed') {
      // Both halves of the modal lock, for both gestures: the events it
      // cancels, and the overflow it takes off the body. An inline !important
      // is the one declaration that outranks the stylesheet the lock injects.
      for (const constructor of [WheelEvent, TouchEvent])
        Object.defineProperty(constructor.prototype, 'preventDefault',
          { value() {}, configurable: true, writable: true });
      for (const node of [document.documentElement, document.body])
        node.style.setProperty('overflow', 'auto', 'important');
      const wheel = new WheelEvent('wheel', { cancelable: true });
      wheel.preventDefault();
      const touch = new TouchEvent('touchmove', { cancelable: true });
      touch.preventDefault();
      return { applied: wheel.defaultPrevented === false &&
        touch.defaultPrevented === false &&
        getComputedStyle(document.body).overflowY !== 'hidden' };
    }
    if (FAULT === 'prose-rewrapped') {
      const style = document.createElement('style');
      style.dataset.t425Fault = FAULT;
      // The "just add global CSS" shortcut the design rejects, which reaches
      // the page's own prose and fences instead of the diff.
      style.textContent = '.markdown-body,.markdown-body *{white-space:pre-wrap !important;overflow-x:hidden !important;word-break:break-all !important}';
      document.head.appendChild(style);
      return { applied: !!document.head.querySelector('style[data-t425-fault]') };
    }
    return { applied: false, reason: 'unknown fault' };
  };

  window.__t425 = {
    faultApplied: null,
    openEntry: async (which) => {
      const marks = [...document.querySelectorAll('button')].filter(b => b.textContent === '(edited)');
      const mark = which === 'description' ? marks[0] : marks[marks.length - 1];
      if (!mark) return { ok: false, reason: 'no (edited) marker', markers: marks.length };
      if (marks.length < 2) return { ok: false, reason: 'fixture has fewer than two edited markers', markers: marks.length };
      mark.click();
      let row = null;
      for (let i = 0; i < 100; i += 1) {
        const rows = [...document.querySelectorAll('[data-slot="popover-content"] button')];
        if (rows.length) { row = rows[0]; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      if (!row) return { ok: false, reason: 'revision list never filled' };
      row.click();
      for (let i = 0; i < 200; i += 1) {
        if (shadow()?.querySelector('[data-line]')) {
          await settle();
          if (FAULT && !window.__t425.faultApplied) window.__t425.faultApplied = applyFault();
          await settle();
          return { ok: true, title: dialog()?.querySelector('[data-slot="dialog-title"]')?.textContent ?? null };
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return { ok: false, reason: 'diff never rendered' };
    },
    closeDialog: async () => {
      const close = dialog()?.querySelector('[data-slot="dialog-close"]');
      if (!close) return { ok: false };
      close.click();
      for (let i = 0; i < 60; i += 1) {
        if (!dialog()) return { ok: true };
        await new Promise(r => setTimeout(r, 25));
      }
      return { ok: false, reason: 'dialog stayed open' };
    },
    toggleWrap: async (how) => {
      const button = wrapButton();
      if (!button) return { ok: false };
      const before = button.getAttribute('aria-pressed');
      const node = container();
      if (how === 'click') button.click();
      else button.focus();
      if (how !== 'click') return { ok: true, focused: document.activeElement === button, before };
      for (let i = 0; i < 80; i += 1) {
        if (wrapButton()?.getAttribute('aria-pressed') !== before) break;
        await new Promise(r => setTimeout(r, 25));
      }
      await settle();
      return { ok: true, before, after: wrapButton()?.getAttribute('aria-pressed') ?? null,
               sameContainer: node === container() };
    },
    settle,
    /** B1: one number per source line, aligned with its first visual line. */
    lineNumbers: () => {
      const s = shadow();
      if (!s) return { error: 'no shadow root' };
      const numbers = [...s.querySelectorAll('[data-column-number]')];
      const lines = [...s.querySelectorAll('[data-line]')];
      if (numbers.length !== lines.length)
        return { error: 'count mismatch', numbers: numbers.length, lines: lines.length };
      const rows = numbers.map((number, index) => {
        const line = lines[index];
        const content = number.querySelector('[data-line-number-content]') ?? number;
        const rects = visualRects(line);
        return {
          index,
          lineIndex: line.getAttribute('data-line-index'),
          numberIndex: number.getAttribute('data-line-index'),
          number: content.textContent.trim(),
          numberTop: textRectTop(content),
          numberRect: rectOf(number),
          lineRect: rectOf(line),
          // An empty source line has no text to put a Range around, so its
          // text top is meaningless; the box tops are compared either way.
          hasText: line.textContent.trim().length > 0,
          firstVisualTop: rects.length ? rects[0].top : null,
          visualLines: visualLineCount(line),
          numberOccurrences: (content.textContent.match(/\\d+/g) ?? []).length,
        };
      });
      return { rows, wrappedRows: rows.filter(r => r.visualLines > 1).length };
    },
    /** B2: select inside one soft-wrapped source line, or across two. */
    selectWrapped: (side, mode) => {
      const s = shadow();
      if (!s) return { error: 'no shadow root' };
      const type = side === 'deletion' ? 'change-deletion' : 'change-addition';
      const all = [...s.querySelectorAll('[data-line]')];
      const lines = all.filter(line => line.getAttribute('data-line-type') === type);
      if (mode === 'across-lines') {
        // Adjacent in the DOM, not merely both on this side: a pair with
        // other lines between them would make the expected text a fiction.
        for (let i = 0; i < all.length - 1; i += 1) {
          const a = all[i], b = all[i + 1];
          if (a.getAttribute('data-line-type') !== type) continue;
          if (b.getAttribute('data-line-type') !== type) continue;
          if (a.nextElementSibling !== b) continue;
          if (!a.textContent.trim() || !b.textContent.trim()) continue;
          const range = document.createRange();
          range.setStart(a, 0);
          range.setEnd(b, b.childNodes.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return { ok: true, expected: a.textContent + '\\n' + b.textContent,
                   lines: [a.getAttribute('data-line'), b.getAttribute('data-line')] };
        }
        return { error: 'no adjacent pair' };
      }
      const wrapped = lines.find(line => visualLineCount(line) > 1);
      if (!wrapped) return { error: 'no wrapped line' };
      const range = document.createRange();
      range.selectNodeContents(wrapped);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return { ok: true, expected: wrapped.textContent, visualLines: visualLineCount(wrapped),
               line: wrapped.getAttribute('data-line') };
    },
    readClipboard: async () => {
      try { return { ok: true, text: await navigator.clipboard.readText() }; }
      catch (error) { return { ok: false, error: String(error) }; }
    },
    /** B3: where horizontal travel actually lives, and whether it works. */
    scrollState: () => {
      const s = shadow();
      const code = s?.querySelector('[data-code]');
      const box = scrollBox();
      if (!code || !box) return { error: 'no code or scroll box' };
      const style = getComputedStyle(code);
      const marker = s.querySelector('[data-no-newline]');
      const widest = [...s.querySelectorAll('[data-line]')]
        .reduce((best, line) => {
          const rects = visualRects(line);
          const right = rects.reduce((m, r) => Math.max(m, r.right), -Infinity);
          return right > (best?.right ?? -Infinity) ? { right, line } : best;
        }, null);
      return {
        code: { scrollWidth: code.scrollWidth, clientWidth: code.clientWidth, scrollLeft: round(code.scrollLeft),
                overflowX: style.overflowX, scrollbarGutter: style.scrollbarGutter, whiteSpace: style.whiteSpace },
        line: (() => { const l = s.querySelector('[data-line]'); const cs = l && getComputedStyle(l);
          return cs ? { whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak } : null; })(),
        box: { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth,
               scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, scrollTop: round(box.scrollTop) },
        widestRight: widest ? round(widest.right) : null,
        codeRight: round(code.getBoundingClientRect().right),
        marker: marker ? { text: marker.textContent, rect: rectOf(marker) } : null,
        dialogRect: dialog() ? rectOf(dialog()) : null,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    },
    wheelSeen: [],
    wheelSettled: [],
    watchWheel: () => {
      window.__t425.wheelSeen = [];
      window.__t425.wheelSettled = [];
      if (window.__t425.wheelWatching) return true;
      window.__t425.wheelWatching = true;
      // Two listeners, because one cannot answer both questions. Capture on
      // window runs before anything else and so counts every wheel that
      // arrived, including the ones dialog.tsx takes out of the lock's reach
      // with stopPropagation. Bubbling on window runs after everyone and is
      // the only place the cancellation verdict is final — an event that is
      // missing from it was released rather than cancelled.
      window.addEventListener('wheel', event => {
        window.__t425.wheelSeen.push({ deltaX: event.deltaX, deltaY: event.deltaY,
          cancelable: event.cancelable,
          retargeted: event.target !== event.composedPath()[0],
          target: event.target?.tagName?.toLowerCase() ?? null });
      }, { passive: true, capture: true });
      window.addEventListener('wheel', event => {
        window.__t425.wheelSettled.push({ deltaX: event.deltaX, deltaY: event.deltaY,
          cancelable: event.cancelable, defaultPrevented: event.defaultPrevented });
      }, { passive: true });
      return true;
    },
    wheelEvents: () => window.__t425.wheelSeen,
    wheelVerdicts: () => window.__t425.wheelSettled,
    touchSeen: [],
    touchSettled: [],
    // The same two-listener split as watchWheel, for the same reason: a
    // released touchmove never reaches the bubbling listener where
    // defaultPrevented is final, so only the capturing count can say it came.
    watchTouch: () => {
      window.__t425.touchSeen = [];
      window.__t425.touchSettled = [];
      if (window.__t425.touchWatching) return true;
      window.__t425.touchWatching = true;
      window.addEventListener('touchmove', event => {
        window.__t425.touchSeen.push({ cancelable: event.cancelable,
          touches: event.touches.length,
          retargeted: event.target !== event.composedPath()[0],
          target: event.target?.tagName?.toLowerCase() ?? null });
      }, { passive: true, capture: true });
      window.addEventListener('touchmove', event => {
        window.__t425.touchSettled.push({ cancelable: event.cancelable,
          defaultPrevented: event.defaultPrevented });
      }, { passive: true });
      return true;
    },
    touchEvents: () => window.__t425.touchSeen,
    touchVerdicts: () => window.__t425.touchSettled,
    /**
     * Where a finger starts and ends, in viewport coordinates. Sideways it
     * stays inside the diff box: at 390px the box is narrower than the 600px
     * the wheel gesture travels, and a touch point off the left edge of the
     * screen is not a gesture the browser will route here. Downwards is the
     * direction that scrolls the page *up*, which is the one the lock has to
     * keep holding.
     */
    dragPath: axis => {
      const code = shadow()?.querySelector('[data-code]');
      if (!code) return { error: 'no code' };
      const r = code.getBoundingClientRect();
      const mid = { x: round(r.left + r.width / 2), y: round(r.top + r.height / 2) };
      if (axis === 'h') {
        const from = { x: round(r.right - 8), y: mid.y };
        const to = { x: round(r.left + 8), y: mid.y };
        return { from, to, distance: round(from.x - to.x) };
      }
      const room = Math.min(240, innerHeight - mid.y - 8);
      return { from: mid, to: { x: mid.x, y: round(mid.y + room) }, distance: round(room) };
    },
    pageScroll: () => ({
      y: Math.round(window.scrollY),
      max: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    }),
    // probeWheel's vertical gesture scrolls the page up, so an entry that left
    // the page at 0 hands the next one a sample that holds still whatever the
    // lock does. Under a working lock this call moves nothing — and a working
    // lock is also why the page was never pushed to 0 to begin with.
    parkPageAtBottom: () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return Math.round(window.scrollY);
    },
    pointTarget: (x, y) => {
      const top = document.elementFromPoint(x, y);
      const inner = shadow()?.elementFromPoint?.(x, y) ?? null;
      const describe = e => e ? { tag: e.tagName.toLowerCase(),
        data: Object.fromEntries([...e.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])) } : null;
      return { top: describe(top), inner: describe(inner) };
    },
    codeScroll: () => {
      const code = shadow()?.querySelector('[data-code]');
      if (!code) return { error: 'no code' };
      const box = code.getBoundingClientRect();
      const widest = [...shadow().querySelectorAll('[data-line]')]
        .reduce((best, line) => {
          const right = visualRects(line).reduce((m, r) => Math.max(m, r.right), -Infinity);
          return right > (best?.right ?? -Infinity) ? { right, line } : best;
        }, null);
      return {
        rect: rectOf(code),
        centre: { x: round(box.left + box.width / 2), y: round(box.top + box.height / 2) },
        scrollLeft: round(code.scrollLeft),
        max: code.scrollWidth - code.clientWidth,
        overflowX: getComputedStyle(code).overflowX,
        // Where the far end of the longest line currently sits, in viewport
        // coordinates. Content that really travelled moves this; a container
        // that only accepted the scrollLeft assignment does not.
        widestRight: widest ? round(widest.right) : null,
        codeRight: round(box.right),
        endReached: widest ? widest.right <= box.right + 1 : null,
      };
    },
    resetCodeScroll: () => {
      const code = shadow()?.querySelector('[data-code]');
      if (code) code.scrollLeft = 0;
      return code ? round(code.scrollLeft) : null;
    },
    scrollCodeToMax: async () => {
      const code = shadow()?.querySelector('[data-code]');
      if (!code) return { error: 'no code' };
      code.scrollLeft = code.scrollWidth;
      await settle();
      return { scrollLeft: round(code.scrollLeft), max: code.scrollWidth - code.clientWidth };
    },
    scrollBoxToBottom: async () => {
      const box = scrollBox();
      if (!box) return { error: 'no box' };
      box.scrollTop = box.scrollHeight;
      await settle();
      return { scrollTop: round(box.scrollTop), max: box.scrollHeight - box.clientHeight };
    },
    /** B4: the header's three occupants, and the toggle's keyboard surface. */
    headerLayout: () => {
      const d = dialog();
      if (!d) return { error: 'no dialog' };
      const title = d.querySelector('[data-slot="dialog-title"]');
      const button = wrapButton();
      const close = d.querySelector('[data-slot="dialog-close"]');
      const shadowHeader = shadow()?.querySelector('[data-diffs-header]') ?? null;
      const visible = e => {
        if (!e) return false;
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' &&
          Number.parseFloat(cs.opacity) > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
      };
      const intersects = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const buttonRect = button && rectOf(button);
      const closeRect = close && rectOf(close);
      return {
        title: title ? { rect: rectOf(title), text: title.textContent, visible: visible(title) } : null,
        button: button ? { rect: buttonRect, visible: visible(button), pressed: button.getAttribute('aria-pressed'),
                           label: button.getAttribute('aria-label'), title: button.getAttribute('title'),
                           type: button.getAttribute('type'), inScrollBox: scrollBox()?.contains(button) ?? null,
                           icon: !!button.querySelector('svg'), text: button.textContent.trim() } : null,
        close: close ? { rect: closeRect, visible: visible(close) } : null,
        overlap: intersects(buttonRect, closeRect),
        titleOverCloseGap: title && closeRect ? round(closeRect.left - rectOf(title).right) : null,
        fileHeader: shadowHeader ? { text: shadowHeader.textContent.replace(/\\s+/g, ' ').trim(), visible: true,
          additions: shadowHeader.querySelector('[data-additions-count]')?.textContent ?? null,
          deletions: shadowHeader.querySelector('[data-deletions-count]')?.textContent ?? null } : null,
        focus: (() => {
          if (!button) return null;
          button.focus();
          const cs = getComputedStyle(button);
          return { focused: document.activeElement === button, focusVisible: button.matches(':focus-visible'),
                   outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
        })(),
        viewport: { width: innerWidth, height: innerHeight },
        docScrollWidth: document.documentElement.scrollWidth,
      };
    },
    pressed: () => wrapButton()?.getAttribute('aria-pressed') ?? null,
    focusWrap: () => { const b = wrapButton(); if (!b) return false; b.focus(); return document.activeElement === b; },
    storage: () => {
      try { return { wrap: localStorage.getItem(${JSON.stringify(WRAP_KEY)}),
                     spec: localStorage.getItem(${JSON.stringify(SPEC_KEY)}) }; }
      catch (error) { return { error: String(error) }; }
    },
    setSpecWrap: value => { localStorage.setItem(${JSON.stringify(SPEC_KEY)}, value); },
    setTheme: value => { localStorage.setItem('todou-theme', value); },
    /** B5: the page's own prose and fences, which this card must not touch. */
    prose: () => {
      const bodies = [...document.querySelectorAll('.markdown-body')];
      if (!bodies.length) return { error: 'no markdown body' };
      const describe = element => {
        const cs = getComputedStyle(element);
        return { whiteSpace: cs.whiteSpace, overflowX: cs.overflowX, wordBreak: cs.wordBreak,
                 rect: rectOf(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      };
      return {
        count: bodies.length,
        bodies: bodies.map(b => ({
          ...describe(b),
          text: b.textContent.replace(/\\s+/g, ' ').slice(0, 160),
          logicalLines: [...b.children].map(child => child.textContent.length),
        })),
        fences: [...document.querySelectorAll('.markdown-body diffs-container')].map(node => {
          const code = node.shadowRoot?.querySelector('[data-code]');
          const line = node.shadowRoot?.querySelector('[data-line]');
          return {
            rect: rectOf(node),
            code: code ? { scrollWidth: code.scrollWidth, clientWidth: code.clientWidth,
                           overflowX: getComputedStyle(code).overflowX } : null,
            line: line ? { whiteSpace: getComputedStyle(line).whiteSpace, text: line.textContent.slice(0, 40) } : null,
          };
        }),
      };
    },
  };
})()`;
}

/**
 * Take the diff's horizontal scroller to its end and confirm the content
 * actually travelled — the far end of the longest line has to arrive inside
 * the box, not merely a scrollLeft value change. `overflow-x: clip` refuses
 * the assignment outright, and `overflow-x: hidden` is caught by the
 * computed-style assertion beside this one.
 *
 * A real wheel is graded separately, by `probeWheel` and `checkWheel`.
 */
async function scrollCodeToEnd(page) {
  const before = await evaluate(page, () => window.__t425.codeScroll());
  if (before.error) return { before };
  const moved = await evaluate(page, () => window.__t425.scrollCodeToMax());
  const after = await evaluate(page, () => window.__t425.codeScroll());
  return { before, moved, after };
}

/** A compositor-level gesture: untrusted `new WheelEvent(...)` scrolls nothing. */
async function wheelOver(page, x, y, xDistance, yDistance) {
  // Hover first: a wheel arrives at whatever the last mouse move put under
  // the cursor, and the cursor starts at the origin.
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await sleep(50);
  await evaluate(page, () => window.__t425.watchWheel());
  await page.send("Input.synthesizeScrollGesture", {
    x,
    y,
    xDistance,
    yDistance,
    gestureSourceType: "mouse",
    speed: 4000,
  });
  await sleep(250);
  return {
    arrived: await evaluate(page, () => window.__t425.wheelEvents()),
    settled: await evaluate(page, () => window.__t425.wheelVerdicts()),
  };
}

/**
 * One finger, dragged in a straight line. `Input.synthesizeScrollGesture` with
 * a touch source was measured to deliver nothing at all here — no touchmove
 * and no scroll, with or without touch emulation — so the sequence is dispatched
 * by hand, which does both. The steps are paced so the drag passes Chromium's
 * slop distance early and the compositor treats it as a scroll rather than a tap.
 */
async function dragOver(page, from, to, steps = 20) {
  await evaluate(page, () => window.__t425.watchTouch());
  await page.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  });
  for (let step = 1; step <= steps; step += 1) {
    await page.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: Math.round(from.x + ((to.x - from.x) * step) / steps),
          y: Math.round(from.y + ((to.y - from.y) * step) / steps),
          id: 1,
        },
      ],
    });
    await sleep(16);
  }
  await page.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await sleep(300);
  return {
    arrived: await evaluate(page, () => window.__t425.touchEvents()),
    settled: await evaluate(page, () => window.__t425.touchVerdicts()),
  };
}

/**
 * What a trusted finger over the diff does, in both directions (T-471).
 *
 * `react-remove-scroll` registers one `shouldPrevent` for `wheel` and
 * `touchmove` alike, so a drag walks into the same retargeted dead end a wheel
 * did and is cancelled for the same reason. Everything T-450's wheel pair
 * grades is graded here again for the gesture a reader on a phone actually
 * makes — and the 390px viewport in this file is a phone's width.
 *
 * Only the first touchmove of a scrolling gesture stays cancelable: once the
 * compositor is scrolling, Chromium stops asking. That is why the sideways
 * verdict is `scrollLeft`, not a cancellation count, while the downward one —
 * where nothing ever starts scrolling — can count cancellations directly.
 */
async function probeTouch(page) {
  await evaluate(page, () => window.__t425.resetCodeScroll());
  const start = await evaluate(page, () => window.__t425.codeScroll());
  if (start.error) return { error: start.error };
  const sideways = await evaluate(page, () => window.__t425.dragPath("h"));
  if (sideways.error) return { error: sideways.error };
  const target = await evaluate(
    page,
    (x, y) => window.__t425.pointTarget(x, y),
    sideways.from.x,
    sideways.from.y,
  );
  const left = await dragOver(page, sideways.from, sideways.to);
  const end = await evaluate(page, () => window.__t425.codeScroll());

  const box = await evaluate(page, () => window.__t425.scrollBoxToBottom());
  await evaluate(page, () => window.__t425.parkPageAtBottom());
  const downwards = await evaluate(page, () => window.__t425.dragPath("v"));
  const pageBefore = await evaluate(page, () => window.__t425.pageScroll());
  const down = await dragOver(page, downwards.from, downwards.to);
  const pageAfter = await evaluate(page, () => window.__t425.pageScroll());

  return {
    target,
    horizontal: {
      from: start.scrollLeft,
      to: end.scrollLeft,
      max: end.max,
      distance: sideways.distance,
      arrived: left.arrived.length,
      retargeted: left.arrived.every((event) => event.retargeted),
      cancelled: left.settled.filter((event) => event.defaultPrevented).length,
    },
    vertical: {
      distance: downwards.distance,
      arrived: down.arrived.length,
      cancelled: down.settled.filter((event) => event.defaultPrevented).length,
      box,
      page: { before: pageBefore.y, after: pageAfter.y, max: pageBefore.max },
    },
  };
}

/**
 * What a trusted wheel over the diff does, in both directions (T-450).
 *
 * Sideways it has to scroll. The modal scroll lock judges a wheel by
 * `event.target`, and pierre's open shadow root retargets that to the host, so
 * the scroller holding the code is invisible to it and every horizontal wheel
 * used to be cancelled as an overscroll; `dialog.tsx` hands those events past
 * the lock. The vertical half has to stay cancelled while the dialog itself
 * has nowhere left to go, which is the half of the lock this card must not
 * have widened its way through — hence `scrollBoxToBottom` first, and the
 * box's own travel is recorded beside the verdict, because a box with none
 * could not have absorbed the gesture from either end. That gesture scrolls
 * the page *up* — CDP reads a positive yDistance as scroll-up — so the page is
 * parked at its bottom first, where it has somewhere to be pushed.
 */
async function probeWheel(page) {
  // From the left edge: the travel check above leaves it at the far end,
  // where a working wheel would have nowhere to go either.
  await evaluate(page, () => window.__t425.resetCodeScroll());
  const start = await evaluate(page, () => window.__t425.codeScroll());
  if (start.error) return { error: start.error };
  const target = await evaluate(
    page,
    (x, y) => window.__t425.pointTarget(x, y),
    start.centre.x,
    start.centre.y,
  );
  const sideways = await wheelOver(
    page,
    start.centre.x,
    start.centre.y,
    -600,
    0,
  );
  const end = await evaluate(page, () => window.__t425.codeScroll());

  const box = await evaluate(page, () => window.__t425.scrollBoxToBottom());
  await evaluate(page, () => window.__t425.parkPageAtBottom());
  const pageBefore = await evaluate(page, () => window.__t425.pageScroll());
  const upwards = await wheelOver(page, start.centre.x, start.centre.y, 0, 600);
  const pageAfter = await evaluate(page, () => window.__t425.pageScroll());

  return {
    target,
    scrollLocked: await evaluate(page, () =>
      document.body.hasAttribute("data-scroll-locked"),
    ),
    horizontal: {
      from: start.scrollLeft,
      to: end.scrollLeft,
      max: end.max,
      arrived: sideways.arrived.length,
      retargeted: sideways.arrived.every((event) => event.retargeted),
      cancelled: sideways.settled.filter((event) => event.defaultPrevented)
        .length,
    },
    vertical: {
      arrived: upwards.arrived.length,
      cancelled: upwards.settled.filter((event) => event.defaultPrevented)
        .length,
      box,
      page: { before: pageBefore.y, after: pageAfter.y, max: pageBefore.max },
    },
  };
}

/**
 * `page-scrolled-behind-dialog` is the outcome the lock exists for, and it is
 * deliberately kept next to `vertical-wheel-not-cancelled`, which is the
 * mechanism underneath it: the lock also puts `overflow: hidden` on the body,
 * so the page cannot move whatever happens to the wheel and the outcome alone
 * would never go red. The `scroll-lock-removed` fault lifts both halves, which
 * is what makes this pair falsifiable rather than decorative.
 */
function checkWheel(result, viewport, entry, baselineHeight) {
  const at = { viewport: viewport.name, entry, gesture: "wheel" };
  if (result.error) return [failure("no-scrolling-line", result.error, at)];
  const failures = [];
  const { horizontal, vertical } = result;
  if (horizontal.arrived === 0 || vertical.arrived === 0)
    return [
      failure(
        "no-wheel-delivered",
        `${horizontal.arrived} sideways, ${vertical.arrived} upwards`,
        at,
      ),
    ];
  // Without the retargeting there is no T-450 to grade, and a green run would
  // mean pierre had stopped using a shadow root rather than that this works.
  if (!horizontal.retargeted)
    failures.push(
      failure(
        "wheel-target-not-retargeted",
        `wheels landed on ${JSON.stringify(result.target)} unretargeted`,
        at,
      ),
    );
  if (horizontal.max < 1)
    failures.push(
      failure("no-scrolling-line", "nothing to scroll sideways", at),
    );
  else if (horizontal.to <= horizontal.from)
    failures.push(
      failure(
        "horizontal-wheel-blocked",
        `scrollLeft stayed at ${horizontal.to} of ${horizontal.max}; ${horizontal.cancelled} of ${horizontal.arrived} wheels cancelled`,
        at,
      ),
    );
  if (vertical.cancelled === 0)
    failures.push(
      failure(
        "vertical-wheel-not-cancelled",
        `${vertical.arrived} upward wheels, none cancelled, with the dialog's own scroller at ${JSON.stringify(vertical.box)}`,
        at,
      ),
    );
  if (baselineHeight < 1)
    failures.push(
      failure(
        "page-cannot-scroll",
        `the issue page is ${baselineHeight}px short of scrolling, so the lock has nothing to hold`,
        at,
      ),
    );
  // `page-cannot-scroll` asks whether the page can scroll at all; this asks
  // whether it could have scrolled *here*. The gesture goes up, so a page
  // sitting at 0 holds still whether the lock works or not, and the outcome
  // below would pass on a sample that never had anywhere to go.
  else if (vertical.page.before < 1)
    failures.push(
      failure(
        "page-already-at-top",
        `the upward gesture started at 0 of ${vertical.page.max}, so there was nothing for the lock to prevent`,
        at,
      ),
    );
  else if (vertical.page.after !== vertical.page.before)
    failures.push(
      failure(
        "page-scrolled-behind-dialog",
        `window.scrollY ${vertical.page.before} → ${vertical.page.after}`,
        at,
      ),
    );
  return failures;
}

/** The same pair of questions asked of a finger; see `probeTouch`. */
function checkTouch(result, viewport, entry, baselineHeight) {
  const at = { viewport: viewport.name, entry, gesture: "touch" };
  if (result.error) return [failure("no-scrolling-line", result.error, at)];
  const failures = [];
  const { horizontal, vertical } = result;
  if (horizontal.arrived === 0 || vertical.arrived === 0)
    return [
      failure(
        "no-touch-delivered",
        `${horizontal.arrived} sideways, ${vertical.arrived} downwards`,
        at,
      ),
    ];
  if (!horizontal.retargeted)
    failures.push(
      failure(
        "touch-target-not-retargeted",
        `drags landed on ${JSON.stringify(result.target)} unretargeted`,
        at,
      ),
    );
  // A finger cannot travel further than the box it starts in, so unlike the
  // wheel this half can be starved of room by the layout rather than by the
  // lock, and a green run would then mean nothing was asked.
  if (horizontal.distance < 40 || vertical.distance < 40)
    failures.push(
      failure(
        "no-drag-room",
        `${horizontal.distance}px sideways, ${vertical.distance}px downwards`,
        at,
      ),
    );
  else if (horizontal.max < 1)
    failures.push(
      failure("no-scrolling-line", "nothing to scroll sideways", at),
    );
  else if (horizontal.to <= horizontal.from)
    failures.push(
      failure(
        "horizontal-touch-blocked",
        `scrollLeft stayed at ${horizontal.to} of ${horizontal.max} over a ${horizontal.distance}px drag; ${horizontal.cancelled} of ${horizontal.arrived} touchmoves cancelled`,
        at,
      ),
    );
  if (vertical.cancelled === 0)
    failures.push(
      failure(
        "vertical-touch-not-cancelled",
        `${vertical.arrived} downward touchmoves, none cancelled, with the dialog's own scroller at ${JSON.stringify(vertical.box)}`,
        at,
      ),
    );
  if (baselineHeight < 1)
    failures.push(
      failure(
        "page-cannot-scroll",
        `the issue page is ${baselineHeight}px short of scrolling, so the lock has nothing to hold`,
        at,
      ),
    );
  else if (vertical.page.before < 1)
    failures.push(
      failure(
        "page-already-at-top",
        `the downward drag started at 0 of ${vertical.page.max}, so there was nothing for the lock to prevent`,
        at,
      ),
    );
  else if (vertical.page.after !== vertical.page.before)
    failures.push(
      failure(
        "page-scrolled-behind-dialog",
        `window.scrollY ${vertical.page.before} → ${vertical.page.after}`,
        at,
      ),
    );
  return failures;
}

async function pressKey(page, key, { modifiers = 0, code, text } = {}) {
  const shared = {
    modifiers,
    key,
    code: code ?? key,
    windowsVirtualKeyCode:
      key === "Tab"
        ? 9
        : key === "Enter"
          ? 13
          : key === " "
            ? 32
            : key.toUpperCase().charCodeAt(0),
  };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shared });
  if (text !== undefined)
    await page.send("Input.dispatchKeyEvent", {
      type: "char",
      ...shared,
      text,
    });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared });
}

function checkLineNumbers(measurement, wrap, viewport) {
  const failures = [];
  const at = { viewport: viewport.name, wrap };
  if (measurement.error) {
    failures.push(
      failure(
        measurement.error === "count mismatch"
          ? "gutter-line-count-mismatch"
          : "no-wrapped-line",
        JSON.stringify(measurement),
        at,
      ),
    );
    return failures;
  }
  if (wrap && measurement.wrappedRows === 0)
    failures.push(
      failure("no-wrapped-line", "no source line soft-wrapped", at),
    );
  if (!wrap && measurement.wrappedRows !== 0)
    failures.push(
      failure(
        "scroll-mode-wrapped",
        `${measurement.wrappedRows} lines wrapped with wrapping off`,
        at,
      ),
    );
  let previousBottom = null;
  for (const row of measurement.rows) {
    if (row.lineIndex !== row.numberIndex)
      failures.push(
        failure(
          "gutter-row-mispaired",
          `row ${row.index}: number ${row.numberIndex} beside line ${row.lineIndex}`,
          at,
        ),
      );
    if (row.numberOccurrences > 1)
      failures.push(
        failure(
          "line-number-repeated",
          `line ${row.number} printed ${row.numberOccurrences} times`,
          at,
        ),
      );
    // The shared subgrid row is what makes a wrapped line keep its number,
    // so the boxes are compared for every line…
    if (Math.abs(row.numberRect.top - row.lineRect.top) > EPSILON)
      failures.push(
        failure(
          "line-number-misaligned",
          `line ${row.number}: gutter row at ${row.numberRect.top}, content row at ${row.lineRect.top}`,
          at,
        ),
      );
    // …and the rendered digits are compared against the first visual line
    // only where there is text to put a Range around. An empty source line
    // has none, and a collapsed Range would grade the box, not the digits.
    if (
      row.hasText &&
      (row.numberTop === null ||
        row.firstVisualTop === null ||
        Math.abs(row.numberTop - row.firstVisualTop) > EPSILON)
    )
      failures.push(
        failure(
          "line-number-misaligned",
          `line ${row.number}: number top ${row.numberTop} vs first visual line ${row.firstVisualTop}`,
          at,
        ),
      );
    if (previousBottom !== null && row.lineRect.top < previousBottom - EPSILON)
      failures.push(
        failure(
          "source-line-overlaps-previous",
          `line ${row.number} starts at ${row.lineRect.top}, above ${previousBottom}`,
          at,
        ),
      );
    previousBottom = row.lineRect.bottom;
  }
  return failures;
}

async function copyRoundTrip(page, side, mode) {
  const selection = await evaluate(
    page,
    (s, m) => window.__t425.selectWrapped(s, m),
    side,
    mode,
  );
  if (selection.error) return { selection };
  await pressKey(page, "c", { modifiers: 2, code: "KeyC", text: "c" });
  await sleep(120);
  const clipboard = await evaluate(page, () => window.__t425.readClipboard());
  return { selection, clipboard };
}

function checkCopy(result, side, mode, viewport) {
  const at = { viewport: viewport.name, side, mode };
  if (result.selection.error)
    return [
      failure(
        result.selection.error === "no wrapped line"
          ? "no-wrapped-line"
          : "copy-selection-failed",
        result.selection.error,
        at,
      ),
    ];
  if (!result.clipboard?.ok)
    return [
      failure(
        "clipboard-unavailable",
        result.clipboard?.error ?? "no clipboard result",
        at,
      ),
    ];
  const got = result.clipboard.text;
  const want = result.selection.expected;
  if (got === want) return [];
  return [
    failure(
      "copy-text-differs",
      `clipboard ${JSON.stringify(got.slice(0, 80))}… (${got.length} chars, ${
        (got.match(/\n/g) ?? []).length
      } newlines) vs source ${JSON.stringify(want.slice(0, 80))}… (${
        want.length
      } chars, ${(want.match(/\n/g) ?? []).length} newlines)`,
      at,
    ),
  ];
}

function checkScroll(state, scrolled, wrap, viewport, baselineWidth) {
  const failures = [];
  const at = { viewport: viewport.name, wrap };
  if (state.error) return [failure("no-scrolling-line", state.error, at)];
  const overflowing = state.code.scrollWidth > state.code.clientWidth + 1;
  if (!wrap) {
    if (!overflowing)
      failures.push(
        failure(
          "no-scrolling-line",
          `code ${state.code.scrollWidth} fits in ${state.code.clientWidth}; nothing to scroll`,
          at,
        ),
      );
    // A real scroller, not something hiding or clipping the overflow. This
    // and the travel check below hold different shapes: `hidden` still
    // accepts a scrollLeft, and `clip` still computes a wide scrollWidth.
    if (state.code.overflowX !== "scroll")
      failures.push(
        failure(
          "scroll-mode-overflow-style",
          `[data-code] overflow-x is ${state.code.overflowX}, expected scroll`,
          at,
        ),
      );
    if (overflowing) {
      const travelled =
        scrolled.before?.widestRight !== null &&
        scrolled.after?.widestRight !== null &&
        scrolled.before.widestRight - scrolled.after.widestRight > EPSILON;
      if (!travelled)
        failures.push(
          failure(
            "horizontal-scroll-blocked",
            `scrollLeft ${scrolled.before?.scrollLeft}→${scrolled.after?.scrollLeft} of ${scrolled.after?.max}, longest line's end stayed at ${scrolled.after?.widestRight}`,
            at,
          ),
        );
      else if (scrolled.after?.endReached !== true)
        failures.push(
          failure(
            "line-end-not-reachable",
            `at maximum scroll the longest line still ends at ${scrolled.after?.widestRight}, past ${scrolled.after?.codeRight}`,
            at,
          ),
        );
    }
    if (state.line?.whiteSpace !== "pre")
      failures.push(
        failure(
          "scroll-mode-white-space",
          `lines are ${state.line?.whiteSpace}, expected pre`,
          at,
        ),
      );
  } else {
    if (overflowing)
      failures.push(
        failure(
          "wrap-mode-overflows",
          `code still ${state.code.scrollWidth} wide inside ${state.code.clientWidth}`,
          at,
        ),
      );
    if (
      state.widestRight !== null &&
      state.widestRight > state.codeRight + EPSILON
    )
      failures.push(
        failure(
          "wrap-mode-line-escapes",
          `widest line ends at ${state.widestRight}, past ${state.codeRight}`,
          at,
        ),
      );
    if (state.line?.whiteSpace !== "pre-wrap")
      failures.push(
        failure(
          "wrap-mode-white-space",
          `lines are ${state.line?.whiteSpace}, expected pre-wrap`,
          at,
        ),
      );
    if (state.box.scrollHeight <= state.box.clientHeight + 1)
      failures.push(
        failure(
          "wrap-mode-no-vertical-scroll",
          `the 70vh box is ${state.box.scrollHeight} inside ${state.box.clientHeight}; nothing to scroll`,
          at,
        ),
      );
  }
  // Against the width this page already had before any dialog opened, not
  // against the viewport: whatever the issue page does on its own at 390px
  // is another card's business, and this one only has to not add to it.
  if (state.docScrollWidth > baselineWidth + EPSILON)
    failures.push(
      failure(
        "page-widened",
        `document scrolls to ${state.docScrollWidth}, was ${baselineWidth} before the dialog`,
        at,
      ),
    );
  if (state.dialogRect && state.dialogRect.right > state.innerWidth + EPSILON)
    failures.push(
      failure(
        "dialog-widened",
        `dialog ends at ${state.dialogRect.right} in a ${state.innerWidth} viewport`,
        at,
      ),
    );
  return failures;
}

function checkHeader(layout, wrap, viewport, entry) {
  const failures = [];
  const at = { viewport: viewport.name, wrap, entry };
  if (layout.error) return [failure("dialog-never-opened", layout.error, at)];
  for (const [name, part] of [
    ["title", layout.title],
    ["wrap", layout.button],
    ["close", layout.close],
  ]) {
    if (!part?.visible)
      failures.push(failure(`${name}-not-visible`, JSON.stringify(part), at));
  }
  if (layout.overlap)
    failures.push(
      failure(
        "wrap-overlaps-close",
        `${JSON.stringify(layout.button?.rect)} intersects ${JSON.stringify(layout.close?.rect)}`,
        at,
      ),
    );
  if (layout.button?.inScrollBox)
    failures.push(
      failure(
        "wrap-inside-scroll-area",
        "the toggle scrolls with the diff",
        at,
      ),
    );
  if (layout.button?.pressed !== String(wrap))
    failures.push(
      failure(
        "aria-pressed-wrong",
        `aria-pressed=${layout.button?.pressed}, expected ${wrap}`,
        at,
      ),
    );
  if (layout.button?.label !== "wrap long lines")
    failures.push(
      failure("aria-label-wrong", String(layout.button?.label), at),
    );
  if (layout.button?.type !== "button")
    failures.push(
      failure("button-type-wrong", String(layout.button?.type), at),
    );
  if (
    layout.button?.title !== "Wrap long lines instead of scrolling horizontally"
  )
    failures.push(
      failure("title-attr-wrong", String(layout.button?.title), at),
    );
  if (!layout.button?.icon || layout.button?.text !== "wrap")
    failures.push(
      failure(
        "wrap-pill-shape",
        `icon=${layout.button?.icon} text=${JSON.stringify(layout.button?.text)}`,
        at,
      ),
    );
  if (!layout.focus?.focused || !layout.focus?.focusVisible)
    failures.push(failure("focus-not-taken", JSON.stringify(layout.focus), at));
  if (layout.focus?.outlineStyle === "none")
    failures.push(
      failure("focus-not-visible", JSON.stringify(layout.focus), at),
    );
  if (
    !layout.fileHeader?.text?.includes(
      entry === "description" ? "description.md" : "comment.md",
    )
  )
    failures.push(
      failure("file-header-missing", JSON.stringify(layout.fileHeader), at),
    );
  if (!layout.fileHeader?.additions || !layout.fileHeader?.deletions)
    failures.push(
      failure("diff-stats-missing", JSON.stringify(layout.fileHeader), at),
    );
  if (layout.viewport.width !== viewport.width)
    failures.push(
      failure(
        "viewport-not-applied",
        `innerWidth ${layout.viewport.width} ≠ ${viewport.width}`,
        at,
      ),
    );
  return failures;
}

function compareProse(before, after, viewport, phase) {
  const failures = [];
  const at = { viewport: viewport.name, phase };
  if (before.error || after.error)
    return [
      failure(
        "prose-fixture-missing",
        `${before.error ?? ""} ${after.error ?? ""}`.trim(),
        at,
      ),
    ];
  if (before.count !== after.count || before.count === 0)
    return [
      failure(
        "prose-fixture-missing",
        `markdown bodies ${before.count} → ${after.count}`,
        at,
      ),
    ];
  if (before.fences.length === 0)
    return [failure("prose-fixture-missing", "no code fence rendered", at)];
  const near = (a, b) => Math.abs(a - b) <= EPSILON;
  before.bodies.forEach((b, index) => {
    const a = after.bodies[index];
    for (const key of ["whiteSpace", "overflowX", "wordBreak"]) {
      if (b[key] !== a[key])
        failures.push(
          failure(`prose-${key}-changed`, `${b[key]} → ${a[key]}`, at),
        );
    }
    if (!near(b.rect.w, a.rect.w) || !near(b.rect.h, a.rect.h))
      failures.push(
        failure(
          "prose-geometry-changed",
          `${JSON.stringify(b.rect)} → ${JSON.stringify(a.rect)}`,
          at,
        ),
      );
    if (
      b.text !== a.text ||
      JSON.stringify(b.logicalLines) !== JSON.stringify(a.logicalLines)
    )
      failures.push(failure("prose-text-changed", `${b.text} → ${a.text}`, at));
  });
  before.fences.forEach((b, index) => {
    const a = after.fences[index];
    if (!a) {
      failures.push(failure("fence-disappeared", `fence ${index}`, at));
      return;
    }
    if (b.line?.whiteSpace !== a.line?.whiteSpace)
      failures.push(
        failure(
          "fence-white-space-changed",
          `${b.line?.whiteSpace} → ${a.line?.whiteSpace}`,
          at,
        ),
      );
    if (b.code?.overflowX !== a.code?.overflowX)
      failures.push(
        failure(
          "fence-overflow-changed",
          `${b.code?.overflowX} → ${a.code?.overflowX}`,
          at,
        ),
      );
    if (!near(b.rect.w, a.rect.w) || !near(b.rect.h, a.rect.h))
      failures.push(
        failure(
          "fence-geometry-changed",
          `${JSON.stringify(b.rect)} → ${JSON.stringify(a.rect)}`,
          at,
        ),
      );
  });
  return failures;
}

/** Both the description and the comment have to be on screen and edited. */
async function waitForIssuePage(page) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const ready = await evaluate(page, () => ({
      bodies: document.querySelectorAll(".markdown-body").length,
      markers: [...document.querySelectorAll("button")].filter(
        (button) => button.textContent === "(edited)",
      ).length,
    })).catch(() => ({ bodies: 0, markers: 0 }));
    if (ready.bodies >= 2 && ready.markers >= 2) {
      await sleep(300);
      return ready;
    }
    await sleep(100);
  }
  return null;
}

async function openPage(browser, context, stack, fixture, fault, viewport) {
  const page = await browser.newPage({
    context,
    cookie: fixture.cookie,
    scripts: [probeSource(fault)],
  });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.navigate(
    `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`,
  );
  await waitForIssuePage(page);
  return page;
}

async function runPass({ browser, stack, fixture, fault, label }) {
  const failures = [];
  const notes = {
    fault: fault ?? null,
    faultApplied: null,
    wheel: [],
    touch: [],
  };
  const context = await browser.newContext();
  await browser.send("Browser.grantPermissions", {
    browserContextId: context.browserContextId,
    origin: stack.webUrl,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  try {
    for (const viewport of VIEWPORTS) {
      const page = await openPage(
        browser,
        context,
        stack,
        fixture,
        fault,
        viewport,
      );
      try {
        // The spec diff's own saved choice, deliberately the opposite, so a
        // shared key would show up as the wrong opening mode below.
        await evaluate(page, () => window.__t425.setSpecWrap("off"));
        const proseBefore = await evaluate(page, () => window.__t425.prose());
        const baselineWidth = await evaluate(
          page,
          () => document.documentElement.scrollWidth,
        );
        // Taken before any dialog opens, because the lock's own `overflow:
        // hidden` makes the same measurement meaningless afterwards.
        const baselineHeight = (
          await evaluate(page, () => window.__t425.pageScroll())
        ).max;
        for (const entry of ["description", "comment"]) {
          const opened = await evaluate(
            page,
            (which) => window.__t425.openEntry(which),
            entry,
          );
          if (!opened.ok) {
            failures.push(
              failure("dialog-never-opened", JSON.stringify(opened), {
                viewport: viewport.name,
                entry,
              }),
            );
            continue;
          }
          if (fault && notes.faultApplied === null)
            notes.faultApplied = await evaluate(
              page,
              () => window.__t425.faultApplied,
            );
          // wrap on (the default) → off → on again.
          for (const wrap of [true, false, true]) {
            if (
              (await evaluate(page, () => window.__t425.pressed())) !==
              String(wrap)
            ) {
              const toggled = await evaluate(page, () =>
                window.__t425.toggleWrap("click"),
              );
              if (toggled.after !== String(wrap))
                failures.push(
                  failure("toggle-did-not-take", JSON.stringify(toggled), {
                    viewport: viewport.name,
                    entry,
                    wrap,
                  }),
                );
              // The options object changes identity on every toggle. pierre
              // is supposed to reconfigure the element it already has; a
              // remount would throw the rendered diff away and rebuild it.
              if (toggled.sameContainer === false)
                failures.push(
                  failure(
                    "diff-remounted-on-toggle",
                    "the diffs-container was replaced rather than updated",
                    { viewport: viewport.name, entry, wrap },
                  ),
                );
            }
            await evaluate(page, () => window.__t425.settle());
            failures.push(
              ...checkHeader(
                await evaluate(page, () => window.__t425.headerLayout()),
                wrap,
                viewport,
                entry,
              ),
            );
            failures.push(
              ...checkLineNumbers(
                await evaluate(page, () => window.__t425.lineNumbers()),
                wrap,
                viewport,
              ),
            );
            const state = await evaluate(page, () =>
              window.__t425.scrollState(),
            );
            const scrolled = wrap
              ? await evaluate(page, () => window.__t425.scrollBoxToBottom())
              : await scrollCodeToEnd(page);
            failures.push(
              ...checkScroll(state, scrolled, wrap, viewport, baselineWidth),
            );
            if (!wrap) {
              const wheel = await probeWheel(page);
              notes.wheel.push({ viewport: viewport.name, entry, ...wheel });
              failures.push(
                ...checkWheel(wheel, viewport, entry, baselineHeight),
              );
              const touch = await probeTouch(page);
              notes.touch.push({ viewport: viewport.name, entry, ...touch });
              failures.push(
                ...checkTouch(touch, viewport, entry, baselineHeight),
              );
            }
            if (wrap && entry === "description") {
              for (const side of ["deletion", "addition"]) {
                failures.push(
                  ...checkCopy(
                    await copyRoundTrip(page, side, "within-line"),
                    side,
                    "within-line",
                    viewport,
                  ),
                );
                failures.push(
                  ...checkCopy(
                    await copyRoundTrip(page, side, "across-lines"),
                    side,
                    "across-lines",
                    viewport,
                  ),
                );
              }
            }
          }
          // Leave it off, so the reload and new-page checks have something
          // other than the default to prove.
          if ((await evaluate(page, () => window.__t425.pressed())) === "true")
            await evaluate(page, () => window.__t425.toggleWrap("click"));
          const keyboard = await runKeyboardChecks(page, viewport, entry);
          failures.push(...keyboard);
          await evaluate(page, () => window.__t425.closeDialog());
        }
        const proseAfter = await evaluate(page, () => window.__t425.prose());
        failures.push(
          ...compareProse(proseBefore, proseAfter, viewport, "after-dialogs"),
        );
        const storage = await evaluate(page, () => window.__t425.storage());
        if (storage.wrap !== "off")
          failures.push(
            failure("choice-not-saved", JSON.stringify(storage), {
              viewport: viewport.name,
            }),
          );
        if (storage.spec !== "off")
          failures.push(
            failure("spec-key-written", JSON.stringify(storage), {
              viewport: viewport.name,
            }),
          );
        failures.push(
          ...(await checkPersistence(
            browser,
            context,
            stack,
            fixture,
            fault,
            viewport,
            page,
          )),
        );
      } finally {
        await page.close().catch(() => {});
      }
    }
    if (fault && notes.faultApplied?.applied !== true)
      failures.push(
        failure("fault-not-confirmed", JSON.stringify(notes.faultApplied)),
      );
    return { name: `revision-history-wrap:${label}`, failures, notes };
  } finally {
    await context.close().catch(() => {});
  }
}

async function runKeyboardChecks(page, viewport, entry) {
  const failures = [];
  const at = { viewport: viewport.name, entry };
  for (const [key, options] of [
    [" ", { code: "Space", text: " " }],
    ["Enter", { code: "Enter", text: "\r" }],
  ]) {
    const before = await evaluate(page, () => window.__t425.pressed());
    if (!(await evaluate(page, () => window.__t425.focusWrap()))) {
      failures.push(failure("focus-not-taken", `before ${key}`, at));
      continue;
    }
    await pressKey(page, key, options);
    await sleep(200);
    const after = await evaluate(page, () => window.__t425.pressed());
    if (after === before)
      failures.push(
        failure("key-did-not-toggle", `${key}: still ${after}`, at),
      );
  }
  // Tab has to land somewhere that shows it did.
  await evaluate(page, () => window.__t425.focusWrap());
  await pressKey(page, "Tab", { code: "Tab" });
  await sleep(150);
  const moved = await evaluate(page, () => ({
    stillWrap:
      document.activeElement?.getAttribute?.("aria-label") ===
      "wrap long lines",
    tag: document.activeElement?.tagName ?? null,
  }));
  if (moved.stillWrap)
    failures.push(failure("tab-did-not-move", JSON.stringify(moved), at));
  return failures;
}

async function checkPersistence(
  browser,
  context,
  stack,
  fixture,
  fault,
  viewport,
  page,
) {
  const failures = [];
  const at = { viewport: viewport.name, phase: "persistence" };
  await page.navigate(
    `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`,
  );
  await waitForIssuePage(page);
  const reopened = await evaluate(
    page,
    (which) => window.__t425.openEntry(which),
    "description",
  );
  if (!reopened.ok)
    failures.push(failure("dialog-never-opened", JSON.stringify(reopened), at));
  else if ((await evaluate(page, () => window.__t425.pressed())) !== "false")
    failures.push(failure("reload-lost-the-choice", "opened wrapping", at));
  await evaluate(page, () => window.__t425.closeDialog());

  const sibling = await openPage(
    browser,
    context,
    stack,
    fixture,
    fault,
    viewport,
  );
  try {
    const opened = await evaluate(
      sibling,
      (which) => window.__t425.openEntry(which),
      "description",
    );
    if (!opened.ok)
      failures.push(
        failure("dialog-never-opened", JSON.stringify(opened), {
          ...at,
          page: "same-context",
        }),
      );
    else if (
      (await evaluate(sibling, () => window.__t425.pressed())) !== "false"
    )
      failures.push(failure("new-page-lost-the-choice", "opened wrapping", at));
  } finally {
    await sibling.close().catch(() => {});
  }

  // A context of its own: no saved value anywhere, so it must open wrapping.
  const fresh = await browser.newContext();
  try {
    const freshPage = await openPage(
      browser,
      fresh,
      stack,
      fixture,
      fault,
      viewport,
    );
    try {
      await evaluate(
        freshPage,
        (value) => window.__t425.setTheme(value),
        "dark",
      );
      await freshPage.navigate(
        `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`,
      );
      await waitForIssuePage(freshPage);
      const opened = await evaluate(
        freshPage,
        (which) => window.__t425.openEntry(which),
        "description",
      );
      if (!opened.ok)
        failures.push(
          failure("dialog-never-opened", JSON.stringify(opened), {
            ...at,
            page: "fresh-context",
          }),
        );
      else {
        if (
          (await evaluate(freshPage, () => window.__t425.pressed())) !== "true"
        )
          failures.push(
            failure("fresh-context-not-default-on", "opened scrolling", at),
          );
        // Dark theme: the pressed pill and its focus ring still have to show.
        const layout = await evaluate(freshPage, () =>
          window.__t425.headerLayout(),
        );
        failures.push(
          ...checkHeader(layout, true, viewport, "description").map(
            (entry) => ({
              ...entry,
              theme: "dark",
            }),
          ),
        );
      }
    } finally {
      await freshPage.close().catch(() => {});
    }
  } finally {
    await fresh.close().catch(() => {});
  }
  return failures;
}

const FAULTS = [
  { fault: "gutter-unshared-rows", expect: "line-number-misaligned" },
  { fault: "copy-inserts-breaks", expect: "copy-text-differs" },
  { fault: "scroll-clipped", expect: "horizontal-scroll-blocked" },
  { fault: "scroll-hidden", expect: "scroll-mode-overflow-style" },
  { fault: "wrap-over-close", expect: "wrap-overlaps-close" },
  { fault: "prose-rewrapped", expect: "prose-whiteSpace-changed" },
  { fault: "wheel-release-disabled", expect: "horizontal-wheel-blocked" },
  { fault: "touch-release-disabled", expect: "horizontal-touch-blocked" },
  { fault: "scroll-lock-removed", expect: "page-scrolled-behind-dialog" },
];

function isCoverageFailure(entry) {
  return COVERAGE_FAILURES.has(entry.name);
}

async function runSelfTest(options) {
  const passes = [];
  const failures = [];
  const baseline = await runPass({
    ...options,
    fault: null,
    label: "baseline",
  });
  passes.push(baseline);
  if (baseline.failures.length)
    failures.push(
      failure(
        "self-test-baseline-not-clean",
        `a dirty baseline cannot prove anything: ${baseline.failures
          .map((entry) => entry.name)
          .join(", ")}`,
      ),
    );
  const baselineNames = new Set(baseline.failures.map((entry) => entry.name));
  for (const { fault, expect } of FAULTS) {
    const pass = await runPass({ ...options, fault, label: fault });
    passes.push(pass);
    const names = new Set(pass.failures.map((entry) => entry.name));
    if (pass.failures.some((entry) => entry.name === "fault-not-confirmed"))
      failures.push(
        failure("fault-not-confirmed", `${fault} was not applied to the page`),
      );
    else if (!names.has(expect) || baselineNames.has(expect))
      failures.push(
        failure(
          "self-test-no-new-failure",
          `${fault} was expected to produce ${expect}; got ${[...names].join(", ") || "nothing"}`,
        ),
      );
  }
  const restored = await runPass({
    ...options,
    fault: null,
    label: "restored",
  });
  passes.push(restored);
  if (restored.failures.length)
    failures.push(
      failure(
        "self-test-fresh-restoration",
        `a clean rerun after the faults failed: ${restored.failures
          .map((entry) => entry.name)
          .join(", ")}`,
      ),
    );
  return { passes, failures };
}

function parseArgs(argv) {
  const options = { selfTest: false, keep: false, help: false };
  for (const arg of argv) {
    if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`revision-history-wrap-smoke: ${error.message}\nTry --help.`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const startedAt = Date.now();
  let stack;
  let browser;
  let exitCode = 0;
  let passes = [];
  const failures = [];
  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "revision-history-wrap-smoke-",
      keep: options.keep,
    });
    browser = await startBrowser({
      dir: stack.dir,
      chromium: stack.chromium,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());
    const fixture = await seedFixture(stack.serverPort);
    failures.push(...fixtureShapeFailures(fixture));
    const context = { browser, stack, fixture };
    if (failures.length === 0) {
      if (options.selfTest) {
        const result = await runSelfTest(context);
        passes = result.passes;
        failures.push(...result.failures);
      } else {
        const pass = await runPass({ ...context, fault: null, label: "clean" });
        passes = [pass];
        failures.push(...pass.failures);
      }
    }
    exitCode =
      failures.length === 0 ? 0 : failures.some(isCoverageFailure) ? 2 : 1;
    if (exitCode !== 0 && !options.keep)
      stack.keep = {
        remove: ["attachments", "chrome", "db"],
        message: `kept failure artifacts: ${stack.dir}`,
      };
  } catch (error) {
    exitCode = 2;
    failures.push(failure("case-exception", error.stack ?? String(error)));
    if (stack && !options.keep)
      stack.keep = {
        remove: ["attachments", "chrome", "db"],
        message: `kept failure artifacts: ${stack.dir}`,
      };
  } finally {
    if (stack) {
      try {
        await stack.cleanup();
      } catch (error) {
        exitCode = 2;
        console.error(
          `revision-history-wrap-smoke cleanup: ${error.stack ?? error}`,
        );
      }
    }
  }
  const report = {
    name: "revision-history-wrap-smoke",
    mode: options.selfTest ? "self-test" : "clean",
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    versions: stack?.versions ?? null,
    timings: stack?.timings ?? { totalMs: Date.now() - startedAt },
    failures,
    passes: passes.map((pass) => ({
      name: pass.name,
      notes: pass.notes,
      failures: pass.failures,
    })),
  };
  console.log(`REPORT ${JSON.stringify(report)}`);
  if (stack?.dir && existsSync(stack.dir))
    writeFileSync(
      join(stack.dir, "revision-history-wrap-smoke-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return exitCode;
}

process.exitCode = await main();
