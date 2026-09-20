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
  "no-second-finger",
  "no-drag-room",
  "page-cannot-scroll",
  "page-not-at-top",
  "page-no-downward-room",
  "scroll-box-not-at-bottom",
  "gesture-fixture-not-confirmed",
  "self-test-baseline-not-clean",
  "self-test-no-new-failure",
  "self-test-fresh-restoration",
  "self-test-checker-mismatch",
  "self-test-fault-matrix",
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
  const faults = new Set((FAULT ?? '').split('+'));
  const hasFault = name => faults.has(name);
  let gestureRoot = null;
  let gestureStage = null;
  let secondFingerVerify = null;
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
  const shadow = () => gestureRoot ?? container()?.shadowRoot ?? null;
  const wrapButton = () => dialog()?.querySelector('button[aria-label="wrap long lines"]') ?? null;
  const scrollBox = () => dialog()?.querySelector('.overflow-auto') ?? null;
  const boxState = () => {
    const box = scrollBox();
    if (!box) return { error: 'no box' };
    const max = box.scrollHeight - box.clientHeight;
    return { scrollTop: round(box.scrollTop), max,
      atBottom: max > 0 && Math.abs(max - box.scrollTop) <= 1,
      clientHeight: box.clientHeight, scrollHeight: box.scrollHeight, rect: rectOf(box) };
  };
  // Clip against every scrolling ancestor, not the centre of the tall code.
  // Coordinates remain on actual visible code at the scroll box's bottom.
  const visibleCode = () => {
    const code = shadow()?.querySelector('[data-code]');
    if (!code) return null;
    const r = code.getBoundingClientRect();
    let left = Math.max(0, r.left + code.clientLeft);
    let right = Math.min(innerWidth, r.left + code.clientLeft + code.clientWidth);
    let top = Math.max(0, r.top + code.clientTop);
    let bottom = Math.min(innerHeight, r.top + code.clientTop + code.clientHeight);
    for (let node = code; node; node = node.parentElement ?? node.getRootNode().host) {
      const cs = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY)) {
        top = Math.max(top, rect.top + node.clientTop);
        bottom = Math.min(bottom, rect.top + node.clientTop + node.clientHeight);
      }
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) {
        left = Math.max(left, rect.left + node.clientLeft);
        right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
      }
    }
    return { left: round(left), right: round(right), top: round(top), bottom: round(bottom),
      w: round(Math.max(0, right - left)), h: round(Math.max(0, bottom - top)) };
  };
  const restoreStyle = (node, value) => {
    if (value === null) node.removeAttribute('style');
    else node.setAttribute('style', value);
  };
  // Chromium can materialize style="" after removing the last declaration.
  // Compare declarations, while still requiring every nonempty original verbatim.
  const sameStyle = (node, value) => (node.getAttribute('style') ?? '') === (value ?? '');
  const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise(r => requestAnimationFrame(r)); };

  const applyFault = () => {
    if (!FAULT) return { applied: false };
    const s = shadow();
    if (FAULT === 'gutter-unshared-rows') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      s.querySelector('style[data-t425-fault]')?.remove();
      const style = document.createElement('style');
      style.dataset.t425Fault = FAULT;
      // Take the gutter off the shared subgrid: every number falls back to
      // one text line while the content rows still grow with the wrapping.
      style.textContent = '[data-gutter]{display:block !important;grid-template-rows:none !important}[data-column-number]{height:20px !important;display:block !important}';
      s.appendChild(style);
      const gutters = [...s.querySelectorAll('[data-gutter]')];
      return { applied: gutters.length > 0 && gutters.every(node =>
        getComputedStyle(node).display === 'block'), gutters: gutters.length };
    }
    if (FAULT === 'copy-inserts-breaks') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      const existing = s.querySelectorAll('br[data-t425-fault]');
      if (existing.length) return { applied: true, touched: existing.length };
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
          const br = document.createElement('br');
          br.dataset.t425Fault = FAULT;
          tail.parentNode.insertBefore(br, tail);
          touched += 1;
        }
      }
      return { applied: touched > 0, touched };
    }
    if (FAULT === 'scroll-clipped' || FAULT === 'scroll-hidden') {
      if (!s) return { applied: false, reason: 'no shadow root' };
      s.querySelector('style[data-t425-fault]')?.remove();
      const style = document.createElement('style');
      style.dataset.t425Fault = FAULT;
      // Two different ways to "solve" a long line by not showing it: clip
      // refuses to scroll at all, while hidden still scrolls under script
      // but takes the scrollbar away from the reader.
      style.textContent = FAULT === 'scroll-clipped'
        ? '[data-code]{overflow-x:clip !important}'
        : '[data-code]{overflow-x:hidden !important}';
      s.appendChild(style);
      const code = s.querySelector('[data-code]');
      const overflowX = code && getComputedStyle(code).overflowX;
      return { applied: overflowX === (FAULT === 'scroll-clipped' ? 'clip' : 'hidden'), overflowX };
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
    if (hasFault('touch-release-disabled')) {
      // The touchmove half of what dialog.tsx added, taken away again. Kept
      // apart from the wheel fault so that each gesture's release is graded
      // by a fault only it can feel.
      Object.defineProperty(TouchEvent.prototype, 'stopPropagation',
        { value() {}, configurable: true, writable: true });
      const probe = new TouchEvent('touchmove');
      probe.stopPropagation();
      return { applied: probe.cancelBubble === false };
    }
    if (hasFault('second-finger-drops-origin')) {
      // What dialog.tsx used to do, put back: a touchstart carrying anything
      // other than one finger dropped the drag's origin, and only a fresh
      // touchstart ever wrote it again, so the release stood down for the rest
      // of the gesture. Reproduced here as the effect rather than the field —
      // capture on document runs before React's own listener, so neutering
      // stopPropagation on the event leaves the release running and useless,
      // exactly as an absent origin did.
      if (secondFingerVerify) return secondFingerVerify();
      let dropped = false;
      document.addEventListener('touchstart', event => {
        dropped = event.touches.length !== 1;
      }, { capture: true, passive: true });
      document.addEventListener('touchmove', event => {
        if (dropped)
          Object.defineProperty(event, 'stopPropagation',
            { value() {}, configurable: true });
      }, { capture: true, passive: true });
      secondFingerVerify = () => {
        const finger = target => new Touch({ identifier: 1, target });
        document.dispatchEvent(new TouchEvent('touchstart',
          { touches: [finger(document.body), new Touch({ identifier: 2, target: document.body })] }));
        const probe = new TouchEvent('touchmove', { touches: [finger(document.body)] });
        document.dispatchEvent(probe);
        probe.stopPropagation();
        const neutered = probe.cancelBubble === false;
        // Leave the page as a fresh single-finger gesture would find it.
        document.dispatchEvent(new TouchEvent('touchstart', { touches: [finger(document.body)] }));
        return { applied: neutered && dropped === false, neutered, originReset: !dropped };
      };
      return secondFingerVerify();
    }
    if (FAULT === 'scroll-lock-removed') {
      // Both halves of the modal lock, for both gestures: the events it
      // cancels, and the overflow it takes off the body. An inline !important
      // is the one declaration that outranks the stylesheet the lock injects.
      for (const constructor of [WheelEvent, TouchEvent])
        Object.defineProperty(constructor.prototype, 'preventDefault',
          { value() {}, configurable: true, writable: true });
      for (const node of [document.documentElement, document.body]) {
        node.style.setProperty('overflow', 'auto', 'important');
        node.style.setProperty('overscroll-behavior', 'auto', 'important');
      }
      const wheel = new WheelEvent('wheel', { cancelable: true });
      wheel.preventDefault();
      const touch = new TouchEvent('touchmove', { cancelable: true });
      touch.preventDefault();
      const css = [document.documentElement, document.body].map(node => ({
        overflowY: getComputedStyle(node).overflowY,
        overscrollY: getComputedStyle(node).overscrollBehaviorY,
      }));
      return { applied: wheel.defaultPrevented === false &&
        touch.defaultPrevented === false &&
        css.every(style => style.overflowY === 'auto' && style.overscrollY === 'auto'), css };
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
    if (hasFault('touch-short-vertical') || hasFault('wheel-not-retargeted') ||
        hasFault('touch-not-retargeted'))
      return { applied: false, deferred: true, reason: 'measured during gesture stage' };
    return { applied: false, reason: 'unknown fault' };
  };

  window.__t425 = {
    applyFault,
    boxState,
    prepareGesture: async gesture => {
      if (gestureStage) throw new Error('gesture stage already active');
      const box = scrollBox(), host = container(), root = host?.shadowRoot;
      if (!box || !root?.querySelector('[data-code]'))
        return { applied: false, error: 'no real diff or scroll box' };
      const spacer = document.createElement('div');
      spacer.dataset.t425GestureSpacer = '';
      spacer.style.cssText = 'height:' + Math.max(innerHeight * 2, box.clientHeight * 3) +
        'px;min-height:1px;flex-shrink:0;pointer-events:none';
      const short = gesture === 'touch' && hasFault('touch-short-vertical');
      const light = hasFault(gesture + '-not-retargeted');
      gestureStage = { box, host, root, spacer, boxStyle: box.getAttribute('style'),
        hostStyle: host.getAttribute('style'), scrollTop: box.scrollTop,
        scrollLeft: root.querySelector('[data-code]').scrollLeft, styled: [], nodes: [] };
      // Keep the temporary clipping height integral so the bottom measurement
      // and the visible gesture rectangle use the same pixel boundary.
      const maxHeight = Number.parseFloat(getComputedStyle(box).maxHeight);
      if (Number.isFinite(maxHeight))
        box.style.setProperty('max-height', Math.floor(maxHeight) + 'px', 'important');
      box.prepend(spacer);
      if (light) {
        // Move the real rendered nodes, keeping their text and computed styles.
        // A sibling in light DOM exposes the actual scroller to remove-scroll;
        // leaving children under a slot-less shadow host would make them invisible.
        const wrapper = document.createElement('div');
        wrapper.dataset.t425LightDiff = '';
        const elements = [host, ...root.querySelectorAll('*')].filter(node => node.tagName !== 'STYLE');
        const computed = elements.map(node => {
          const cs = getComputedStyle(node);
          return { node, css: [...cs].map(name => [name, cs.getPropertyValue(name)]) };
        });
        gestureStage.nodes = [...root.childNodes];
        gestureStage.wrapper = wrapper;
        host.after(wrapper);
        for (const { node, css } of computed) {
          const target = node === host ? wrapper : node;
          if (node !== host) gestureStage.styled.push([node, node.getAttribute('style')]);
          for (const [name, value] of css) target.style.setProperty(name, value, 'important');
        }
        for (const node of gestureStage.nodes)
          if (node.nodeName !== 'STYLE') wrapper.append(node);
        host.style.setProperty('display', 'none', 'important');
        gestureRoot = wrapper;
      }
      if (short) {
        // Compress the real clipping box in Y only. The horizontal drag and
        // overflow must remain measurable while the vertical path is <40px.
        for (const name of ['height', 'min-height', 'max-height'])
          box.style.setProperty(name, '48px', 'important');
        box.style.setProperty('flex', 'none', 'important');
      }
      await settle();
      const bottom = await window.__t425.scrollBoxToBottom();
      const horizontal = window.__t425.dragPath('h');
      const vertical = window.__t425.dragPath('v');
      const code = shadow().querySelector('[data-code]');
      const evidence = { gesture, short, light, box: bottom, visible: visibleCode(),
        horizontalDistance: horizontal.distance, verticalDistance: vertical.distance,
        codeMax: code.scrollWidth - code.clientWidth, overflowX: getComputedStyle(code).overflowX,
        lines: shadow().querySelectorAll('[data-line]').length,
        lightDOM: code.getRootNode() === document, spacerHeight: spacer.getBoundingClientRect().height };
      evidence.applied = bottom.atBottom && bottom.max > 0 &&
        (!short || (vertical.distance > 0 && vertical.distance < 40 && horizontal.distance >= 40)) &&
        (!light || (evidence.lightDOM && evidence.lines > 0 &&
          evidence.codeMax > 0 && /^(auto|scroll)$/.test(evidence.overflowX)));
      return evidence;
    },
    restoreGesture: async () => {
      const stage = gestureStage;
      if (!stage) return { restored: true };
      gestureRoot = null;
      for (const node of stage.nodes) stage.root.append(node);
      for (const [node, style] of stage.styled) restoreStyle(node, style);
      stage.wrapper?.remove();
      stage.spacer.remove();
      restoreStyle(stage.box, stage.boxStyle);
      restoreStyle(stage.host, stage.hostStyle);
      stage.box.scrollTop = stage.scrollTop;
      const code = stage.root.querySelector('[data-code]');
      if (code) code.scrollLeft = stage.scrollLeft;
      gestureStage = null;
      await settle();
      const originalOrder = stage.nodes.length === 0 ||
        (stage.root.childNodes.length === stage.nodes.length &&
          stage.nodes.every((node, index) => stage.root.childNodes[index] === node));
      return { restored: !!code && code.getRootNode() === stage.root && originalOrder &&
        sameStyle(stage.box, stage.boxStyle) &&
        sameStyle(stage.host, stage.hostStyle) &&
        stage.styled.every(([node, style]) => sameStyle(node, style)) &&
        !document.querySelector('[data-t425-gesture-spacer],[data-t425-light-diff]'),
        originalOrder, box: boxState(), codeScrollLeft: code?.scrollLeft ?? null };
    },
    faultApplied: null,
    openEntry: async (which) => {
      const marks = [...document.querySelectorAll('button')].filter(b => b.textContent === '(edited)');
      const mark = which === 'description' ? marks[0] : marks[marks.length - 1];
      if (!mark) return { ok: false, reason: 'no (edited) marker', markers: marks.length };
      // Set this before the modal lock can clamp window.scrollTo. Opening the
      // popover programmatically does not need its trigger scrolled into view.
      window.scrollTo(0, 0);
      await settle();
      window.__t425.unlockedPage = window.__t425.pageScroll();
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
          window.__t425.faultApplied = applyFault();
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
    touchPhases: [],
    // The same two-listener split as watchWheel, for the same reason: a
    // released touchmove never reaches the bubbling listener where
    // defaultPrevented is final, so only the capturing count can say it came.
    watchTouch: () => {
      window.__t425.touchSeen = [];
      window.__t425.touchSettled = [];
      window.__t425.touchPhases = [];
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
      // How many fingers the page saw, and when. A drag that was supposed to
      // gain one and lose it again is graded on what dialog.tsx does *after*
      // that, so a run where the extra finger never landed has to say so
      // rather than pass (T-490).
      for (const type of ['touchstart', 'touchend', 'touchcancel'])
        window.addEventListener(type, event => {
          window.__t425.touchPhases.push({ type, touches: event.touches.length,
            changed: event.changedTouches.length });
        }, { passive: true, capture: true });
      return true;
    },
    touchEvents: () => window.__t425.touchSeen,
    touchVerdicts: () => window.__t425.touchSettled,
    touchPhaseLog: () => window.__t425.touchPhases,
    /**
     * Both paths stay in the visible intersection with the real scroll box.
     * At its bottom the finger moves UP to ask for more DOWNWARD content
     * scroll, just like the wheel's negative CDP yDistance.
     */
    dragPath: axis => {
      const r = visibleCode();
      if (!r || r.w <= 0 || r.h <= 0) return { error: 'no visible code' };
      const mid = { x: round((r.left + r.right) / 2), y: round((r.top + r.bottom) / 2) };
      if (axis === 'h') {
        const inset = Math.min(8, r.w / 4);
        const from = { x: round(r.right - inset), y: mid.y };
        const to = { x: round(r.left + inset), y: mid.y };
        return { from, to, distance: round(from.x - to.x), visible: r };
      }
      const inset = Math.min(8, r.h / 4);
      // Start above the EOF marker/scrollbar edge when there is room.
      const bottomInset = r.h >= 96 ? 48 : inset;
      const room = Math.max(0, Math.min(240, r.h - inset - bottomInset));
      const from = { x: mid.x, y: round(r.bottom - bottomInset) };
      return { from, to: { x: mid.x, y: round(from.y - room) }, distance: round(room), visible: r };
    },
    pageScroll: () => ({
      y: Math.round(window.scrollY),
      max: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      unlockedMax: window.__t425.unlockedPage?.max ?? null,
    }),
    // Before opening, openEntry already parks at zero without a lock. Repeat
    // for every segment: the lock-removal fault lets the previous one move it.
    parkPageAtTop: async () => {
      window.scrollTo(0, 0);
      await settle();
      return window.__t425.pageScroll();
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
        visible: visibleCode(),
        lightDOM: code.getRootNode() === document,
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
      return boxState();
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
 *
 * `interlude` drops a second finger onto the glass and lifts it again without
 * the first ever leaving, which is the gesture T-490 is about. It goes in
 * before the drag has travelled Chromium's slop distance, and that placement is
 * the whole difference between a graded check and a decorative one: once the
 * compositor is scrolling it stops asking, so every touchmove after that point
 * is uncancelable and the scroll arrives whether the release ran or not. The
 * first measured attempt put the extra finger halfway along, and the fault that
 * removes the release produced no failure at all there. The finger that is
 * already down still makes one sub-slop move first, so this is a gesture the
 * bookkeeping has already seen rather than a fresh touchstart.
 *
 * `Input.dispatchTouchEvent`'s `touchEnd` takes the points that *lift*, not the
 * ones that stay: measured here, listing the remaining finger ends that finger
 * and turns the drag's next move into a fresh `touchstart`, which would grade
 * something else entirely.
 */
async function dragOver(
  page,
  from,
  to,
  { steps = 20, interlude = false } = {},
) {
  await evaluate(page, () => window.__t425.watchTouch());
  const at = (step) => ({
    x: Math.round(from.x + ((to.x - from.x) * step) / steps),
    y: Math.round(from.y + ((to.y - from.y) * step) / steps),
    id: 1,
  });
  await page.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [at(0)],
  });
  if (interlude) {
    const towards = (axis) => Math.sign(to[axis] - from[axis]) * 4;
    const nudged = {
      x: from.x + towards("x"),
      y: from.y + towards("y"),
      id: 1,
    };
    await page.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [nudged],
    });
    await sleep(16);
    // Stay inside the same visible row even when the real box is compressed.
    const second = { x: nudged.x - 12, y: nudged.y, id: 2 };
    await page.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [nudged, second],
    });
    await sleep(16);
    await page.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [second],
    });
    await sleep(16);
  }
  for (let step = 1; step <= steps; step += 1) {
    await page.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [at(step)],
    });
    await sleep(16);
  }
  // Empty lifts whatever is left, one `touchend` per finger.
  await page.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await sleep(300);
  return {
    arrived: await evaluate(page, () => window.__t425.touchEvents()),
    settled: await evaluate(page, () => window.__t425.touchVerdicts()),
    phases: await evaluate(page, () => window.__t425.touchPhaseLog()),
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
 * verdict is `scrollLeft`, not a cancellation count, while an upward finger
 * at the box's bottom asks for downward overscroll that the lock must cancel.
 *
 * The sideways drag is made twice. The second one gains a finger and loses it
 * mid-gesture (T-490), which used to leave the rest of that drag with no origin
 * to subtract and so no release at all; the plain one beside it is what tells
 * a regression in the release apart from a regression in that bookkeeping. The
 * cancelability rule above is why the extra finger arrives before the drag has
 * travelled far enough to start a scroll — see `dragOver`.
 */
async function probeTouch(page) {
  const result = {};
  // At 390px, a preceding horizontal touch suppressed unlocked page travel
  // despite touchEnd; a fresh vertical touch and wheel-then-touch both scroll.
  // Grade it first, keeping the plain horizontal drag as regrip's control.
  for (const phase of ["vertical", "horizontal", "regrip"]) {
    const segment = await probeGestureSegment(page, "touch", phase);
    result[phase] = segment;
  }
  result.target = result.horizontal.target;
  return result;
}

async function probeGestureSegment(page, gesture, phase) {
  await evaluate(page, () => window.__t425.parkPageAtTop());
  await evaluate(page, () => window.__t425.resetCodeScroll());
  const box = await evaluate(page, () => window.__t425.scrollBoxToBottom());
  const start = await evaluate(page, () => window.__t425.codeScroll());
  const path = await evaluate(
    page,
    (axis) => window.__t425.dragPath(axis),
    phase === "vertical" ? "v" : "h",
  );
  if (start.error || path.error) return { error: start.error ?? path.error };
  const target = await evaluate(
    page,
    (x, y) => window.__t425.pointTarget(x, y),
    path.from.x,
    path.from.y,
  );
  const pageBefore = await evaluate(page, () => window.__t425.pageScroll());
  const events =
    gesture === "touch"
      ? await dragOver(page, path.from, path.to, {
          interlude: phase === "regrip",
        })
      : await wheelOver(
          page,
          path.from.x,
          path.from.y,
          phase === "vertical" ? 0 : -600,
          phase === "vertical" ? -600 : 0,
        );
  const end = await evaluate(page, () => window.__t425.codeScroll());
  const pageAfter = await evaluate(page, () => window.__t425.pageScroll());
  const boxAfter = await evaluate(page, () => window.__t425.boxState());
  return {
    target,
    from: start.scrollLeft,
    to: end.scrollLeft,
    max: start.max,
    distance: gesture === "touch" ? path.distance : 600,
    path,
    start,
    end,
    arrived: events.arrived.length,
    retargeted:
      events.arrived.length > 0 &&
      events.arrived.every((event) => event.retargeted),
    unretargeted:
      events.arrived.length > 0 &&
      events.arrived.every((event) => event.retargeted === false),
    cancelled: events.settled.filter((event) => event.defaultPrevented).length,
    events,
    box,
    boxAfter,
    page: {
      before: pageBefore.y,
      after: pageAfter.y,
      max: pageBefore.max,
      unlockedMax: pageBefore.unlockedMax,
      afterMax: pageAfter.max,
    },
    ...(phase === "regrip"
      ? {
          secondFinger: events.phases.some(
            (event) => event.type === "touchstart" && event.touches === 2,
          ),
          liftedBackToOne: events.phases.some(
            (event) => event.type === "touchend" && event.touches === 1,
          ),
          phases: events.phases,
        }
      : {}),
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
 * could not have absorbed the gesture from either end. Negative CDP
 * yDistance scrolls content DOWN, beyond the bottom already reached; the
 * background page starts at its top with downward room for the lock to hold.
 */
async function probeWheel(page) {
  const horizontal = await probeGestureSegment(page, "wheel", "horizontal");
  const vertical = await probeGestureSegment(page, "wheel", "vertical");
  return {
    target: horizontal.target,
    scrollLocked: await evaluate(page, () =>
      document.body.hasAttribute("data-scroll-locked"),
    ),
    horizontal,
    vertical,
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
  return checkGesturePhases(result, viewport, entry, baselineHeight, "wheel");
}

/** The same pair of questions asked of a finger; see `probeTouch`. */
function checkTouch(result, viewport, entry, baselineHeight) {
  return checkGesturePhases(result, viewport, entry, baselineHeight, "touch");
}

/** Coverage gates only their own phase; missing vertical input cannot hide h/regrip. */
function checkGesturePhases(result, viewport, entry, baselineHeight, gesture) {
  const failures = [];
  const at = { viewport: viewport.name, entry, gesture };
  const phases =
    gesture === "touch"
      ? ["horizontal", "regrip", "vertical"]
      : ["horizontal", "vertical"];
  for (const phase of phases) {
    const sample = result[phase];
    const where = { ...at, phase };
    const coverage = (name, detail) =>
      failures.push(failure(name, detail, { ...where, coverage: true }));
    const before = failures.length;
    if (!sample || sample.error || result.error) {
      coverage(
        "no-scrolling-line",
        sample?.error ?? result.error ?? `missing ${phase}`,
      );
      continue;
    }
    if (!(sample.arrived > 0))
      coverage(
        `no-${gesture}-delivered`,
        `${sample.arrived ?? 0} events in ${phase}`,
      );
    if (gesture === "touch" && !(sample.distance >= 40))
      coverage(
        "no-drag-room",
        `${sample.distance ?? 0}px in ${phase}; need at least 40px`,
      );
    // Retargeting must be witnessed by this gesture's own delivered events.
    if (sample.arrived > 0 && sample.retargeted !== true)
      coverage(
        `${gesture}-target-not-retargeted`,
        `${phase} target ${JSON.stringify(sample.target ?? result.target)} was not retargeted`,
      );
    if (phase !== "vertical") {
      if (
        !Number.isFinite(sample.from) ||
        !Number.isFinite(sample.max) ||
        sample.from < 0 ||
        sample.max - sample.from < 1
      )
        coverage(
          "no-scrolling-line",
          `${phase} starts at ${sample.from} of ${sample.max}; less than 1px remains`,
        );
      if (
        phase === "regrip" &&
        (!sample.secondFinger || !sample.liftedBackToOne)
      )
        coverage(
          "no-second-finger",
          `interlude missing: ${JSON.stringify(sample.phases)}`,
        );
      if (failures.length === before && !(sample.to > sample.from))
        failures.push(
          failure(
            phase === "regrip"
              ? "horizontal-touch-blocked-after-second-finger"
              : `horizontal-${gesture}-blocked`,
            `scrollLeft ${sample.from} → ${sample.to} of ${sample.max}; ${sample.cancelled} of ${sample.arrived} events cancelled`,
            where,
          ),
        );
      continue;
    }
    const { box, page } = sample;
    for (const [moment, boundary] of [
      ["before", box],
      ["after", sample.boxAfter],
    ]) {
      if (
        boundary?.error ||
        !Number.isFinite(boundary?.max) ||
        !Number.isFinite(boundary?.scrollTop) ||
        boundary.max <= 0 ||
        boundary.scrollTop <= 0 ||
        boundary.atBottom !== true ||
        Math.abs(boundary.max - boundary.scrollTop) > EPSILON
      )
        coverage(
          "scroll-box-not-at-bottom",
          `need a real scrollable box at bottom ${moment} the gesture: ${JSON.stringify(boundary)}`,
        );
    }
    if (
      !Number.isFinite(baselineHeight) ||
      baselineHeight < 1 ||
      !Number.isFinite(page?.unlockedMax) ||
      page.unlockedMax <= 0 ||
      !Number.isFinite(page?.before) ||
      !Number.isFinite(page?.after)
    )
      coverage(
        "page-cannot-scroll",
        `baseline ${baselineHeight}; page ${JSON.stringify(page)}`,
      );
    if (Number.isFinite(page?.before) && page.before !== 0)
      coverage(
        "page-not-at-top",
        `downward scroll must start at page top: ${JSON.stringify(page)}`,
      );
    if (
      !Number.isFinite(page?.max) ||
      !Number.isFinite(page?.before) ||
      page.max - page.before < 1
    )
      coverage(
        "page-no-downward-room",
        `less than 1px of downward page room: ${JSON.stringify(page)}`,
      );
    // Both lock assertions need real input, a real boundary and downward page room.
    if (failures.length !== before) continue;
    if (sample.cancelled === 0)
      failures.push(
        failure(
          `vertical-${gesture}-not-cancelled`,
          `${sample.arrived} events, none cancelled; dialog ${JSON.stringify(box)}`,
          where,
        ),
      );
    if (page.after !== page.before)
      failures.push(
        failure(
          "page-scrolled-behind-dialog",
          `window.scrollY ${page.before} → ${page.after}`,
          where,
        ),
      );
  }
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
    faultApplied: [],
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
          const faultEvidence = {
            viewport: viewport.name,
            entry,
            opened: await evaluate(page, () => window.__t425.faultApplied),
            stages: [],
          };
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
            // pierre can rebuild its contents when wrap changes. Reapply the
            // DOM faults to this entry and measure each relevant mode anew.
            if (fault) {
              const injection = await evaluate(page, () =>
                window.__t425.applyFault(),
              );
              faultEvidence.stages.push({ wrap, ...injection });
            }
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
              ).map((item) => ({ ...item, entry })),
            );
            const state = await evaluate(page, () =>
              window.__t425.scrollState(),
            );
            const scrolled = wrap
              ? await evaluate(page, () => window.__t425.scrollBoxToBottom())
              : await scrollCodeToEnd(page);
            failures.push(
              ...checkScroll(
                state,
                scrolled,
                wrap,
                viewport,
                baselineWidth,
              ).map((item) => ({ ...item, entry })),
            );
            if (!wrap) {
              for (const gesture of ["wheel", "touch"]) {
                let fixture;
                try {
                  fixture = await evaluate(
                    page,
                    (kind) => window.__t425.prepareGesture(kind),
                    gesture,
                  );
                  const result =
                    gesture === "wheel"
                      ? await probeWheel(page)
                      : await probeTouch(page);
                  const phases =
                    gesture === "touch"
                      ? ["horizontal", "regrip", "vertical"]
                      : ["horizontal", "vertical"];
                  // Check the roots after every segment too: pierre may
                  // reclaim its pre during a render while the gesture runs.
                  fixture.afterLightDOM = await evaluate(
                    page,
                    () => window.__t425.codeScroll().lightDOM,
                  );
                  if (fixture.light) {
                    fixture.liveLightDOM =
                      phases.every(
                        (phase) =>
                          result[phase]?.start?.lightDOM === true &&
                          result[phase]?.end?.lightDOM === true &&
                          result[phase]?.unretargeted === true,
                      ) && fixture.afterLightDOM === true;
                    fixture.applied = fixture.applied && fixture.liveLightDOM;
                  }
                  notes[gesture].push({
                    viewport: viewport.name,
                    entry,
                    fixture,
                    ...result,
                  });
                  if (!fixture.applied)
                    failures.push(
                      failure(
                        "gesture-fixture-not-confirmed",
                        JSON.stringify(fixture),
                        { viewport: viewport.name, entry, gesture },
                      ),
                    );
                  failures.push(
                    ...(gesture === "wheel" ? checkWheel : checkTouch)(
                      result,
                      viewport,
                      entry,
                      baselineHeight,
                    ),
                  );
                  if (fixture.short || fixture.light)
                    faultEvidence.stages.push({ gesture, ...fixture });
                } finally {
                  const restored = await evaluate(page, () =>
                    window.__t425.restoreGesture(),
                  );
                  if (fixture) fixture.restoration = restored;
                  if (!restored.restored)
                    failures.push(
                      failure(
                        "gesture-fixture-not-confirmed",
                        "gesture DOM restoration failed",
                        { viewport: viewport.name, entry, gesture },
                      ),
                    );
                }
              }
            }
            if (wrap) {
              for (const side of ["deletion", "addition"]) {
                failures.push(
                  ...checkCopy(
                    await copyRoundTrip(page, side, "within-line"),
                    side,
                    "within-line",
                    viewport,
                  ).map((item) => ({ ...item, entry })),
                );
                failures.push(
                  ...checkCopy(
                    await copyRoundTrip(page, side, "across-lines"),
                    side,
                    "across-lines",
                    viewport,
                  ).map((item) => ({ ...item, entry })),
                );
              }
            }
          }
          if (fault) {
            const measured = faultEvidence.stages.filter(
              (stage) => !stage.deferred,
            );
            // The BR fault needs wrapped lines; its unwrapped stage is not
            // an injection opportunity. All other stages must confirm.
            const relevant = measured.filter(
              (stage) =>
                fault !== "copy-inserts-breaks" || stage.wrap !== false,
            );
            faultEvidence.applied =
              relevant.length > 0 &&
              relevant.every((stage) => stage.applied === true);
            notes.faultApplied.push(faultEvidence);
            if (!faultEvidence.applied)
              failures.push(
                failure("fault-not-confirmed", JSON.stringify(faultEvidence), {
                  viewport: viewport.name,
                  entry,
                }),
              );
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

// These signatures are handwritten oracles, never derived from checker output.
const WHEEL_BLOCKED = ["horizontal-wheel-blocked", "wheel", "horizontal"];
const TOUCH_BLOCKED = ["horizontal-touch-blocked", "touch", "horizontal"];
const REGRIP_BLOCKED = [
  "horizontal-touch-blocked-after-second-finger",
  "touch",
  "regrip",
];
const WHEEL_UNLOCKED = ["vertical-wheel-not-cancelled", "wheel", "vertical"];
const TOUCH_UNLOCKED = ["vertical-touch-not-cancelled", "touch", "vertical"];
const WHEEL_PAGE_MOVED = ["page-scrolled-behind-dialog", "wheel", "vertical"];
const TOUCH_PAGE_MOVED = ["page-scrolled-behind-dialog", "touch", "vertical"];
const VERTICAL_BEHAVIOR = [
  WHEEL_UNLOCKED,
  TOUCH_UNLOCKED,
  WHEEL_PAGE_MOVED,
  TOUCH_PAGE_MOVED,
];
const GESTURE_BEHAVIOR = [
  WHEEL_BLOCKED,
  TOUCH_BLOCKED,
  REGRIP_BLOCKED,
  ...VERTICAL_BEHAVIOR,
];
const SHORT_VERTICAL = ["no-drag-room", "touch", "vertical"];
const NO_VERTICAL_TOUCH = ["no-touch-delivered", "touch", "vertical"];
const WHEEL_LIGHT = [
  ["wheel-target-not-retargeted", "wheel", "horizontal"],
  ["wheel-target-not-retargeted", "wheel", "vertical"],
];
const TOUCH_LIGHT = [
  ["touch-target-not-retargeted", "touch", "horizontal"],
  ["touch-target-not-retargeted", "touch", "regrip"],
  ["touch-target-not-retargeted", "touch", "vertical"],
];

const FAULTS = [
  {
    fault: "gutter-unshared-rows",
    expected: [["line-number-misaligned"]],
    strict: false,
  },
  {
    fault: "copy-inserts-breaks",
    expected: [["copy-text-differs"]],
    strict: false,
  },
  {
    fault: "scroll-clipped",
    expected: [["horizontal-scroll-blocked"]],
    strict: false,
  },
  {
    fault: "scroll-hidden",
    expected: [["scroll-mode-overflow-style"]],
    strict: false,
  },
  {
    fault: "wrap-over-close",
    expected: [["wrap-overlaps-close"]],
    strict: false,
  },
  {
    fault: "prose-rewrapped",
    expected: [["prose-whiteSpace-changed"]],
    strict: false,
    scope: "viewport",
  },
  {
    fault: "wheel-release-disabled",
    expected: [WHEEL_BLOCKED],
    forbidden: [TOUCH_BLOCKED, REGRIP_BLOCKED, ...VERTICAL_BEHAVIOR],
  },
  {
    fault: "touch-release-disabled",
    expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
    forbidden: [WHEEL_BLOCKED, ...VERTICAL_BEHAVIOR],
  },
  {
    fault: "second-finger-drops-origin",
    expected: [REGRIP_BLOCKED],
    forbidden: [WHEEL_BLOCKED, TOUCH_BLOCKED, ...VERTICAL_BEHAVIOR],
    control: "plain-touch",
  },
  {
    fault: "scroll-lock-removed",
    expected: VERTICAL_BEHAVIOR,
    forbidden: [WHEEL_BLOCKED, TOUCH_BLOCKED, REGRIP_BLOCKED],
  },
  {
    fault: "touch-short-vertical",
    expected: [SHORT_VERTICAL],
    allowedCoverage: [SHORT_VERTICAL, NO_VERTICAL_TOUCH],
    forbidden: GESTURE_BEHAVIOR,
    short: true,
  },
  {
    fault: "touch-short-vertical+touch-release-disabled",
    expected: [SHORT_VERTICAL, TOUCH_BLOCKED, REGRIP_BLOCKED],
    allowedCoverage: [SHORT_VERTICAL, NO_VERTICAL_TOUCH],
    forbidden: [WHEEL_BLOCKED, ...VERTICAL_BEHAVIOR],
    short: true,
  },
  {
    fault: "touch-short-vertical+second-finger-drops-origin",
    expected: [SHORT_VERTICAL, REGRIP_BLOCKED],
    allowedCoverage: [SHORT_VERTICAL, NO_VERTICAL_TOUCH],
    forbidden: [WHEEL_BLOCKED, TOUCH_BLOCKED, ...VERTICAL_BEHAVIOR],
    short: true,
    control: "plain-touch",
  },
  {
    fault: "wheel-not-retargeted",
    expected: WHEEL_LIGHT,
    allowedCoverage: WHEEL_LIGHT,
    forbidden: GESTURE_BEHAVIOR,
    light: "wheel",
  },
  {
    fault: "touch-not-retargeted",
    expected: TOUCH_LIGHT,
    allowedCoverage: TOUCH_LIGHT,
    forbidden: GESTURE_BEHAVIOR,
    light: "touch",
  },
];

function isCoverageFailure(entry) {
  // A newly named prerequisite must remain coverage even before the registry
  // is updated. Strict fault matrices also reject every undeclared behavior.
  return entry.coverage === true || COVERAGE_FAILURES.has(entry.name);
}

async function runSelfTest(options) {
  const fixed = runFixedCheckerSelfTests();
  const passes = [fixed];
  const failures = [...fixed.failures];
  let passNumber = 0;
  const total = 1 + FAULTS.length * 2;
  const run = async (fault, label) => {
    const number = ++passNumber;
    console.error(`[self-test ${number}/${total}] start ${label}`);
    try {
      const pass = await runPass({ ...options, fault, label });
      passes.push(pass);
      console.error(
        `[self-test ${number}/${total}] end ${label}: ${pass.failures.length} findings`,
      );
      return pass;
    } catch (error) {
      console.error(`[self-test ${number}/${total}] end ${label}: exception`);
      const pass = {
        name: `revision-history-wrap:${label}`,
        failures: [failure("case-exception", error.stack ?? String(error))],
        notes: { fault, wheel: [], touch: [], faultApplied: [] },
      };
      passes.push(pass);
      return pass;
    }
  };
  const requireClean = (pass, name) => {
    const cells = [];
    for (const viewport of VIEWPORTS) {
      for (const entry of ["description", "comment"]) {
        const actual = pass.failures.filter(
          (item) =>
            (!item.viewport || item.viewport === viewport.name) &&
            (!item.entry || item.entry === entry),
        );
        const sampled = ["wheel", "touch"].every(
          (gesture) =>
            pass.notes?.[gesture]?.filter(
              (item) => item.viewport === viewport.name && item.entry === entry,
            ).length === 1,
        );
        cells.push({
          viewport: viewport.name,
          entry,
          status: actual.length === 0 && sampled ? "green" : "red",
          actual,
          sampled,
        });
      }
    }
    pass.notes ??= {};
    pass.notes.selfTestMatrix = cells;
    if (pass.failures.length || cells.some((cell) => cell.status === "red"))
      failures.push(
        failure(
          name,
          `${pass.name}: clean pass has failures or missing samples`,
          { matrix: cells, actual: pass.failures },
        ),
      );
  };
  const baseline = await run(null, "baseline");
  requireClean(baseline, "self-test-baseline-not-clean");
  for (const spec of FAULTS) {
    const pass = await run(spec.fault, spec.fault);
    const matrix = checkFaultMatrix(pass, spec);
    pass.notes ??= {};
    pass.notes.selfTestMatrix = matrix.cells;
    failures.push(...matrix.failures);
    // runPass creates a fresh browser context; do this after every fault,
    // including a failed or throwing fault, so restoration is independently graded.
    const restored = await run(null, `restored-after-${spec.fault}`);
    requireClean(restored, "self-test-fresh-restoration");
  }
  return { passes, failures };
}

function matchesFailure(item, [name, gesture, phase]) {
  return (
    item.name === name &&
    (gesture === undefined || item.gesture === gesture) &&
    (phase === undefined || item.phase === phase)
  );
}

/** Four explicit sample verdicts; no union of pass-wide failure names. */
function checkFaultMatrix(pass, spec) {
  const cells = [];
  const failures = [];
  const allowedCoverage = spec.allowedCoverage ?? [];
  for (const viewport of VIEWPORTS) {
    for (const entry of ["description", "comment"]) {
      const actual = pass.failures.filter(
        (item) =>
          item.viewport === viewport.name &&
          (item.entry === entry ||
            (spec.scope === "viewport" && item.entry === undefined)),
      );
      const missing = spec.expected.filter(
        (want) => !actual.some((item) => matchesFailure(item, want)),
      );
      const forbidden = actual.filter((item) =>
        (spec.forbidden ?? []).some((want) => matchesFailure(item, want)),
      );
      const unexpected = actual.filter((item) =>
        isCoverageFailure(item)
          ? !allowedCoverage.some((want) => matchesFailure(item, want))
          : spec.strict !== false &&
            !spec.expected.some((want) => matchesFailure(item, want)),
      );
      const evidence = {};
      const problems = [];
      for (const gesture of ["wheel", "touch"]) {
        const samples =
          pass.notes?.[gesture]?.filter(
            (sample) =>
              sample.viewport === viewport.name && sample.entry === entry,
          ) ?? [];
        if (samples.length !== 1)
          problems.push(`${gesture}: expected exactly one recorded sample`);
        evidence[gesture] = samples[0] ?? null;
      }
      const applied =
        pass.notes?.faultApplied?.filter(
          (sample) =>
            sample.viewport === viewport.name && sample.entry === entry,
        ) ?? [];
      if (applied.length !== 1 || applied[0].applied !== true)
        problems.push("fault application was not confirmed for this sample");
      if (spec.control === "plain-touch") {
        const horizontal = evidence.touch?.horizontal;
        if (
          !horizontal ||
          !(horizontal.arrived > 0) ||
          !(horizontal.distance >= 40) ||
          horizontal.retargeted !== true ||
          !(horizontal.max - horizontal.from >= 1) ||
          !(horizontal.to > horizontal.from)
        )
          problems.push(
            "ordinary touch drag did not scroll as the regrip control",
          );
      }
      if (spec.short) {
        const sample = evidence.touch;
        if (
          !(sample?.vertical?.distance > 0 && sample.vertical.distance < 40) ||
          !(sample?.horizontal?.distance >= 40) ||
          !(sample?.regrip?.distance >= 40)
        )
          problems.push(
            "measured paths must keep both horizontal drags >=40px and vertical in (0,40)px",
          );
        if (
          sample?.fixture?.applied !== true ||
          sample?.fixture?.short !== true ||
          !(sample?.fixture?.horizontalDistance >= 40) ||
          !(
            sample?.fixture?.verticalDistance > 0 &&
            sample.fixture.verticalDistance < 40
          )
        )
          problems.push("short-vertical fixture geometry was not confirmed");
      }
      if (spec.fault === "scroll-lock-removed") {
        for (const gesture of ["wheel", "touch"]) {
          const vertical = evidence[gesture]?.vertical;
          if (!(vertical?.page?.after > vertical?.page?.before))
            problems.push(`${gesture}: unlocked page did not move downward`);
          const downward =
            gesture === "wheel"
              ? vertical?.events?.arrived?.length > 0 &&
                vertical.events.arrived.every((event) => event.deltaY > 0)
              : vertical?.path?.to?.y < vertical?.path?.from?.y;
          if (!downward)
            problems.push(`${gesture}: no measured downward scroll input`);
        }
      }
      if (spec.light) {
        const sample = evidence[spec.light];
        const phases =
          spec.light === "touch"
            ? ["horizontal", "regrip", "vertical"]
            : ["horizontal", "vertical"];
        if (
          sample?.fixture?.lightDOM !== true ||
          sample?.fixture?.afterLightDOM !== true ||
          sample?.fixture?.liveLightDOM !== true ||
          sample?.fixture?.restoration?.restored !== true
        )
          problems.push(
            "light DOM fixture did not survive the gesture or restore afterwards",
          );
        for (const phase of phases) {
          const observed = sample?.[phase];
          const events = observed?.events?.arrived;
          if (
            !observed ||
            !(observed.arrived > 0) ||
            observed.retargeted !== false ||
            observed.unretargeted !== true ||
            !Array.isArray(events) ||
            events.length !== observed.arrived ||
            !events.every((event) => event.retargeted === false)
          )
            problems.push(
              `${spec.light}/${phase}: need all delivered events unretargeted`,
            );
          if (
            observed?.start?.lightDOM !== true ||
            observed?.end?.lightDOM !== true
          )
            problems.push(
              `${spec.light}/${phase}: nodes did not stay in light DOM`,
            );
          if (phase !== "vertical" && !(observed?.to > observed?.from))
            problems.push(
              `${spec.light}/${phase}: light DOM control did not scroll`,
            );
        }
      }
      const cell = {
        viewport: viewport.name,
        entry,
        status:
          missing.length ||
          forbidden.length ||
          unexpected.length ||
          problems.length
            ? "red"
            : "green",
        expected: spec.expected,
        forbiddenExpected: spec.forbidden ?? [],
        allowedCoverage,
        missing,
        forbidden,
        unexpected,
        problems,
        actual,
        evidence,
        faultApplied: applied,
      };
      cells.push(cell);
      if (cell.status === "red")
        failures.push(
          failure(
            "self-test-fault-matrix",
            `${spec.fault}: ${viewport.name}/${entry}`,
            { fault: spec.fault, ...cell },
          ),
        );
    }
  }
  // Unattributed or unknown-sample failures must not disappear outside the grid.
  const outside = pass.failures.filter(
    (item) =>
      (!VIEWPORTS.some((viewport) => viewport.name === item.viewport) ||
        (!["description", "comment"].includes(item.entry) &&
          !(spec.scope === "viewport" && item.entry === undefined))) &&
      (isCoverageFailure(item) || spec.strict !== false),
  );
  if (outside.length)
    failures.push(
      failure(
        "self-test-fault-matrix",
        `${spec.fault}: failures outside the four samples`,
        { actual: outside },
      ),
    );
  return { cells, failures };
}

/** Fixed numbers plus handwritten expected failures: this oracle never calls a checker. */
function fixedGestureInput() {
  const horizontal = {
    from: 0,
    to: 80,
    max: 300,
    distance: 120,
    arrived: 4,
    retargeted: true,
    cancelled: 0,
  };
  return {
    target: { tag: "DIFFS-CONTAINER" },
    horizontal: { ...horizontal },
    regrip: {
      ...horizontal,
      secondFinger: true,
      liftedBackToOne: true,
      phases: [
        { type: "touchstart", touches: 2 },
        { type: "touchend", touches: 1 },
      ],
    },
    vertical: {
      distance: 100,
      arrived: 4,
      retargeted: true,
      cancelled: 4,
      box: { max: 200, scrollTop: 200, atBottom: true },
      boxAfter: { max: 200, scrollTop: 200, atBottom: true },
      page: { before: 0, after: 0, max: 500, unlockedMax: 500 },
    },
  };
}

function runFixedCheckerSelfTests() {
  const noRegrip = ["no-touch-delivered", "touch", "regrip"];
  const shortRegrip = ["no-drag-room", "touch", "regrip"];
  const noRegripRoom = ["no-scrolling-line", "touch", "regrip"];
  const blockedBoth = { horizontal: { to: 0 }, regrip: { to: 0 } };
  const cases = [
    { name: "healthy", expected: [] },
    {
      name: "touch-horizontal-and-regrip-blocked",
      touch: blockedBoth,
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
    },
    {
      name: "vertical-zero-keeps-both-horizontal-failures",
      touch: { ...blockedBoth, vertical: { arrived: 0, cancelled: 0 } },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [NO_VERTICAL_TOUCH],
    },
    {
      name: "vertical-short-keeps-both-horizontal-failures",
      touch: { ...blockedBoth, vertical: { distance: 39, cancelled: 0 } },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [SHORT_VERTICAL],
    },
    {
      name: "vertical-zero-and-short-keeps-both-horizontal-failures",
      touch: {
        ...blockedBoth,
        vertical: { arrived: 0, distance: 0, cancelled: 0 },
      },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [NO_VERTICAL_TOUCH, SHORT_VERTICAL],
    },
    {
      name: "regrip-short",
      touch: { regrip: { to: 0, distance: 39 } },
      expected: [],
      coverage: [shortRegrip],
    },
    {
      name: "regrip-zero-events",
      touch: { regrip: { to: 0, arrived: 0 } },
      expected: [],
      coverage: [noRegrip],
    },
    {
      name: "regrip-zero-max",
      touch: { regrip: { to: 0, max: 0 } },
      expected: [],
      coverage: [noRegripRoom],
    },
    {
      name: "regrip-no-remaining-room",
      touch: { regrip: { from: 299.5, to: 299.5 } },
      expected: [],
      coverage: [noRegripRoom],
    },
    {
      name: "regrip-missing-second-finger",
      touch: { regrip: { to: 0, secondFinger: false } },
      expected: [],
      coverage: [["no-second-finger", "touch", "regrip"]],
    },
    {
      name: "regrip-missing-lift",
      touch: { regrip: { to: 0, liftedBackToOne: false } },
      expected: [],
      coverage: [["no-second-finger", "touch", "regrip"]],
    },
    {
      name: "regrip-own-retargeting",
      touch: { regrip: { to: 0, retargeted: false } },
      expected: [],
      coverage: [["touch-target-not-retargeted", "touch", "regrip"]],
    },
    {
      name: "plain-zero-keeps-regrip-failure",
      touch: { horizontal: { arrived: 0, to: 0 }, regrip: { to: 0 } },
      expected: [REGRIP_BLOCKED],
      coverage: [["no-touch-delivered", "touch", "horizontal"]],
    },
    {
      name: "plain-short-keeps-regrip-failure",
      touch: { horizontal: { distance: 39, to: 0 }, regrip: { to: 0 } },
      expected: [REGRIP_BLOCKED],
      coverage: [["no-drag-room", "touch", "horizontal"]],
    },
    {
      name: "plain-no-room-keeps-regrip-failure",
      touch: { horizontal: { from: 300, to: 300 }, regrip: { to: 0 } },
      expected: [REGRIP_BLOCKED],
      coverage: [["no-scrolling-line", "touch", "horizontal"]],
    },
    {
      name: "regrip-isolation",
      touch: { regrip: { to: 0 } },
      expected: [REGRIP_BLOCKED],
    },
    {
      name: "wheel-isolation",
      wheel: { horizontal: { to: 0 } },
      expected: [WHEEL_BLOCKED],
    },
    {
      name: "wheel-vertical-zero-keeps-horizontal-failure",
      wheel: { horizontal: { to: 0 }, vertical: { arrived: 0, cancelled: 0 } },
      expected: [WHEEL_BLOCKED],
      coverage: [["no-wheel-delivered", "wheel", "vertical"]],
    },
    {
      name: "wheel-horizontal-zero-keeps-vertical-failures",
      wheel: {
        horizontal: { arrived: 0, to: 0 },
        vertical: {
          cancelled: 0,
          page: { before: 0, after: 30, max: 500, unlockedMax: 500 },
        },
      },
      expected: [WHEEL_UNLOCKED, WHEEL_PAGE_MOVED],
      coverage: [["no-wheel-delivered", "wheel", "horizontal"]],
    },
    {
      name: "wheel-no-remaining-room",
      wheel: { horizontal: { from: 299.5, to: 299.5 } },
      expected: [],
      coverage: [["no-scrolling-line", "wheel", "horizontal"]],
    },
    {
      name: "vertical-box-zero-range",
      touch: {
        vertical: {
          cancelled: 0,
          box: { max: 0, scrollTop: 0, atBottom: true },
        },
      },
      expected: [],
      coverage: [["scroll-box-not-at-bottom", "touch", "vertical"]],
    },
    {
      name: "vertical-box-not-at-bottom",
      touch: {
        vertical: {
          cancelled: 0,
          box: { max: 200, scrollTop: 198, atBottom: true },
        },
      },
      expected: [],
      coverage: [["scroll-box-not-at-bottom", "touch", "vertical"]],
    },
    {
      name: "vertical-page-not-at-top",
      touch: {
        vertical: {
          cancelled: 0,
          page: { before: 20, after: 30, max: 500, unlockedMax: 500 },
        },
      },
      expected: [],
      coverage: [["page-not-at-top", "touch", "vertical"]],
    },
    {
      name: "vertical-page-no-room",
      touch: {
        vertical: {
          cancelled: 0,
          page: { before: 0, after: 0, max: 0.5, unlockedMax: 500 },
        },
      },
      expected: [],
      coverage: [["page-no-downward-room", "touch", "vertical"]],
    },
    {
      name: "vertical-page-no-unlocked-range",
      touch: {
        vertical: {
          cancelled: 0,
          page: { before: 0, after: 0, max: 500, unlockedMax: 0 },
        },
      },
      expected: [],
      coverage: [["page-cannot-scroll", "touch", "vertical"]],
    },
    {
      name: "vertical-behavior-keeps-horizontal-control",
      touch: {
        vertical: {
          cancelled: 0,
          page: { before: 0, after: 30, max: 500, unlockedMax: 500 },
        },
      },
      expected: [TOUCH_UNLOCKED, TOUCH_PAGE_MOVED],
    },
    {
      name: "minimum-distance-and-room",
      touch: {
        horizontal: { distance: 40, max: 1, to: 1 },
        regrip: { distance: 40, max: 1, to: 1 },
        vertical: { distance: 40 },
      },
      expected: [],
    },
    {
      name: "wheel-light-dom-isolation",
      wheel: {
        horizontal: { retargeted: false },
        vertical: { retargeted: false },
      },
      expected: [],
      coverage: WHEEL_LIGHT,
    },
    {
      name: "touch-light-dom-isolation",
      touch: {
        horizontal: { retargeted: false },
        regrip: { retargeted: false },
        vertical: { retargeted: false },
      },
      expected: [],
      coverage: TOUCH_LIGHT,
    },
    {
      name: "regrip-all-coverage-keeps-plain-failure",
      touch: {
        horizontal: { to: 0 },
        regrip: { arrived: 0, distance: 0, max: 0, to: 0, secondFinger: false },
      },
      expected: [TOUCH_BLOCKED],
      coverage: [
        noRegrip,
        shortRegrip,
        noRegripRoom,
        ["no-second-finger", "touch", "regrip"],
      ],
    },
    {
      name: "missing-vertical-keeps-both-horizontal-failures",
      touch: { ...blockedBoth, vertical: null },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [["no-scrolling-line", "touch", "vertical"]],
    },
    {
      name: "vertical-error-keeps-both-horizontal-failures",
      touch: { ...blockedBoth, vertical: { error: "no visible code" } },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [["no-scrolling-line", "touch", "vertical"]],
    },
    {
      name: "box-subpixel-bottom-is-valid",
      touch: {
        vertical: { box: { max: 200, scrollTop: 199.5, atBottom: true } },
      },
      expected: [],
    },
    {
      name: "box-one-pixel-bottom-is-valid",
      touch: {
        vertical: {
          box: { max: 200, scrollTop: 199, atBottom: true },
          boxAfter: { max: 200, scrollTop: 199, atBottom: true },
        },
      },
      expected: [],
    },
    {
      name: "box-top-zero-is-not-travel",
      touch: {
        vertical: { box: { max: 1, scrollTop: 0, atBottom: true } },
      },
      expected: [],
      coverage: [["scroll-box-not-at-bottom", "touch", "vertical"]],
    },
    {
      name: "box-left-bottom-after-gesture",
      touch: {
        ...blockedBoth,
        vertical: {
          boxAfter: { max: 200, scrollTop: 160, atBottom: false },
        },
      },
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [["scroll-box-not-at-bottom", "touch", "vertical"]],
    },
    {
      name: "baseline-zero-gates-only-vertical",
      baselineHeight: 0,
      touch: blockedBoth,
      expected: [TOUCH_BLOCKED, REGRIP_BLOCKED],
      coverage: [
        ["page-cannot-scroll", "wheel", "vertical"],
        ["page-cannot-scroll", "touch", "vertical"],
      ],
    },
  ];
  const cells = [];
  const failures = [];
  const key = (tuple, coverage) =>
    `${tuple.join("/")}/${coverage ? "coverage" : "behavior"}`;
  for (const test of cases) {
    for (const viewport of VIEWPORTS) {
      for (const entry of ["description", "comment"]) {
        const actual = [];
        const inputs = {};
        for (const gesture of ["wheel", "touch"]) {
          const input = fixedGestureInput();
          for (const [phase, patch] of Object.entries(test[gesture] ?? {}))
            input[phase] =
              patch === null ? null : { ...input[phase], ...patch };
          inputs[gesture] = input;
          actual.push(
            ...(gesture === "wheel" ? checkWheel : checkTouch)(
              input,
              viewport,
              entry,
              test.baselineHeight ?? 500,
            ),
          );
        }
        const expected = [
          ...test.expected.map((tuple) => key(tuple, false)),
          ...(test.coverage ?? []).map((tuple) => key(tuple, true)),
        ].sort();
        const got = actual
          .map((item) =>
            key([item.name, item.gesture, item.phase], isCoverageFailure(item)),
          )
          .sort();
        const attribution = actual.every(
          (item) => item.viewport === viewport.name && item.entry === entry,
        );
        const status =
          JSON.stringify(expected) === JSON.stringify(got) && attribution
            ? "green"
            : "red";
        const cell = {
          case: test.name,
          viewport: viewport.name,
          entry,
          status,
          expected,
          actual: got,
          inputs,
        };
        cells.push(cell);
        if (status === "red")
          failures.push(
            failure(
              "self-test-checker-mismatch",
              `${test.name}: ${viewport.name}/${entry}`,
              cell,
            ),
          );
      }
    }
  }
  console.error(
    `[self-test fixed checkers] ${cells.filter((cell) => cell.status === "green").length}/${cells.length} green`,
  );
  return {
    name: "revision-history-wrap:fixed-checker-inputs",
    failures,
    notes: { checkerCases: cells },
  };
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
