#!/usr/bin/env node
/**
 * Manual real-browser checks for what a reader's own selection copies out of
 * a rich reference (T-427). It is intentionally independent of `pnpm test`/CI:
 * `user-select`, a drag, the system clipboard and the newlines a layout pushes
 * into `text/plain` are all things happy-dom has no opinion about, and the
 * component tests say so in their own header.
 *
 * Every copy here is a real mouse drag, a real Ctrl+C and a real Ctrl+V into a
 * textarea; the only clipboard read is the one the browser hands the paste.
 * Nothing synthesises a copy event, writes the clipboard from script, or
 * rewrites a Selection.
 *
 * Usage: node scripts/rich-link-copy-smoke.mjs [--self-test|--firefox] [--keep] [--help]
 * Preconditions: the devshell's Node 24+, installed workspace dependencies,
 * `flock`, and CHROMIUM (default /usr/bin/chromium); FIREFOX (default
 * /usr/bin/firefox) for --firefox. The runner starts one isolated API/Vite
 * stack and one browser, and seeds its own projects, issues and comments
 * through the real API.
 * Exit codes: 0 all checks pass; 1 a named assertion fails; 2 bad CLI input,
 * missing prerequisite, startup failure, or a check that could not reach the
 * thing it grades (a coverage failure).
 * Limitations: Chromium grades; Firefox is only measured, on the one path the
 * chosen inline layout was priced against (--firefox), where one reading is a
 * known and accepted partial — see runFirefoxPass, and FIREFOX_EXPECTED for
 * the table that names a moved reading without grading it. Safari/WebKit and real
 * touch are neither exercised nor claimed. Headless browsers measure CSS
 * geometry, not painted pixels. A textarea is not proof about Word or VS Code.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  checkParagraphOverflow,
  probeRichLinkWidth,
} from "./browser/rich-link-width.mjs";
import { evaluate, startBrowser } from "./lib/browser-cdp.mjs";
import {
  createBrowserStack,
  sanitizedEnvironment,
} from "./lib/browser-stack.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SENTINEL = "todou-t427-clipboard-sentinel";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];
/**
 * Every viewport takes every placement. Narrow-and-after is the combination
 * where the title, the ref and the separator are ordered one way and the line
 * wraps the other, so leaving it out is exactly leaving out the corner.
 */
const PLACEMENTS = ["before", "after"];
const DIRECTIONS = ["forward", "reverse", "inner"];

const HELP = `rich-link-copy-smoke — real-browser checks for T-427

Usage:
  node scripts/rich-link-copy-smoke.mjs
  node scripts/rich-link-copy-smoke.mjs --self-test

Options:
  --self-test  Prove each checker with an injected fault and a fresh page.
  --firefox    Measure the body-into-ref drag in Firefox instead. Recorded,
               not graded: exits 2 only if a reading could not be taken. A
               reading that differs from FIREFOX_EXPECTED prints a note and
               leaves the exit code alone.
  --keep       Keep the isolated stack directory after the run.
  --help       Print this help and exit.

Exit codes:
  0 checks passed; 1 a named assertion failed; 2 usage, prerequisite,
  startup, cleanup, or a check that never reached its target.
`;

/** Failures that mean the check never reached its target, not that it failed. */
const COVERAGE_FAILURES = new Set([
  "case-exception",
  "page-never-settled",
  "probe-not-installed",
  "probe-missing",
  "probe-off-screen",
  "clipboard-unavailable",
  "copy-did-not-happen",
  "fixture-missing-shapes",
  "chip-title-unmeasured",
  "self-test-baseline-not-clean",
  "self-test-no-new-failure",
  "self-test-fresh-restoration",
]);

/** Each fault is a shape this card's design names and rejects. */
const FAULTS = {
  // The reason the chip is not a flex container at all.
  flex: ".ref-chip-body { display: inline-flex !important; }",
  // `all` is what makes a short drag inside the ref copy the whole ref.
  "token-text":
    "[data-ref-token], [data-mention-token] { user-select: text !important; -webkit-user-select: text !important; }",
  // The note names the page; it is not part of the card's identity.
  "note-selectable":
    "[data-ref-note] { user-select: text !important; -webkit-user-select: text !important; }",
  // The avatar's fallback is the reader's initials as real text. Every rule
  // that keeps it out at once, the Avatar primitive's own `select-none`
  // included: with any one of them standing the leak never happens, and the
  // check would read as green for a reason it had nothing to do with.
  "avatar-selectable":
    '.mention-chip-body, .mention-chip-body [data-mention-decoration], .mention-chip-body [data-slot="avatar"], .mention-chip-body [data-slot="avatar-fallback"] { user-select: text !important; -webkit-user-select: text !important; }',
  // T-434's own contract, kept under this card's eye.
  "comment-title-selectable":
    "[data-comment-title], [data-comment-decoration], [data-comment-author] { user-select: text !important; -webkit-user-select: text !important; }",
  // The title is an inline-block, and its own leading decides whether the
  // line it sits on is the same height as a chipless one.
  leading: ".ref-chip-body { line-height: 2 !important; }",
  // The leading this card took off the chips, put back. It is under the
  // body's own, so it grows no line and the check above cannot see it — what
  // it moves is the title, whose `overflow: hidden` baseline is its bottom
  // edge and therefore follows the leading rather than the prose (T-460).
  "title-leading":
    ".ref-chip-body, .comment-link-body { line-height: 1.2 !important; }",
  "paragraph-overflow":
    '.markdown-body p:has(.ref-chip-body)::after { content: ""; display: inline-block; width: calc(100% + 10px); }',
};

/**
 * Decoration each probe must actually be drawing, so that the fault which
 * makes that decoration selectable has something to leak. A check whose
 * subject is absent passes for the wrong reason.
 */
const EXPECTED_SHAPES = {
  ordinary: ["title"],
  "current-first": ["note"],
  comment: ["title", "author"],
  mention: ["decoration"],
  "mention-machine": ["decoration"],
};

