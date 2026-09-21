/*
 * Browser probe for the surfaces a long display name pushes off screen.
 * Serialized into a real Chromium page by scripts/lib/browser-cdp.mjs's
 * evaluate(), so it has no imports and can only reach the DOM.
 *
 * Two surfaces, one page: the shell header's account button (T-500) and an
 * event row's inline author (T-501). Both are `UserChip` under a name that
 * does not fit, and each was measured running past a 390px viewport — 572 and
 * 475 — while the issue header's own chip, fixed in T-486, stayed inside.
 *
 * What counts as "off screen" is the painted box, not the layout box. A chip
 * that ellipsises still has a full-width name span inside it; that span's
 * rectangle reaches past the viewport and is clipped to nothing, and reading
 * rectangles alone reports it as an overflow that no reader can see and no
 * scrollbar answers. Every rectangle here is intersected with the clipping
 * ancestors above it first.
 */

/**
 * Run inside Chromium. `faults` restores a pre-fix shape before measuring and
 * is undone by the caller reloading, never by this function: a clean read on a
 * mutated page is not a restore.
 */
export async function probeLongNameOverflow(options = {}) {
  const {
    faults = {},
    expectPressure = true,
    // Which surfaces this page is expected to draw: the issue list has no
    // event row, and a surface the page never had is not a missing one.
    surfaces: graded = ["account-button", "event-author"],
  } = options;
  const known = ["accountUnshrinkable", "chipUncapped"];
  if (Object.keys(faults).some((key) => !known.includes(key))) {
    throw new Error("unknown long-name fault");
  }
  await document.fonts.ready;

  const round = (value) =>
    Number.isFinite(value) ? Number(value.toFixed(3)) : null;
  const clips = (value) => ["auto", "clip", "hidden", "scroll"].includes(value);
  /** The box actually painted: the rectangle, cut down by every clipper. */
  const paintedRight = (element) => {
    const box = element.getBoundingClientRect();
    let right = box.right;
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (!clips(style.overflowX)) continue;
      const bounds = parent.getBoundingClientRect();
      const margin = parseFloat(style.overflowClipMargin) || 0;
      right = Math.min(right, bounds.right + margin);
    }
    return right;
  };
  const viewport = document.documentElement.clientWidth;

  const header = document.querySelector("header");
  const row = header?.querySelector(":scope > div");
  const account = row
    ? [...row.querySelectorAll("button")].find((button) =>
        button.querySelector('[data-slot="avatar"]'),
      )
    : null;
  const eventAuthor = document.querySelector(
    '[id^="event-"] a[href^="/users/"]',
  );

  if (faults.accountUnshrinkable && account) {
    // The cluster and the button as they stood before T-500: content-sized and
    // refusing to narrow, so the name has no way to reach the ellipsis.
    account.parentElement.style.flex = "0 0 auto";
    account.parentElement.style.minWidth = "auto";
    account.style.flexShrink = "0";
    account.style.minWidth = "auto";
  }
  if (faults.chipUncapped) {
    // The chip's percentage cap taken off, which is what let an inline-block
    // author in a sentence grow without bound before T-501.
    const style = document.createElement("style");
    style.dataset.longNameFault = "chipUncapped";
    style.textContent =
      'a[href^="/users/"], span[class*="inline-block"]{max-width:none !important}';
    document.head.append(style);
  }
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

  const coverageErrors = [];
  const failures = [];
  const surfaces = {};
  const measure = (name, element) => {
    if (!element) {
      coverageErrors.push(`${name}-not-rendered`);
      return;
    }
    const box = element.getBoundingClientRect();
    const painted = paintedRight(element);
    // The name inside the chip, which is what ellipsises; a case where it has
    // not been asked to give anything up is a case that graded nothing.
    const text = element.querySelector("span.ml-1\\.5");
    const truncating = text?.parentElement ?? null;
    const ellipsised =
      truncating !== null &&
      truncating.scrollWidth > truncating.clientWidth + 0.5;
    surfaces[name] = {
      width: round(box.width),
      right: round(box.right),
      paintedRight: round(painted),
      pastViewport: round(painted - viewport),
      ellipsised,
      title: element.getAttribute("title"),
      text: element.textContent.trim().length,
    };
    if (painted > viewport + 0.5) failures.push(`${name}-past-viewport`);
    if (expectPressure && !ellipsised) {
      coverageErrors.push(`${name}-name-not-under-pressure`);
    }
  };
  if (graded.includes("account-button")) measure("account-button", account);
  if (graded.includes("event-author")) measure("event-author", eventAuthor);

  // Anything else painting past the right edge, named rather than summarised:
  // the page-wide number is only meaningful if a reader can see what moved it.
  const strays = [];
  for (const element of document.querySelectorAll("body *")) {
    if (paintedRight(element) <= viewport + 1) continue;
    if (
      [...element.children].some((child) => paintedRight(child) > viewport + 1)
    )
      continue;
    strays.push({
      right: round(paintedRight(element)),
      tag: element.tagName.toLowerCase(),
      className: (element.className?.baseVal ?? element.className ?? "")
        .toString()
        .slice(0, 60),
    });
  }
  const documentWidth = {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: viewport,
  };
  // Integer CSSOM dimensions: one pixel over is a page that scrolls sideways.
  if (documentWidth.scrollWidth > documentWidth.clientWidth) {
    failures.push("document-scroll-overflow");
  }
  if (strays.length > 0) failures.push("painted-past-viewport");

  return {
    ok: failures.length === 0 && coverageErrors.length === 0,
    failures,
    coverageErrors,
    faults: Object.keys(faults),
    graded,
    viewport,
    documentWidth,
    surfaces,
    strays: strays.slice(0, 8),
  };
}
