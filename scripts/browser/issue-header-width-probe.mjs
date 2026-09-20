/**
 * Description-header width probe, serialized into a real Chromium page by
 * scripts/lib/browser-cdp.mjs's evaluate(). No imports or closure dependencies.
 * The caller owns the authenticated page, route readiness and viewport (390px
 * for the regression; a desktop pass is useful too).
 *
 * Integration, on /projects/:slug/issues/:number with an editable issue:
 *   const plain = await evaluate(page, probeIssueHeaderWidth, {
 *     expectedEdited: false,
 *   });
 *   // PATCH the issue body through the API, reload and await the real header.
 *   const edited = await evaluate(page, probeIssueHeaderWidth, {
 *     expectedEdited: true, expectTruncation: true,
 *   });
 *   const broken = await evaluate(page, probeIssueHeaderWidth, {
 *     expectedEdited: true, expectTruncation: true,
 *   }, { timestampShrink0: true });
 *   // Require plain.ok && edited.ok; require broken.failures to include
 *   // "actions-outside-header" or "header-child-outside" for a geometry red.
 *   // Missing elements/font/pressure are coverage errors, NOT a successful red.
 *   // A source-level revert needs no fault argument: run the same clean probe.
 *
 * Seed both cases through the API (POST issue, then PATCH a different body),
 * rather than synthesizing an (edited) button. All measurements use the mounted
 * production header and its real UserChip, RevisionHistory and action buttons.
 * Only timestamp text/title and, optionally, its old class are changed; finally
 * restores them even on failure. Do not run concurrently with edits/navigation.
 */