function failure(name, detail, extra = {}) {
  return { name, detail, ...extra };
}

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
  await call("PATCH", "/me", { display_name: "Alice Neutral" });
  const me = await call("GET", "/me");
  const tag = randomUUID().slice(0, 8);
  const home = `t427-home-${tag}`;
  // A slug long enough that the comment chip has something to shorten in the
  // middle at 390px — T-434's rule, which this card must not undo.
  const away = `t427-a-very-long-away-project-slug-${tag}`;
  await call("POST", "/projects", { slug: home, name: "Rich link copy" });
  await call("POST", "/projects", { slug: away, name: "Away" });
  // A machine account too: its bot badge is a second box beside the avatar,
  // and a box on the copy path is what this card had to take the flex out of.
  const bot = await call("POST", "/agents", {
    login: "bot-one",
    display_name: "Bot One",
  });
  await call("POST", `/projects/${home}/members`, {
    login: bot.login,
    role: "writer",
  });
  // A prefixed format on both, so the spellings under test are the ones a
  // configured project produces rather than the bare `#N` of a fresh one.
  await call("PUT", `/projects/${home}/references/format`, { prefix: "T" });
  await call("PUT", `/projects/${away}/references/format`, { prefix: "A" });

  // Four targets, not two: a comment link and an issue link to the same card
  // are one card to the repeat marker, so sharing a target would silently
  // drop the title the comment probes are here to keep out of the clipboard.
  const parent = await call("POST", `/projects/${home}/issues`, {
    title: "A parent card whose title nobody wants in a paste",
    body: "parent",
  });
  const foreign = await call("POST", `/projects/${away}/issues`, {
    title: "A card in another project entirely",
    body: "foreign",
  });
  const commented = await call("POST", `/projects/${home}/issues`, {
    title: "A card whose comment is what the text points at",
    body: "commented",
  });
  const foreignCommented = await call("POST", `/projects/${away}/issues`, {
    title: "An away card whose comment is what the text points at",
    body: "foreign commented",
  });
  const parentComment = await call(
    "POST",
    `/projects/${home}/issues/${commented.number}/comments`,
    { body: "a comment on the commented card" },
  );
  const foreignComment = await call(
    "POST",
    `/projects/${away}/issues/${foreignCommented.number}/comments`,
    { body: "a comment on the away commented card" },
  );

  const page = await call("POST", `/projects/${home}/issues`, {
    title: "The card being read",
    body: "seed",
  });
  const own = await call(
    "POST",
    `/projects/${home}/issues/${page.number}/comments`,
    { body: "a comment on the card being read" },
  );

  const config = await call("GET", `/projects/${home}/references/config`);
  const awayConfig = await call("GET", `/projects/${away}/references/config`);
  const spell = (format, number) =>
    format.prefix === null ? `#${number}` : `${format.prefix}-${number}`;
  const homeRef = (number) => spell(config.format, number);
  const awayRef = (number) => `${away}/${spell(awayConfig.format, number)}`;

  // One probe per line, each a link wrapped in two characters that exist only
  // so a drag has somewhere outside the chip to start and end.
  const probes = [
    {
      key: "ordinary",
      identity: homeRef(parent.number),
      href: `/projects/${home}/issues/${parent.number}`,
      forbidden: ["parent card whose title"],
    },
    {
      key: "cross-project",
      identity: awayRef(foreign.number),
      href: `/projects/${away}/issues/${foreign.number}`,
      forbidden: ["another project entirely"],
    },
    {
      key: "current-first",
      identity: homeRef(page.number),
      href: `/projects/${home}/issues/${page.number}`,
      forbidden: ["(current)", "The card being read"],
    },
    {
      key: "current-repeat",
      identity: homeRef(page.number),
      href: `/projects/${home}/issues/${page.number}`,
      forbidden: ["(current)", "The card being read"],
    },
    {
      key: "comment",
      identity: `${homeRef(commented.number)}#comment-${parentComment.id}`,
      href: `/projects/${home}/issues/${commented.number}#comment-${parentComment.id}`,
      forbidden: [" by ", "whose comment is what the text"],
    },
    {
      key: "comment-cross-project",
      identity: `${awayRef(foreignCommented.number)}#comment-${foreignComment.id}`,
      href: `/projects/${away}/issues/${foreignCommented.number}#comment-${foreignComment.id}`,
      forbidden: [" by ", "whose comment is what the text"],
    },
    {
      key: "comment-current",
      identity: `#comment-${own.id}`,
      href: `/projects/${home}/issues/${page.number}#comment-${own.id}`,
      forbidden: [" by ", "The card being read", "(current)"],
    },
    {
      key: "mention",
      identity: `@${me.login}`,
      href: `/users/${me.id}`,
      // The avatar renders the reader's initials as real text beside it.
      forbidden: ["Alice Neutral", "AN"],
    },
    {
      key: "mention-machine",
      identity: `@${bot.login}`,
      href: `/users/${bot.id}`,
      forbidden: ["Bot One", "BO"],
    },
  ];
  const body = [
    "A paragraph carrying no rich link at all, long enough to wrap on a " +
      "narrow screen, which is what makes it the budget a chip's own line " +
      "has to stay inside.",
    ...probes.map((probe) => `« [${probe.key}](${probe.href}) »`),
  ].join("\n\n");
  await call("PATCH", `/projects/${home}/issues/${page.number}`, { body });

  // Read back what the server stored. It rewrites an authored slug into the
  // project's id, so the check is on the label and the link count, not on the
  // href: a fixture that lost a probe would make its checks vacuous.
  const stored = await call("GET", `/projects/${home}/issues/${page.number}`);
  for (const probe of probes) {
    if (!stored.body.includes(`« [${probe.key}](`)) {
      throw new Error(`fixture lost the ${probe.key} link on the way in`);
    }
  }
  return { cookie, slug: home, number: page.number, probes };
}

/**
 * The page-side probe: geometry, a clipboard sentinel, and two sinks that only
 * ever read what a real paste delivers.
 */
