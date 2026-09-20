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
 * The other direction of pressure is the author's own name: PATCH /me with a
 * display name at the schema's 200-character maximum and run the same probe,
 * where `document-scroll-overflow` and `timestamp-disappeared` are what T-486
 * grades. `identityShrink0` is its red, restoring the chip's pre-fix box.
 *
 * The row it reads holds two children: the box T-487 gave the participants
 * that share a baseline, and the action group. Everything graded per element
 * is in the first of those, and its content box is the width budget.
 *
 * Seed both cases through the API (POST issue, then PATCH a different body),
 * rather than synthesizing an (edited) button. All measurements use the mounted
 * production header and its real UserChip, RevisionHistory and action buttons.
 * Only timestamp text/title and, optionally, one of the two pre-fix classes are
 * changed; finally restores them even on failure. Do not run concurrently with
 * edits or navigation.
 */
export async function probeIssueHeaderWidth(options = {}, fault = {}) {
  const { expectedEdited = null, expectTruncation = false } = options;
  if (expectedEdited !== null && typeof expectedEdited !== "boolean") {
    throw new Error("expectedEdited must be a boolean or null");
  }
  if (
    fault &&
    Object.keys(fault).some(
      (key) => !["timestampShrink0", "identityShrink0"].includes(key),
    )
  ) {
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
  // T-487 put the participants that share the header's baseline in a box of
  // their own, so the row now holds two children and the identity, timestamp
  // and edited marker are one level further in. The width budget the checks
  // below grade is that box's, not the row's.
  const line = [...(header?.children ?? [])].find(
    (child) => child !== actions && child.querySelector('a[href^="/users/"]'),
  );
  const children = [...(line?.children ?? [])];
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
    header.children.length !== 2 ||
    children.length !== (revision ? 3 : 2)
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
  // What the chip gives up, it gives up in a box of its own inside the anchor
  // (T-486). The chip itself must not clip — an agent's badge hangs outside
  // the avatar's box, and a clipping chip both clips that and takes over as
  // the first clipping ancestor T-416 walks out to. Neither is visible in the
  // widths below, so both are preconditions of the identity checks rather
  // than one of them.
  // The avatar rides in a positioned span of its own (T-487), so the box that
  // truncates is the sibling that holds no avatar.
  const truncating = [...identity.children].find(
    (child) =>
      child.tagName === "SPAN" &&
      child.querySelector('[data-slot="avatar"]') === null,
  );
  if (
    !fault?.identityShrink0 &&
    (getComputedStyle(identity).overflowX !== "visible" ||
      truncating === undefined ||
      getComputedStyle(truncating).overflowX === "visible" ||
      getComputedStyle(truncating).textOverflow !== "ellipsis")
  ) {
    coverageErrors.push("identity-truncating-box-missing");
  }
  const original = {
    text: timestamp.textContent,
    title: timestamp.getAttribute("title"),
    className: timestamp.className,
    identityClassName: identity.className,
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

  // Copy the actual text styles, including kerning, letter/word spacing,
  // variable-font axes and feature settings. DOM shaping avoids approximating
  // those settings with a canvas font shorthand. Measure an unclipped text
  // range, not the timestamp's flex allocation or an isolated sum of fields.
  const measurement = document.createElement("span");
  for (const property of style) {
    measurement.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(measurement.style, {
    position: "fixed",
    inset: "0 auto auto 0",
    display: "inline-block",
    visibility: "hidden",
    pointerEvents: "none",
    width: "max-content",
    minWidth: "0",
    maxWidth: "none",
    height: "auto",
    overflow: "visible",
    whiteSpace: "nowrap",
    transform: "none",
    animation: "none",
    transition: "none",
  });
  const measurementRange = document.createRange();
  const measuredWidths = new Map();
  const widthOf = (text) => {
    if (!measuredWidths.has(text)) {
      measurement.textContent = text;
      measurementRange.selectNodeContents(measurement);
      measuredWidths.set(text, measurementRange.getBoundingClientRect().width);
    }
    return measuredWidths.get(text);
  };
  const partsOf = (date) =>
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
  const dateAt = (year, month, day, hour, minute, second) => {
    const date = new Date(year, month - 1, day, hour, minute, second);
    // Reject short-month/leap-day rollovers and nonexistent local DST times.
    return date.getFullYear() === year &&
      date.getMonth() + 1 === month &&
      date.getDate() === day &&
      date.getHours() === hour &&
      date.getMinutes() === minute &&
      date.getSeconds() === second
      ? date
      : null;
  };
  const fieldsOf = (date) => [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  // Seed with the concrete kerning counterexample to the former per-field
  // choice (2000). Strict improvements can never finish narrower than this
  // complete 5000 string, measured in the current locale and actual styles.
  let stressDate = dateAt(5000, 10, 20, 10, 0, 0);
  if (!stressDate) {
    coverageErrors.push("counterexample-local-date-unavailable");
    return { ok: false, failures, coverageErrors, locale };
  }
  const search = {
    strategy: "full-string cyclic coordinate ascent",
    measurement: "DOM Range with timestamp computed styles",
    blocks: ["year", "month/day", "hour/dayPeriod", "minute", "second"],
    domains: {
      year: [1000, 9999],
      month: [1, 12],
      day: [1, 31],
      hour: [0, 23],
      minute: [0, 59],
      second: [0, 59],
    },
    passes: 0,
    improvements: 0,
    converged: false,
    globalMaximumProven: false,
  };
  let fieldWidths;
  document.body.append(measurement);
  try {
    let bestWidth = widthOf(stressDate.toLocaleString());
    search.counterexample = {
      text: stressDate.toLocaleString(),
      title: stressDate.toISOString(),
      width: bestWidth,
    };
    const consider = (fields) => {
      const candidate = dateAt(...fields);
      if (!candidate) return;
      // Every candidate is scored as the real, complete display string;
      // literals and shaping across field boundaries participate in the score.
      const width = widthOf(candidate.toLocaleString());
      if (width > bestWidth) {
        stressDate = candidate;
        bestWidth = width;
        search.improvements++;
      }
    };
    // Each block holds the other fields fixed. Revisit all blocks after any
    // improvement, since changing a neighbour can change kerning. Ties retain
    // the incumbent. Cached deterministic widths and strictly increasing
    // accepted scores on a finite legal domain guarantee termination; this is
    // a coordinate-wise optimum, not an exhaustive global-maximum proof.
    let previousWidth;
    do {
      previousWidth = bestWidth;
      search.passes++;
      let fields = fieldsOf(stressDate);
      for (let year = 1000; year <= 9999; year++) {
        consider([year, ...fields.slice(1)]);
      }
      fields = fieldsOf(stressDate);
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= 31; day++) {
          consider([fields[0], month, day, ...fields.slice(3)]);
        }
      }
      fields = fieldsOf(stressDate);
      // All 24 local hours search hour and dayPeriod together.
      for (let hour = 0; hour <= 23; hour++) {
        consider([...fields.slice(0, 3), hour, ...fields.slice(4)]);
      }
      fields = fieldsOf(stressDate);
      for (let minute = 0; minute <= 59; minute++) {
        consider([...fields.slice(0, 4), minute, fields[5]]);
      }
      fields = fieldsOf(stressDate);
      for (let second = 0; second <= 59; second++) {
        consider([...fields.slice(0, 5), second]);
      }
    } while (bestWidth > previousWidth);
    search.converged = true;
    search.selectedWidth = bestWidth;
    search.measuredStrings = measuredWidths.size;
    // Retain the diagnostic interface; these isolated widths do not select
    // candidates and must not be summed to infer the full string's width.
    fieldWidths = Object.fromEntries(
      Object.entries(partsOf(stressDate)).map(([key, value]) => [
        key,
        { value, width: widthOf(value) },
      ]),
    );
  } finally {
    measurement.remove();
  }
  const stressText = stressDate.toLocaleString();
  const stressTitle = stressDate.toISOString();

  try {
    timestamp.textContent = stressText;
    timestamp.setAttribute("title", stressTitle);
    if (fault?.timestampShrink0) {
      // Restore the exact pre-fix timestamp classes, leaving all neighbours
      // and the actual header untouched. Finally restores the caller's class.
      timestamp.className =
        "shrink-0 text-xs whitespace-nowrap text-muted-foreground";
    }
    if (fault?.identityShrink0) {
      // The same, for the chip T-486 taught to give its name up: the box it
      // carried before, with the `hover:underline` the call site adds. T-487's
      // half of that box stays — `relative ps-5` is what reserves the avatar it
      // positions, and taking it away would inject a second, different fault.
      identity.className =
        "inline-block shrink-0 whitespace-nowrap relative ps-5 text-sm hover:underline";
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const headerRect = rectOf(header);
    const content = contentOf(header);
    const lineRect = rectOf(line);
    const lineContent = contentOf(line);
    const actionRect = rectOf(actions);
    const timestampRect = rectOf(timestamp);
    const childRects = children.map(rectOf);
    const buttonRects = buttons.map(rectOf);
    const textRange = document.createRange();
    textRange.selectNodeContents(timestamp);
    const naturalWidth = textRange.getBoundingClientRect().width;
    const css = getComputedStyle(timestamp);
    const gap = parseFloat(getComputedStyle(line).columnGap) || 0;
    // The group wraps (T-487), so "what has to fit" is a row of it, not all of
    // it: three participants that together exceed the width simply take two
    // rows, and reading them as one row invents a shortage that is not there.
    const rowOf = (rect) =>
      childRects.findIndex(
        (other) => Math.abs(other.top - rect.top) <= epsilon,
      );
    const rows = childRects.map(rowOf);
    const timestampRow = rows[children.indexOf(timestamp)];
    const rowIndexes = children
      .map((_, index) => index)
      .filter((index) => rows[index] === timestampRow);
    const requiredWidth =
      rowIndexes.reduce(
        (sum, index) =>
          sum +
          (children[index] === timestamp
            ? naturalWidth
            : childRects[index].width),
        0,
      ) +
      gap * (rowIndexes.length - 1);
    const pressure =
      requiredWidth > lineContent.right - lineContent.left + epsilon;
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
    // Two boxes to stay inside now: the baseline group inside the row, and
    // every participant inside the group. A chip that overflows its own box
    // and a group that overflows the row are the same symptom one level apart.
    if (
      !within(lineRect, content) ||
      childRects.some((rect) => !within(rect, lineContent))
    )
      failures.push("header-child-outside");
    // The row, not the group: the group's own scrollable overflow now carries
    // the chip's clip margin, which is the bot badge's reserved overhang and
    // not a layout fault.
    if (header.scrollWidth > header.clientWidth + epsilon)
      failures.push("header-scroll-overflow");
    if (
      childRects.some(
        (rect, i) =>
          i > 0 &&
          rows[i] === rows[i - 1] &&
          rect.left < childRects[i - 1].right + gap - epsilon,
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
      fault:
        Boolean(fault?.timestampShrink0) || Boolean(fault?.identityShrink0),
      viewportWidth: document.documentElement.clientWidth,
      documentWidth,
      identity: {
        text: identity.textContent,
        width: rectOf(identity).width,
        overflowX: getComputedStyle(identity).overflowX,
        truncating: truncating
          ? {
              width: rectOf(truncating).width,
              overflowX: getComputedStyle(truncating).overflowX,
              textOverflow: getComputedStyle(truncating).textOverflow,
            }
          : null,
      },
      timestamp: {
        text: stressText,
        title: stressTitle,
        yearDomain: [1000, 9999],
        locale,
        fieldWidths,
        search,
        naturalWidth,
        truncated,
      },
      geometry: {
        header: headerRect,
        content,
        line: lineRect,
        lineContent,
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
    identity.className = original.identityClassName;
  }
}