export async function probeIssueHeaderWidth(options = {}, fault = {}) {
  const { expectedEdited = null, expectTruncation = false } = options;
  if (expectedEdited !== null && typeof expectedEdited !== "boolean") {
    throw new Error("expectedEdited must be a boolean or null");
  }
  if (fault && Object.keys(fault).some((key) => key !== "timestampShrink0")) {
    throw new Error("unknown issue-header width fault");
  }
  await document.fonts.ready;
  const coverageErrors = [];
  const failures = [];
  const epsilon = 0.5; // Subpixel rounding tolerance, not a layout target.
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
  };
  // Locate by semantics/structure, never by the class under test.
  const menus = [
    ...document.querySelectorAll('[aria-label="description actions"]'),
  ].filter(visible);
  if (menus.length !== 1) {
    return {
      ok: false,
      failures,
      coverageErrors: ["expected-one-description-header"],
    };
  }
  const menu = menus[0];
  const actions = menu.parentElement;
  const header = actions?.parentElement;
  const children = [...(header?.children ?? [])];
  const identity = children.find((child) =>
    child.matches('a[href^="/users/"]'),
  );
  const timestamp = children.find(
    (child) => child.tagName === "SPAN" && child.hasAttribute("title"),
  );
  const revision = children.find(
    (child) =>
      child.tagName === "BUTTON" && child.textContent.trim() === "(edited)",
  );
  const edit = actions?.querySelector('[aria-label="edit body"]');
  if (
    !identity ||
    !timestamp ||
    !edit ||
    !visible(edit) ||
    children.length !== (revision ? 4 : 3)
  ) {
    return {
      ok: false,
      failures,
      coverageErrors: ["unexpected-description-header-structure"],
    };
  }
  if (expectedEdited !== null && Boolean(revision) !== expectedEdited) {
    coverageErrors.push("unexpected-body-edited-state");
  }
  const style = getComputedStyle(timestamp);
  if (
    !style.fontFamily.includes("Geist") ||
    !document.fonts.check(`${style.fontSize} "Geist Variable"`)
  ) {
    coverageErrors.push("timestamp-font-not-loaded");
  }
  const original = {
    text: timestamp.textContent,
    title: timestamp.getAttribute("title"),
    className: timestamp.className,
  };
  const originalDate = new Date(original.title);
  if (
    !original.title ||
    Number.isNaN(originalDate.getTime()) ||
    originalDate.toLocaleString() !== original.text
  ) {
    failures.push("original-full-time-title-missing-or-mismatched");
  }

  const rectOf = (element) => {
    const r = element.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const contentOf = (element) => {
    const r = rectOf(element);
    const css = getComputedStyle(element);
    return {
      left:
        r.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft),
      right:
        r.right -
        parseFloat(css.borderRightWidth) -
        parseFloat(css.paddingRight),
    };
  };
  const buttons = [...actions.querySelectorAll("button")];
  const baselineButtons = buttons.map(rectOf);
  const baselineActions = rectOf(actions);
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const locale = formatter.resolvedOptions();
  // The existing browser smoke uses Chromium's Gregorian locale. Fail closed
  // if another calendar would make the Gregorian candidate ranges misleading.
  if (
    locale.calendar !== "gregory" ||
    getComputedStyle(header).direction !== "ltr"
  ) {
    coverageErrors.push("unsupported-calendar-or-direction");
  }
  if (coverageErrors.length)
    return { ok: false, failures, coverageErrors, locale };

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.fontKerning = style.fontKerning;
  if ("letterSpacing" in context) context.letterSpacing = style.letterSpacing;
  if ("wordSpacing" in context) context.wordSpacing = style.wordSpacing;
  const widthOf = (text) => context.measureText(text).width;
  const partsOf = (date) =>
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
  const dateAt = (year, month, day, hour = 12, minute = 0, second = 0) =>
    new Date(year, month - 1, day, hour, minute, second);
  const widest = (candidates, textOf) => {
    let winner = null;
    let width = -Infinity;
    for (const candidate of candidates) {
      const measured = widthOf(textOf(candidate));
      if (measured > width) {
        winner = candidate;
        width = measured;
      }
    }
    return winner;
  };
  const range = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  // Measure every legal value of each field, not a handy fixed timestamp or
  // repeated widest digit (which could create month 88 or minute 88).
  // Years are the complete four-digit ISO range; report that explicit domain.
  const year = widest(
    range(1000, 9999),
    (value) => partsOf(dateAt(value, 1, 1)).year,
  );
  const dates = [];
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= 31; day++) {
      const date = dateAt(year, month, day);
      if (date.getMonth() + 1 === month && date.getDate() === day)
        dates.push(date);
    }
  }
  // Joint month/day search respects short months and leap years, and measures
  // the entire string so separators/kerning participate in the choice.
  const date = widest(dates, (value) => value.toLocaleString());
  const makeTime = (hour, minute, second) =>
    dateAt(year, date.getMonth() + 1, date.getDate(), hour, minute, second);
  const minute = widest(
    range(0, 59),
    (value) => partsOf(makeTime(12, value, 0)).minute,
  );
  const second = widest(
    range(0, 59),
    (value) => partsOf(makeTime(12, minute, value)).second,
  );
  // Searching all 24 hours together also chooses the wider AM/PM period.
  const candidates = range(0, 23).map((hour) => makeTime(hour, minute, second));
  const stressDate = widest(candidates, (value) => value.toLocaleString());
  const stressText = stressDate.toLocaleString();
  const stressTitle = stressDate.toISOString();
  const fieldWidths = Object.fromEntries(
    Object.entries(partsOf(stressDate)).map(([key, value]) => [
      key,
      { value, width: widthOf(value) },
    ]),
  );

  try {
    timestamp.textContent = stressText;
    timestamp.setAttribute("title", stressTitle);
    if (fault?.timestampShrink0) {
      // Restore the exact pre-fix timestamp classes, leaving all neighbours
      // and the actual header untouched. Finally restores the caller's class.
      timestamp.className =
        "shrink-0 text-xs whitespace-nowrap text-muted-foreground";
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const headerRect = rectOf(header);
    const content = contentOf(header);
    const actionRect = rectOf(actions);
    const timestampRect = rectOf(timestamp);
    const childRects = children.map(rectOf);
    const buttonRects = buttons.map(rectOf);
    const textRange = document.createRange();
    textRange.selectNodeContents(timestamp);
    const naturalWidth = textRange.getBoundingClientRect().width;
    const css = getComputedStyle(timestamp);
    const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
    const requiredWidth =
      childRects.reduce(
        (sum, rect, index) =>
          sum + (children[index] === timestamp ? naturalWidth : rect.width),
        0,
      ) +
      gap * (children.length - 1);
    const pressure = requiredWidth > content.right - content.left + epsilon;
    const truncated = naturalWidth > timestampRect.width + epsilon;
    const within = (inner, outer) =>
      inner.left >= outer.left - epsilon &&
      inner.right <= outer.right + epsilon;
    const documentWidth = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
    // These are integer CSSOM dimensions: even one extra pixel is a failure.
    if (documentWidth.scrollWidth > documentWidth.clientWidth) {
      failures.push("document-scroll-overflow");
    }
    if (
      !within(headerRect, {
        left: 0,
        right: document.documentElement.clientWidth,
      })
    ) {
      failures.push("header-outside-viewport");
    }
    if (!within(actionRect, content)) failures.push("actions-outside-header");
    if (childRects.some((rect) => !within(rect, content)))
      failures.push("header-child-outside");
    if (header.scrollWidth > header.clientWidth + epsilon)
      failures.push("header-scroll-overflow");
    if (
      childRects.some(
        (rect, i) =>
          i > 0 && rect.left < childRects[i - 1].right + gap - epsilon,
      )
    ) {
      failures.push("header-neighbours-overlap");
    }
    if (timestampRect.width <= 0 || timestampRect.height <= 0)
      failures.push("timestamp-disappeared");
    if (
      Math.abs(actionRect.width - baselineActions.width) > epsilon ||
      buttonRects.some(
        (rect, i) =>
          Math.abs(rect.width - baselineButtons[i].width) > epsilon ||
          Math.abs(rect.height - baselineButtons[i].height) > epsilon ||
          !within(rect, actionRect),
      )
    ) {
      failures.push("action-buttons-lost-space");
    }
    if (
      pressure &&
      (!truncated ||
        css.textOverflow !== "ellipsis" ||
        css.overflowX !== "hidden" ||
        css.whiteSpace !== "nowrap")
    ) {
      failures.push("timestamp-not-truncated-under-pressure");
    }
    if (expectTruncation && !pressure)
      coverageErrors.push("insufficient-width-pressure");
    if (
      timestamp.title !== stressTitle ||
      new Date(timestamp.title).toLocaleString() !== stressText
    ) {
      failures.push("stress-full-time-title-missing-or-mismatched");
    }
    return {
      ok: failures.length === 0 && coverageErrors.length === 0,
      failures,
      coverageErrors,
      edited: Boolean(revision),
      fault: Boolean(fault?.timestampShrink0),
      viewportWidth: document.documentElement.clientWidth,
      documentWidth,
      timestamp: {
        text: stressText,
        title: stressTitle,
        yearDomain: [1000, 9999],
        locale,
        fieldWidths,
        naturalWidth,
        truncated,
      },
      geometry: {
        header: headerRect,
        content,
        actions: actionRect,
        timestamp: timestampRect,
        children: childRects,
        buttons: buttonRects,
        gap,
        requiredWidth,
        pressure,
      },
    };
  } finally {
    timestamp.textContent = original.text;
    timestamp.setAttribute("title", original.title);
    timestamp.className = original.className;
  }
}