function probeSource(fault) {
  const css = fault ? FAULTS[fault] : "";
  return `(() => {
  const sheet = ${JSON.stringify(css)};
  window.__t427 = { faultApplied: false };
  const install = () => {
    if (sheet) {
      const style = document.createElement('style');
      style.textContent = sheet;
      document.head.appendChild(style);
      window.__t427.faultApplied = true;
    }
    const holder = document.createElement('div');
    // Out of flow, so nothing here moves the layout the checks measure.
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;';
    holder.innerHTML =
      '<textarea id="__t427_prime"></textarea><textarea id="__t427_sink"></textarea>';
    document.body.appendChild(holder);
    const sink = document.getElementById('__t427_sink');
    window.__t427.lastHtml = null;
    sink.addEventListener('paste', event => {
      window.__t427.lastHtml = event.clipboardData.getData('text/html');
    });
    document.getElementById('__t427_prime').value = ${JSON.stringify(SENTINEL)};
  };
  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install);

  const api = window.__t427;

  // The issue description, named by the one paragraph the fixture wrote to be
  // recognisable: a comment's own body is a .markdown-body too, and indexing
  // across all of them moves every probe whenever the page gains a row.
  const CHIPLESS = 'carrying no rich link at all';
  const bodyParagraphs = () => {
    const body = [...document.querySelectorAll('.markdown-body')].find(node =>
      (node.textContent || '').includes(CHIPLESS),
    );
    return body ? [...body.querySelectorAll(':scope > p')] : [];
  };

  /**
   * Visual lines, from the paragraph's own line-height rather than from the
   * count of client rects: an inline-block title has a different rect top
   * from the text beside it, so rects count fragments, not lines.
   */
  const lineCount = element => {
    const strut = parseFloat(getComputedStyle(element).lineHeight);
    if (!strut) return 1;
    return Math.max(1, Math.round(element.getBoundingClientRect().height / strut));
  };

  api.paragraphs = () =>
    bodyParagraphs().map(p => ({
      text: p.textContent,
      rect: p.getBoundingClientRect().toJSON(),
      lines: lineCount(p),
      lineHeight: p.getBoundingClientRect().height / lineCount(p),
      links: [...p.querySelectorAll('a')].length,
    }));

  const paragraphOf = index => bodyParagraphs()[index] || null;

  const charRect = (node, offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getClientRects()[0];
    return rect ? rect.toJSON() : null;
  };

  /** The guillemets bracketing a probe, and the ref slot between them. */
  // A point below the fold is not a point a mouse can be dispatched to, so
  // the probe is scrolled to first — and measured in a later call, because a
  // rect read in the same turn as the scroll can still be the old one.
  api.scrollTo = index => {
    const p = paragraphOf(index);
    if (!p) return { error: 'no paragraph' };
    p.scrollIntoView({ block: 'center', behavior: 'instant' });
    return { ok: true };
  };

  api.points = index => {
    const p = paragraphOf(index);
    if (!p) return { error: 'no paragraph' };
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    const open = texts.find(n => (n.textContent || '').includes('«'));
    const close = texts.reverse().find(n => (n.textContent || '').includes('»'));
    if (!open || !close) return { error: 'no guillemets' };
    const openRect = charRect(open, (open.textContent || '').indexOf('«'));
    const closeRect = charRect(close, (close.textContent || '').indexOf('»'));
    const slot = p.querySelector('[data-ref-token], [data-mention-token], [data-comment-ref]');
    if (!openRect || !closeRect || !slot) return { error: 'no geometry' };
    // The longest character-bearing span, so a short drag inside the slot has
    // room to be short without falling off the end of a one-character span.
    const parts = [...p.querySelectorAll('[data-ref-part], [data-ref-token], [data-mention-token]')];
    const inner = parts.reduce(
      (best, part) =>
        (part.textContent || '').length > (best?.textContent || '').length ? part : best,
      parts[0] || slot,
    );
    const innerNode = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT).nextNode();
    const innerText = innerNode ? innerNode.textContent || '' : '';
    // A third of the way in to two thirds of the way in: a whole-token result
    // and a character-by-character one differ by more than rounding, which is
    // what makes the atom rule falsifiable here.
    const from = Math.floor(innerText.length / 3);
    const to = Math.max(from + 1, Math.floor((innerText.length * 2) / 3));
    const innerRect =
      innerNode && innerText.length >= 4
        ? { a: charRect(innerNode, from), b: charRect(innerNode, to - 1) }
        : null;
    const openPoint = { x: openRect.left + 1, y: openRect.top + openRect.height / 2 };
    const closePoint = { x: closeRect.right - 1, y: closeRect.top + closeRect.height / 2 };
    // Every point a mouse event is aimed at has to be on screen and inside
    // this paragraph; a stale rect otherwise drags across half the page and
    // the mismatch reads as a product failure.
    const onScreen = point =>
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= window.innerWidth &&
      point.y <= window.innerHeight &&
      p.contains(document.elementFromPoint(point.x, point.y));
    if (!onScreen(openPoint) || !onScreen(closePoint)) {
      const describe = point => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit ? hit.tagName + '.' + (hit.className || '').toString().slice(0, 60) : 'none';
      };
      return {
        error:
          'guillemets off screen: open ' + JSON.stringify(openPoint) + ' hits ' +
          describe(openPoint) + ', close ' + JSON.stringify(closePoint) + ' hits ' +
          describe(closePoint),
      };
    }
    return {
      open: openPoint,
      close: closePoint,
      inner:
        innerRect && innerRect.a && innerRect.b
          ? {
              from: {
                x: innerRect.a.left + 1,
                y: innerRect.a.top + innerRect.a.height / 2,
              },
              to: {
                x: innerRect.b.right - 1,
                y: innerRect.b.top + innerRect.b.height / 2,
              },
            }
          : null,
      // Somewhere unambiguously inside the identity, whatever its length:
      // the point a drag coming out of the prose has to land on.
      mid: (() => {
        const rect =
          innerNode && innerText.length
            ? charRect(innerNode, Math.floor(innerText.length / 2))
            : inner && inner.getBoundingClientRect();
        return rect
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null;
      })(),
      text: p.textContent,
    };
  };

  /** What each check assumes is on the page, so a vacuous one says so. */
  api.shapes = index => {
    const p = paragraphOf(index);
    if (!p) return { error: 'no paragraph' };
    const text = node => (node ? node.textContent || '' : null);
    return {
      decoration: text(p.querySelector('[data-mention-decoration]')),
      note: text(p.querySelector('[data-ref-note]')),
      title: text(p.querySelector('.ref-chip-title, [data-comment-title]')),
      author: text(p.querySelector('[data-comment-author]')),
      innerLength: Math.max(
        0,
        ...[...p.querySelectorAll('[data-ref-part], [data-ref-token], [data-mention-token]')].map(
          node => (node.textContent || '').length,
        ),
      ),
    };
  };

  api.focusPrime = () => {
    const box = document.getElementById('__t427_prime');
    if (!box) return false;
    box.value = ${JSON.stringify(SENTINEL)};
    box.focus({ preventScroll: true });
    box.select();
    return true;
  };

  api.clearFocus = () => {
    const box = document.getElementById('__t427_prime');
    if (box) box.blur();
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    return true;
  };

  api.focusSink = () => {
    const box = document.getElementById('__t427_sink');
    if (!box) return false;
    api.lastHtml = null;
    box.value = '';
    box.focus({ preventScroll: true });
    box.select();
    return true;
  };

  api.readSink = () => {
    const box = document.getElementById('__t427_sink');
    const html = api.lastHtml;
    let htmlText = null;
    if (typeof html === 'string' && html !== '') {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      htmlText = parsed.body.textContent;
      api.lastHtmlLinks = [...parsed.querySelectorAll('a[href]')].length;
    } else {
      api.lastHtmlLinks = 0;
    }
    return {
      plain: box ? box.value : null,
      htmlText,
      htmlLinks: api.lastHtmlLinks,
      hasHtml: typeof html === 'string' && html !== '',
    };
  };

  api.selection = () => {
    const selection = window.getSelection();
    return {
      text: selection ? selection.toString() : '',
      ranges: selection ? selection.rangeCount : 0,
      collapsed: selection ? selection.isCollapsed : true,
    };
  };

  /** Page-level horizontal overflow, the narrow viewport's real question. */
  api.overflow = () => {
    const over = bodyParagraphs()
      .map((p, index) => ({ index, by: p.scrollWidth - p.clientWidth }))
      .filter(entry => entry.by > 0);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      paragraphsOver: over,
    };
  };

  /** Where the chip's own characters sit against the prose around them. */
  api.baselines = index => {
    const p = paragraphOf(index);
    if (!p) return { error: 'no paragraph' };
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    const open = texts.find(n => (n.textContent || '').includes('«'));
    const close = [...texts].reverse().find(n => (n.textContent || '').includes('»'));
    // The first slot that actually carries a character: a comment ref splits
    // a one-character prefix into an empty head span and a one-character
    // tail, and an empty text node has no rect to compare.
    const slot = [
      ...p.querySelectorAll('[data-ref-token], [data-mention-token], [data-ref-part]'),
    ].find(node => (node.textContent || '').length > 0);
    const slotNode = slot ? document.createTreeWalker(slot, NodeFilter.SHOW_TEXT).nextNode() : null;
    const token = slotNode ? charRect(slotNode, 0) : null;
    // Whichever guillemet shares the token's line, by vertical overlap: on a
    // narrow screen the paragraph wraps, and a character a line above is not
    // a baseline. Overlap, not equal tops — a clipped inline-block sits on
    // the same line with a top of its own.
    const candidates = [
      open ? charRect(open, (open.textContent || '').indexOf('«')) : null,
      close ? charRect(close, (close.textContent || '').indexOf('»')) : null,
    ].filter(Boolean);
    const prose = token
      ? candidates.find(rect => rect.top < token.bottom && rect.bottom > token.top) || null
      : null;
    // The title is the one part of a chip with a box of its own, and
    // \`overflow: hidden\` degrades that box's baseline to its bottom edge, so
    // it answers to the sheet's leading rather than to the prose (T-460
    // measured 2.59px of sink at every width). The token cannot see this:
    // it has no box and never left the baseline.
    const titleBox = p.querySelector('[data-comment-title], .ref-chip-title');
    const titleNode = titleBox
      ? document.createTreeWalker(titleBox, NodeFilter.SHOW_TEXT).nextNode()
      : null;
    const title = titleNode ? charRect(titleNode, 0) : null;
    // The opening guillemet, whatever line it ended up on: a narrow title
    // takes a whole line to itself, so "whichever character shares its line"
    // finds nothing at exactly the width the drift matters at. The caller
    // takes the difference modulo the line height instead, which is what
    // makes a run one line up a usable baseline.
    return {
      prose,
      token,
      title,
      proseAnchor: candidates[0] ?? null,
      hasTitle: titleBox !== null,
      slot: slot ? slot.getAttribute('data-ref-part') || slot.tagName : null,
      candidates,
      lines: lineCount(p),
      lineHeight: p.getBoundingClientRect().height / lineCount(p),
    };
  };

  api.dragEvents = 0;
  document.addEventListener('dragstart', () => { api.dragEvents += 1; }, true);
  api.resetDrag = () => { api.dragEvents = 0; return true; };

  // A short drag that ends inside a link can land as a click, and one
  // navigation takes the rest of the run with it. The driver holds the page
  // still; it does not touch the drag, the selection or the copy.
  api.navigationsHeld = 0;
  document.addEventListener(
    'click',
    event => {
      const target = event.target;
      const link = target && target.closest ? target.closest('a') : null;
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      api.navigationsHeld += 1;
    },
    true,
  );
  return true;
})()`;
}

async function pressKey(page, key, { modifiers = 0, code } = {}) {
  const shared = {
    modifiers,
    key,
    code: code ?? `Key${key.toUpperCase()}`,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shared });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...shared });
}

async function dragBetween(page, from, to) {
  const shared = { button: "left", buttons: 1, pointerType: "mouse" };
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    clickCount: 1,
    ...shared,
  });
  // Several steps, not a jump: a single move can be read as a click, and a
  // link under the cursor then starts a native drag instead of a selection.
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      ...shared,
    });
    await sleep(10);
  }
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    clickCount: 1,
    ...shared,
  });
  await sleep(60);
}

/**
 * Take the cursor off the last chip it dragged across and let the hover card
 * that opened under it close: a popover covers the paragraphs below, and the
 * points measured through it belong to the popover.
 */
async function parkCursor(page, viewport) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: viewport.width - 2,
    y: viewport.height - 2,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const open = await evaluate(
      page,
      () =>
        document.querySelectorAll("[data-radix-popper-content-wrapper]").length,
    ).catch(() => 0);
    if (open === 0) return;
    await sleep(100);
  }
}

async function copyRoundTrip(page, index, direction, viewport) {
  await parkCursor(page, viewport);
  // Prove the clipboard is rewritten by THIS copy: a drag that never formed a
  // selection otherwise reads as a pass on whatever was there before.
  await evaluate(page, () => window.__t427.focusPrime());
  await pressKey(page, "c", { modifiers: 2, code: "KeyC" });
  await sleep(80);
  await evaluate(page, () => window.__t427.clearFocus());
  await evaluate(page, () => window.__t427.resetDrag());

  // Measured last, and one turn after the scroll: focusing the sentinel can
  // move the page, and a stale rect aims the drag at another paragraph.
  await evaluate(page, (i) => window.__t427.scrollTo(i), index);
  await sleep(120);
  const points = await evaluate(page, (i) => window.__t427.points(i), index);
  if (points.error) return { points };
  if (direction === "inner" && !points.inner) return { points, skipped: true };

  const [from, to] =
    direction === "forward"
      ? [points.open, points.close]
      : direction === "reverse"
        ? [points.close, points.open]
        : [points.inner.from, points.inner.to];
  await dragBetween(page, from, to);
  const selection = await evaluate(page, () => window.__t427.selection());
  await pressKey(page, "c", { modifiers: 2, code: "KeyC" });
  await sleep(120);
  await evaluate(page, () => window.__t427.focusSink());
  await pressKey(page, "v", { modifiers: 2, code: "KeyV" });
  await sleep(120);
  const pasted = await evaluate(page, () => window.__t427.readSink());
  const drags = await evaluate(page, () => window.__t427.dragEvents);
  await evaluate(page, () => window.__t427.clearFocus());
  return { points, selection, pasted, drags };
}

function checkCopy(result, probe, direction, viewport, placement) {
  const at = { viewport, placement, probe: probe.key, direction };
  // Recorded rather than passed over: a token of three characters has no
  // proper sub-range to drag, and a silent skip reads as a green check.
  if (result.skipped)
    return [{ ...at, note: "token too short to drag inside" }];
  if (result.points.error)
    return [
      failure(
        result.points.error.startsWith("guillemets off screen")
          ? "probe-off-screen"
          : "probe-missing",
        result.points.error,
        at,
      ),
    ];
  if (result.pasted?.plain === null)
    return [failure("clipboard-unavailable", "no sink value", at)];
  const got = result.pasted.plain;
  if (got === SENTINEL) {
    const detail = `clipboard still holds the sentinel; selection ${JSON.stringify(
      result.selection,
    )}, dragstart ${result.drags}`;
    // A drag that starts inside a link can become a native link drag instead
    // of a selection — on a platform where it does, this is the browser's
    // gesture and not a defect. On Chromium 153 it does not: an atomic slot
    // hands back the whole identity, and a slot that is merely `text` hands
    // back nothing, so this failing is how the atom rule is falsifiable.
    if (direction === "inner")
      return [failure("inner-drag-made-no-selection", detail, at)];
    return [failure("copy-did-not-happen", detail, at)];
  }

  const failures = [];
  const want = direction === "inner" ? probe.identity : `« ${probe.identity} »`;
  if (got !== want) {
    failures.push(
      failure(
        "copy-text-differs",
        `clipboard ${JSON.stringify(got)} (${
          (got.match(/\n/g) ?? []).length
        } newlines) vs ${JSON.stringify(want)}`,
        at,
      ),
    );
  }
  for (const banned of probe.forbidden) {
    if (got.includes(banned))
      failures.push(
        failure(
          "decoration-in-clipboard",
          `${JSON.stringify(banned)} reached the clipboard: ${JSON.stringify(got)}`,
          at,
        ),
      );
  }
  // The HTML flavour is the browser's own; only its text and its link
  // semantics are this card's business.
  if (result.pasted.hasHtml) {
    const htmlText = result.pasted.htmlText ?? "";
    if (!htmlText.includes(probe.identity))
      failures.push(
        failure(
          "html-text-differs",
          `text/html text ${JSON.stringify(htmlText)} lacks ${probe.identity}`,
          at,
        ),
      );
    for (const banned of probe.forbidden) {
      if (htmlText.includes(banned))
        failures.push(
          failure(
            "decoration-in-html",
            `${JSON.stringify(banned)} reached text/html: ${JSON.stringify(htmlText)}`,
            at,
          ),
        );
    }
  }
  return failures;
}

/**
 * How far a run sits off the paragraph's baseline grid, given a run that is
 * on it and a uniform line height — which is exactly what `chip-grows-its-line`
 * below asserts, so the two hold each other up. A sink of a whole line reads
 * as zero here, and that is the one shape this cannot see; it would have to
 * pass that check first, having moved 22px without changing any line's height.
 */
function onTheLineGrid(distance, lineHeight) {
  if (!(lineHeight > 0)) return distance;
  const within = ((distance % lineHeight) + lineHeight) % lineHeight;
  return within > lineHeight / 2 ? within - lineHeight : within;
}

function checkLayout(overflow, baselines, chipless, probes, viewport) {
  const at = { viewport };
  const failures = [];
  const measurements = { overflow, chipless, chips: {} };
  if (overflow.scrollWidth > overflow.clientWidth + 1)
    failures.push(
      failure(
        "page-overflows-horizontally",
        `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}, ` +
          `paragraphs over: ${JSON.stringify(overflow.paragraphsOver)}`,
        at,
      ),
    );
  failures.push(...checkParagraphOverflow(overflow, at));
  for (const [index, measured] of baselines.entries()) {
    const key = probes[index]?.key ?? String(index);
    if (measured.error) continue;
    const drift =
      measured.prose && measured.token
        ? measured.prose.bottom - measured.token.bottom
        : null;
    const titleDrift =
      measured.proseAnchor && measured.title
        ? onTheLineGrid(
            measured.title.bottom - measured.proseAnchor.bottom,
            measured.lineHeight,
          )
        : null;
    measurements.chips[key] = {
      drift,
      titleDrift,
      lines: measured.lines,
      lineHeight: measured.lineHeight,
      // A skipped comparison is recorded, not silently counted as covered.
      ...(drift === null
        ? {
            unmeasured: {
              slot: measured.slot,
              token: measured.token,
              candidates: measured.candidates,
            },
          }
        : {}),
      ...(titleDrift === null && measured.hasTitle
        ? { titleUnmeasured: { title: measured.title } }
        : {}),
    };
    if (drift !== null && Math.abs(drift) > 1)
      failures.push(
        failure(
          "chip-off-baseline",
          `${key}: token bottom ${measured.token.bottom} vs prose ${measured.prose.bottom}`,
          at,
        ),
      );
    // Half a pixel, where the token gets one: this one is a measured 0.00 on
    // a fix whose whole subject is the 2.59px it used to be, and a tolerance
    // wider than the defect grades nothing.
    if (titleDrift !== null && Math.abs(titleDrift) > 0.5)
      failures.push(
        failure(
          "chip-title-off-baseline",
          `${key}: title sits ${titleDrift}px off the paragraph's baseline grid`,
          at,
        ),
      );
    // A chip that draws a title and never got the comparison is a check that
    // passed for the wrong reason; EXPECTED_SHAPES says which ones draw one.
    if (titleDrift === null && measured.hasTitle)
      failures.push(
        failure(
          "chip-title-unmeasured",
          `${key}: a title is drawn but its box or the prose anchor had no rect`,
          at,
        ),
      );
    // A chip must not grow the line it sits on; the chipless paragraph is the
    // budget, taken per line so its own wrapping does not inflate it. The
    // tolerance is under T-371's own margin: vscode's 1.25 leading overran
    // the same budget by 0.11px, and that was a failure.
    if (measured.lineHeight > chipless + 0.05)
      failures.push(
        failure(
          "chip-grows-its-line",
          `${key}: ${measured.lineHeight}px against a chipless ${chipless}px`,
          at,
        ),
      );
  }
  return { failures, measurements };
}

async function waitForPage(page, probes) {
  const empty = { paragraphs: 0, slots: 0 };
  // Named, not waited out: the probe is a string, and a typo in it otherwise
  // reads as "the page never rendered" twenty seconds later.
  const installed = await evaluate(
    page,
    () => typeof window.__t427 === "object",
  ).catch(() => false);
  if (!installed) return "no-probe";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await evaluate(page, () => ({
      paragraphs: window.__t427.paragraphs().length,
      slots: document.querySelectorAll(
        "[data-ref-token], [data-mention-token], [data-comment-ref]",
      ).length,
    })).catch(() => empty);
    // Every probe resolved, and the description's own paragraphs all present:
    // a chip still on its fallback would otherwise be graded as a chip.
    if (
      ready.slots >= probes.length &&
      ready.paragraphs === probes.length + 1
    ) {
      await sleep(400);
      return ready;
    }
    await sleep(100);
  }
  return null;
}

async function setPlacement(serverPort, cookie, placement) {
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/me/prefs`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ref_placement_reference: placement }),
  });
  if (!response.ok)
    throw new Error(`prefs -> ${response.status} ${await response.text()}`);
}

async function runPass({ browser, stack, fixture, fault }) {
  const failures = [];
  const notes = {
    fault: fault ?? null,
    faultApplied: null,
    drags: {},
    nativeDrag: [],
    navigationsHeld: {},
    layout: {},
    shapes: {},
    copies: {},
  };
  const context = await browser.newContext();
  await browser.send("Browser.grantPermissions", {
    browserContextId: context.browserContextId,
    origin: stack.webUrl,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  try {
    for (const viewport of VIEWPORTS) {
      for (const placement of PLACEMENTS) {
        await setPlacement(stack.serverPort, fixture.cookie, placement);
        const page = await browser.newPage({
          context,
          cookie: fixture.cookie,
          viewport: { width: viewport.width, height: viewport.height },
          scripts: [probeSource(fault)],
        });
        try {
          await page.navigate(
            `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`,
          );
          const ready = await waitForPage(page, fixture.probes);
          if (ready === null || ready === "no-probe") {
            failures.push(
              failure(
                ready === "no-probe"
                  ? "probe-not-installed"
                  : "page-never-settled",
                ready === "no-probe"
                  ? "the injected probe never defined window.__t427"
                  : "rich links never resolved",
                { viewport: viewport.name, placement },
              ),
            );
            continue;
          }
          if (fault && notes.faultApplied === null)
            notes.faultApplied = await evaluate(
              page,
              () => window.__t427.faultApplied,
            );
          const paragraphs = await evaluate(page, () =>
            window.__t427.paragraphs(),
          );
          // The description's paragraphs are the chipless one first, then one
          // per probe in the order the fixture wrote them.
          const offset = paragraphs.findIndex((p) => p.links > 0);
          if (offset !== 1) {
            failures.push(
              failure(
                "probe-missing",
                `expected the chipless paragraph first, got ${JSON.stringify(
                  paragraphs.map((p) => p.links),
                )}`,
                { viewport: viewport.name, placement },
              ),
            );
            continue;
          }
          // A chipless line's own height is the budget a chip may not grow.
          const chipless = paragraphs[0].lineHeight;
          // What the decoration checks assume is actually drawn. Without
          // this a fault that makes a decoration selectable passes because
          // there was no decoration text to leak in the first place.
          const shapes = {};
          for (const [index, probe] of fixture.probes.entries()) {
            shapes[probe.key] = await evaluate(
              page,
              (i) => window.__t427.shapes(i),
              offset + index,
            );
          }
          notes.shapes[`${viewport.name}/${placement}`] = shapes;
          for (const [key, want] of Object.entries(EXPECTED_SHAPES)) {
            for (const field of want) {
              const seen = shapes[key]?.[field];
              if (seen === null || seen === undefined || seen === "")
                failures.push(
                  failure(
                    "fixture-missing-shapes",
                    `${key} has no ${field}: ${JSON.stringify(shapes[key])}`,
                    { viewport: viewport.name, placement },
                  ),
                );
            }
          }
          for (const [index, probe] of fixture.probes.entries()) {
            for (const direction of DIRECTIONS) {
              try {
                const result = await copyRoundTrip(
                  page,
                  offset + index,
                  direction,
                  viewport,
                );
                notes.drags[`${probe.key}:${direction}`] = result.drags ?? null;
                notes.copies[
                  `${viewport.name}/${placement}/${probe.key}/${direction}`
                ] = result.skipped
                  ? "(skipped)"
                  : (result.pasted?.plain ?? result.points?.error ?? null);
                for (const entry of checkCopy(
                  result,
                  probe,
                  direction,
                  viewport.name,
                  placement,
                )) {
                  if (entry.name === undefined) notes.nativeDrag.push(entry);
                  else failures.push(entry);
                }
              } catch (error) {
                failures.push(
                  failure("case-exception", String(error), {
                    viewport: viewport.name,
                    placement,
                    probe: probe.key,
                    direction,
                  }),
                );
              }
            }
          }
          const overflow = await evaluate(page, () => window.__t427.overflow());
          const baselines = [];
          for (let index = 0; index < fixture.probes.length; index += 1) {
            baselines.push(
              await evaluate(
                page,
                (i) => window.__t427.baselines(i),
                offset + index,
              ),
            );
          }
          const layout = checkLayout(
            overflow,
            baselines,
            chipless,
            fixture.probes,
            viewport.name,
          );
          failures.push(...layout.failures);
          notes.layout[`${viewport.name}/${placement}`] = layout.measurements;
          notes.navigationsHeld[`${viewport.name}/${placement}`] =
            await evaluate(page, () => window.__t427.navigationsHeld);
          if (!fault && viewport.name === "narrow" && placement === "after") {
            const width = await evaluate(page, probeRichLinkWidth);
            notes.width = width;
            for (const name of width.coverageErrors ?? [])
              failures.push(failure("fixture-missing-shapes", name));
            for (const name of width.failures ?? [])
              failures.push(failure(name, JSON.stringify(width.readings)));
            if (
              width.injectedOverflow &&
              checkParagraphOverflow(width.injectedOverflow).length === 0
            )
              failures.push(failure("paragraph-overflow-fault-unnoticed", ""));
          }
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return { failures, notes };
}

/**
 * The smallest WebDriver BiDi client that can drive a real drag: connect,
 * evaluate, move a real pointer, press real keys. Firefox speaks no CDP pipe,
 * which is why scripts/lib/browser-cdp.mjs cannot reach it, and a research
 * driver's puppeteer-core is deliberately not a dependency of this repo.
 */
class BidiSession {
  #socket;
  #next = 1;
  #pending = new Map();
  context = null;

  static async open(url) {
    const session = new BidiSession();
    // Firefox announces the base endpoint; `/session` is where a BiDi-only
    // client asks for a session of its own.
    await session.#connect(`${url.replace(/\/$/, "")}/session`);
    const { sessionId } = await session.send("session.new", {
      capabilities: { alwaysMatch: {} },
    });
    session.sessionId = sessionId;
    const { contexts } = await session.send("browsingContext.getTree", {});
    session.context = contexts[0]?.context ?? null;
    if (session.context === null) throw new Error("BiDi gave no context");
    return session;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#socket = new WebSocket(url);
      this.#socket.addEventListener("open", () => resolve());
      this.#socket.addEventListener("error", () =>
        reject(new Error(`BiDi socket failed: ${url}`)),
      );
      this.#socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const waiting = this.#pending.get(message.id);
        if (!waiting) return;
        this.#pending.delete(message.id);
        if (message.type === "error")
          waiting.reject(
            new Error(`${message.error}: ${message.message ?? ""}`),
          );
        else waiting.resolve(message.result);
      });
      this.#socket.addEventListener("close", () => {
        for (const { reject: fail } of this.#pending.values())
          fail(new Error("BiDi socket closed"));
        this.#pending.clear();
      });
    });
  }

  send(method, params, timeoutMs = 60_000) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`BiDi ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Values come back as JSON text, so no BiDi value deserialiser is needed.
   * Resolved before it is stringified: `JSON.stringify(promise)` is `{}`.
   */
  async json(expression) {
    const result = await this.send("script.evaluate", {
      expression: `Promise.resolve(${expression}).then((value) => JSON.stringify(value))`,
      target: { context: this.context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (result.type === "exception")
      throw new Error(result.exceptionDetails?.text ?? "BiDi evaluate threw");
    return result.result?.value === undefined
      ? undefined
      : JSON.parse(result.result.value);
  }

  async run(expression) {
    const result = await this.send("script.evaluate", {
      expression,
      target: { context: this.context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (result.type === "exception")
      throw new Error(result.exceptionDetails?.text ?? "BiDi evaluate threw");
    return result.result?.value;
  }

  navigate(url) {
    return this.send("browsingContext.navigate", {
      context: this.context,
      url,
      wait: "complete",
    });
  }

  viewport(width, height) {
    return this.send("browsingContext.setViewport", {
      context: this.context,
      viewport: { width, height },
      devicePixelRatio: 1,
    });
  }

  pointer(actions) {
    return this.send("input.performActions", {
      context: this.context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions,
        },
      ],
    });
  }

  keys(actions) {
    return this.send("input.performActions", {
      context: this.context,
      actions: [{ type: "key", id: "keyboard", actions }],
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {}
  }
}

const CONTROL = "";

async function bidiChord(session, letter) {
  await session.keys([
    { type: "keyDown", value: CONTROL },
    { type: "keyDown", value: letter },
    { type: "keyUp", value: letter },
    { type: "keyUp", value: CONTROL },
  ]);
}

async function bidiDrag(session, from, to) {
  const steps = 8;
  const moves = [];
  for (let step = 1; step <= steps; step += 1) {
    moves.push({
      type: "pointerMove",
      origin: "viewport",
      duration: 20,
      x: Math.round(from.x + ((to.x - from.x) * step) / steps),
      y: Math.round(from.y + ((to.y - from.y) * step) / steps),
    });
  }
  await session.pointer([
    {
      type: "pointerMove",
      origin: "viewport",
      x: Math.round(from.x),
      y: Math.round(from.y),
    },
    { type: "pointerDown", button: 0 },
    ...moves,
    { type: "pointerUp", button: 0 },
  ]);
  await sleep(80);
}

/** Start Firefox headless and wait for it to announce its BiDi endpoint. */
async function startFirefox(lifecycle, dir) {
  const binary = process.env.FIREFOX ?? "/usr/bin/firefox";
  const profile = join(dir, "firefox-profile");
  mkdirSync(profile, { recursive: true });
  const child = lifecycle.spawn(
    binary,
    [
      "--headless",
      "--no-remote",
      "--profile",
      profile,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    {
      cwd: lifecycle.root,
      env: sanitizedEnvironment({ MOZ_HEADLESS: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
    "firefox",
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const found = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(
      lifecycle.tail(child),
    );
    if (found) return { child, url: found[1] };
    if (child.exitCode !== null)
      throw new Error(`firefox exited: ${lifecycle.tail(child)}`);
    await sleep(200);
  }
  throw new Error(`firefox never announced BiDi: ${lifecycle.tail(child)}`);
}

/** The four paths across one probe, named for where the drag starts and ends. */
const FIREFOX_PATHS = [
  { key: "across-forward", from: "open", to: "close" },
  { key: "across-reverse", from: "close", to: "open" },
  { key: "body-into-ref", from: "open", to: "mid" },
  { key: "ref-out-to-body", from: "mid", to: "close" },
];

/**
 * What each path reads today. Gecko's own gesture is the browser's business
 * and stays out of the exit code (T-427), but a pass that only prints leaves
 * a reading free to change one word among twenty-four with nothing pointing
 * at it — and the two words that matter most here are opposites. The table
 * turns that into a line of its own; the verdict it carries grades nothing.
 */
const FIREFOX_EXPECTED = {
  "desktop/ordinary/across-forward": "complete",
  "desktop/ordinary/across-reverse": "complete",
  "desktop/ordinary/body-into-ref": "complete",
  // Firefox answers a press on a link with a native drag rather than a
  // selection, so a drag that starts inside the ref copies nothing at all.
  "desktop/ordinary/ref-out-to-body": "no-selection",
  "desktop/comment/across-forward": "complete",
  "desktop/comment/across-reverse": "complete",
  "desktop/comment/body-into-ref": "complete",
  "desktop/comment/ref-out-to-body": "no-selection",
  "desktop/mention/across-forward": "complete",
  "desktop/mention/across-reverse": "complete",
  "desktop/mention/body-into-ref": "complete",
  "desktop/mention/ref-out-to-body": "no-selection",
  "narrow/ordinary/across-forward": "complete",
  "narrow/ordinary/across-reverse": "complete",
  "narrow/ordinary/body-into-ref": "complete",
  "narrow/ordinary/ref-out-to-body": "no-selection",
  "narrow/comment/across-forward": "complete",
  "narrow/comment/across-reverse": "complete",
  // The accepted limitation runFirefoxPass describes: `complete` here is Gecko
  // or our own structure having moved, not a check that started passing.
  "narrow/comment/body-into-ref": "partial:3/13",
  "narrow/comment/ref-out-to-body": "no-selection",
  "narrow/mention/across-forward": "complete",
  "narrow/mention/across-reverse": "complete",
  "narrow/mention/body-into-ref": "complete",
  "narrow/mention/ref-out-to-body": "no-selection",
};

/** One line per reading the table did not predict, in either direction. */
function firefoxDrift(readings) {
  const taken = new Set();
  const drift = [];
  for (const one of readings) {
    const key = `${one.viewport}/${one.probe}/${one.path}`;
    taken.add(key);
    const expected = FIREFOX_EXPECTED[key];
    if (expected === undefined)
      drift.push(`${key}: read ${one.verdict}, and the table has no entry`);
    else if (expected !== one.verdict)
      drift.push(`${key}: expected ${expected}, read ${one.verdict}`);
  }
  for (const [key, expected] of Object.entries(FIREFOX_EXPECTED))
    if (!taken.has(key)) drift.push(`${key}: expected ${expected}, no reading`);
  return drift;
}

/** Which of the identity's characters a path actually produced. */
function verdictFor(got, identity) {
  if (got === SENTINEL) return "no-selection";
  if (got.includes(identity)) return "complete";
  // The longest run of the identity that made it, so a partial selection is
  // told apart from one that never reached the token at all.
  let best = 0;
  for (let start = 0; start < identity.length; start += 1) {
    for (let end = identity.length; end > start + best; end -= 1) {
      if (got.includes(identity.slice(start, end))) {
        best = end - start;
        break;
      }
    }
  }
  return best === 0 ? "no-token" : `partial:${best}/${identity.length}`;
}

/**
 * The one measurement the chosen trade-off priced and nobody had re-run on the
 * structure that shipped: Firefox, real link dragging left on, a drag that
 * starts in the prose and reaches the ref. Recorded, not graded — whether
 * Firefox's gesture differs is the browser's business and this card's accepted
 * boundary; that the reading exists is what closes the decision.
 *
 * `narrow/comment/body-into-ref` reads `partial:3/13` on purpose (T-460). Gecko
 * never puts a caret inside a `user-select: all` element: `caretPositionFromPoint`
 * over `[data-comment-ref]` returns only that element's own two ends, and which
 * end it picks follows the whole chip's box rather than the line under the
 * pointer. A comment ref draws its identity in two slots with the title between
 * them, so the atom has to be the container the title lives in; once that box
 * wraps, every point in it picks the near end and the ref leaves the selection
 * whole. Wide is not a fix, only a luckier landing — at 1280px a drag that stops
 * on `T-2` instead of `#comment-1` loses the ref the same way.
 *
 * Three fixes were measured and each costs more than the reading: an
 * `inline-block` container turns the 390px paragraph from three lines into four,
 * moving the atom onto the two identity slots makes Chromium's inner drag copy
 * `#comment-1` without `T-2`, and welding the identity into one slot undoes the
 * reading order the user chose in T-434. The user took the reading over all
 * three; leave it alone.
 */
async function runFirefoxPass({ stack, fixture }) {
  const probes = fixture.probes.filter((probe) =>
    ["ordinary", "mention", "comment"].includes(probe.key),
  );
  const readings = [];
  const failures = [];
  const { url } = await startFirefox(stack, stack.artifactDir);
  const session = await BidiSession.open(url);
  stack.addCleanup(() => session.close());
  await session.navigate(`${stack.webUrl}/`);
  const login = await session.json(
    `fetch('/api/auth/login', { method: 'POST' }).then(r => r.status)`,
  );
  if (login !== 200 && login !== 204)
    return {
      failures: [failure("firefox-login-failed", `status ${login}`)],
      readings,
    };

  for (const viewport of VIEWPORTS) {
    await session.viewport(viewport.width, viewport.height);
    await session.navigate(
      `${stack.webUrl}/projects/${fixture.slug}/issues/${fixture.number}`,
    );
    await session.run(probeSource(null));
    let settled = null;
    for (let attempt = 0; attempt < 200 && settled === null; attempt += 1) {
      const ready = await session.json(
        `{ paragraphs: window.__t427.paragraphs().length, slots: document.querySelectorAll('[data-ref-token], [data-mention-token], [data-comment-ref]').length }`,
      );
      if (
        ready.slots >= fixture.probes.length &&
        ready.paragraphs === fixture.probes.length + 1
      )
        settled = ready;
      else await sleep(100);
    }
    if (settled === null) {
      failures.push(
        failure("page-never-settled", "rich links never resolved", {
          browser: "firefox",
          viewport: viewport.name,
        }),
      );
      continue;
    }

    // The clipboard itself, before anything is read through it: headless
    // Firefox with a dead clipboard would report every path as "no selection".
    await session.json("window.__t427.focusPrime()");
    await bidiChord(session, "c");
    await sleep(120);
    await session.json("window.__t427.focusSink()");
    await bidiChord(session, "v");
    await sleep(150);
    const primed = await session.json("window.__t427.readSink()");
    if (primed.plain !== SENTINEL) {
      failures.push(
        failure(
          "clipboard-unavailable",
          `a keyboard copy of the sentinel pasted ${JSON.stringify(primed.plain)}`,
          { browser: "firefox", viewport: viewport.name },
        ),
      );
      continue;
    }
    await session.json("window.__t427.clearFocus()");

    for (const probe of probes) {
      const index = fixture.probes.indexOf(probe) + 1;
      for (const path of FIREFOX_PATHS) {
        await session.pointer([
          {
            type: "pointerMove",
            origin: "viewport",
            x: viewport.width - 2,
            y: viewport.height - 2,
          },
        ]);
        await sleep(150);
        await session.json("window.__t427.focusPrime()");
        await bidiChord(session, "c");
        await sleep(120);
        await session.json("window.__t427.clearFocus()");
        await session.json("window.__t427.resetDrag()");
        await session.json(`window.__t427.scrollTo(${index})`);
        await sleep(150);
        const points = await session.json(`window.__t427.points(${index})`);
        if (points.error || !points[path.from] || !points[path.to]) {
          failures.push(
            failure("probe-missing", points.error ?? "no point", {
              browser: "firefox",
              viewport: viewport.name,
              probe: probe.key,
              path: path.key,
            }),
          );
          continue;
        }
        await bidiDrag(session, points[path.from], points[path.to]);
        const selection = await session.json("window.__t427.selection()");
        await bidiChord(session, "c");
        await sleep(150);
        await session.json("window.__t427.focusSink()");
        await bidiChord(session, "v");
        await sleep(150);
        const pasted = await session.json("window.__t427.readSink()");
        const drags = await session.json("window.__t427.dragEvents");
        await session.json("window.__t427.clearFocus()");
        readings.push({
          viewport: viewport.name,
          probe: probe.key,
          path: path.key,
          verdict: verdictFor(pasted.plain ?? "", probe.identity),
          plain: pasted.plain,
          selectionRanges: selection.ranges,
          dragstart: drags,
        });
      }
    }
  }
  return { failures, readings };
}

function report(label, { failures, notes }) {
  console.log(
    `${label}: ${failures.length === 0 ? "ok" : `${failures.length} failure(s)`} ` +
      `notes=${JSON.stringify(notes)}`,
  );
  for (const one of failures) {
    const { name, detail, ...at } = one;
    console.log(`  ${name} ${JSON.stringify(at)}\n    ${detail}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(
    (arg) => !["--self-test", "--firefox", "--keep", "--help"].includes(arg),
  );
  if (argv.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  if (unknown.length > 0) {
    console.error(`unknown option(s): ${unknown.join(", ")}\n${HELP}`);
    return 2;
  }
  const selfTest = argv.includes("--self-test");
  const firefox = argv.includes("--firefox");
  if (firefox && selfTest) {
    console.error("--firefox is a measurement; it has no faults to inject");
    return 2;
  }
  let stack;
  try {
    stack = await createBrowserStack({
      root: ROOT,
      prefix: "t427-copy-",
      keep: argv.includes("--keep"),
    });
  } catch (error) {
    // Documented as 2: a run that never started is not a run that failed,
    // and another agent's smoke holding the repo lock is the usual reason.
    console.error(error);
    return 2;
  }
  let exit = 0;
  try {
    const fixture = await seedFixture(stack.serverPort);
    if (firefox) {
      const { failures, readings } = await runFirefoxPass({ stack, fixture });
      for (const one of readings) {
        console.log(
          `firefox ${one.viewport}/${one.probe}/${one.path}: ${one.verdict} ` +
            `plain=${JSON.stringify(one.plain)} ranges=${one.selectionRanges} ` +
            `dragstart=${one.dragstart}`,
        );
      }
      const drift = firefoxDrift(readings);
      for (const line of drift) console.log(`firefox note: ${line}`);
      console.log(
        `firefox expectations: ${drift.length} of ${
          Object.keys(FIREFOX_EXPECTED).length
        } off the table, recorded and not graded`,
      );
      report("firefox", {
        failures,
        notes: { readings: readings.length, drift: drift.length },
      });
      // Coverage only: what Firefox's own gesture does is recorded, not
      // graded. A missing reading is the thing that would leave the
      // trade-off unpriced all over again.
      return failures.length > 0 ? 2 : 0;
    }
    const browser = await startBrowser({
      dir: stack.artifactDir,
      registerChild: stack.registerChild,
    });
    stack.addCleanup(() => browser.close());

    const baseline = await runPass({ browser, stack, fixture, fault: null });
    report("baseline", baseline);
    if (baseline.failures.length > 0) {
      exit = baseline.failures.some((one) => COVERAGE_FAILURES.has(one.name))
        ? 2
        : 1;
    }

    if (selfTest) {
      if (baseline.failures.length > 0) {
        report("self-test", {
          failures: [
            failure(
              "self-test-baseline-not-clean",
              "a fault cannot be told from a standing failure",
            ),
          ],
          notes: {},
        });
        return 2;
      }
      for (const fault of Object.keys(FAULTS)) {
        const injected = await runPass({ browser, stack, fixture, fault });
        report(`fault ${fault}`, injected);
        const caught = injected.failures.filter(
          (one) => !COVERAGE_FAILURES.has(one.name),
        );
        if (injected.notes.faultApplied !== true) {
          console.log(`  fault ${fault} never reached the page`);
          exit = 2;
        } else if (caught.length === 0) {
          console.log(`  fault ${fault} went unnoticed`);
          exit = exit === 0 ? 2 : exit;
        }
      }
      const restored = await runPass({ browser, stack, fixture, fault: null });
      report("restored", restored);
      if (restored.failures.length > 0) exit = 2;
    }
  } catch (error) {
    console.error(error);
    exit = 2;
  } finally {
    await stack.cleanup();
  }
  return exit;
}

process.exitCode = await main();
