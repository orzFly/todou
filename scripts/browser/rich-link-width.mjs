/** Shared by the copy smoke and the focused width regression. */
export function checkParagraphOverflow(overflow, at = {}) {
  return overflow.paragraphsOver.length === 0
    ? []
    : [
        {
          name: "paragraph-overflows-horizontally",
          detail: JSON.stringify(overflow.paragraphsOver),
          ...at,
        },
      ];
}

/** Serialized into a real mounted MarkdownView, including its flow guard. */
export async function probeRichLinkWidth() {
  await document.fonts.ready;
  const ordinary = document
    .querySelector(".ref-chip-body.border [data-ref-token]")
    ?.closest("a");
  const comment = [
    ...document.querySelectorAll(".comment-link-body.border"),
  ].find((link) => !link.querySelector("[data-comment-title]"));
  if (!ordinary || !comment) return { coverageErrors: ["width-chips-missing"] };
  const root = ordinary.closest(".markdown-body");
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:0;top:0;visibility:hidden;width:380px";
  const cases = [];
  const readings = [];
  const failures = [];
  const overflow = (paragraph, link) =>
    Math.max(
      0,
      ...[...link.getClientRects()].map(
        (rect) => rect.right - paragraph.getBoundingClientRect().right,
      ),
    );
  try {
    for (const [kind, source] of [
      ["ordinary", ordinary],
      ["comment", comment],
    ]) {
      // Scan thresholds, not expected absolute geometry. Each sample has the
      // same rendered font/skin, with an identity not pinned by a title budget.
      for (let width = 120; width <= 360; width += 0.25) {
        const paragraph = document.createElement("p");
        paragraph.style.cssText = `width:${width}px;position:absolute;top:0;left:0`;
        const link = source.cloneNode(true);
        if (kind === "comment") {
          // The first break unit remains ' by'; later author words expose it.
          link.querySelector("[data-comment-author]").textContent =
            " by Alice Neutral Wideword";
        } else {
          link.querySelector("[data-ref-token]").textContent =
            "neutral-project/NEUTRAL-123456789";
          link.querySelector(".ref-chip-title")?.remove();
        }
        paragraph.append(link);
        host.append(paragraph);
        cases.push({ kind, width, paragraph, link });
      }
    }
    root.append(host);
    // Before the guard's mutation/resize frame, record the actual old layout.
    for (const sample of cases)
      sample.before = overflow(sample.paragraph, sample.link);
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    for (const kind of ["ordinary", "comment"]) {
      let fixedOver = 0;
      let brokenOver = 0;
      let safeChanged = 0;
      let maxFixed = 0;
      let maxBroken = 0;
      const exampleWidths = [];
      for (const sample of cases.filter((one) => one.kind === kind)) {
        const { paragraph, link, width, before } = sample;
        const fixed = overflow(paragraph, link);
        const padding = paragraph.style.paddingRight;
        if (
          before <= 0.05 &&
          parseFloat(getComputedStyle(paragraph).paddingRight) > 0
        )
          safeChanged++;
        maxFixed = Math.max(maxFixed, fixed);
        if (fixed > 0.05) fixedOver++;
        // Fault injection restores the old budget synchronously on the same
        // DOM; no competing animation frame can repair it before the reading.
        paragraph.style.setProperty("padding-right", "0px", "important");
        const broken = overflow(paragraph, link);
        maxBroken = Math.max(maxBroken, broken);
        if (broken > 0.05) {
          brokenOver++;
          if (exampleWidths.length < 3) exampleWidths.push(width);
        }
        paragraph.style.removeProperty("padding-right");
        if (padding) paragraph.style.paddingRight = padding;
      }
      if (fixedOver) failures.push(`${kind}-fragment-outside-paragraph`);
      if (!brokenOver) failures.push(`${kind}-fault-not-detected`);
      if (safeChanged) failures.push(`${kind}-safe-flow-changed`);
      readings.push({
        kind,
        samples: cases.filter((one) => one.kind === kind).length,
        fixedOver,
        brokenOver,
        safeChanged,
        maxFixed,
        maxBroken,
        exampleWidths,
      });
    }
    for (const { paragraph } of cases) paragraph.remove();
    // Tight lists are different: both the parent and child own inline chips.
    // An ancestor payment can turn an initially safe child into an overflow.
    // Exercise both DOM orders; discovery order alone is not ancestor order.
    for (const parentFirst of [true, false]) {
      const nested = [];
      // Keep the child wide enough for the uncapped cloned identity: this
      // fixture isolates ancestor-induced overflow, not identity allocation.
      for (let width = 160; width <= 420; width += 0.25) {
        const list = document.createElement("ul");
        list.style.cssText = `width:${width}px;position:absolute;top:0;left:0`;
        const parent = document.createElement("li");
        const childList = document.createElement("ul");
        const child = document.createElement("li");
        const parentChip = comment.cloneNode(true);
        const childChip = comment.cloneNode(true);
        for (const chip of [parentChip, childChip])
          chip.querySelector("[data-comment-author]").textContent =
            " by Alice Neutral Wideword";
        child.append(childChip);
        childList.append(child);
        parent.append(
          ...(parentFirst ? [parentChip, childList] : [childList, parentChip]),
        );
        list.append(parent);
        host.append(list);
        nested.push({ list, parent, child, parentChip, childChip, width });
      }
      const parentOnly = nested.filter(
        ({ parent, child, parentChip, childChip }) =>
          overflow(parent, parentChip) > 0.05 &&
          overflow(child, childChip) <= 0.05,
      );
      if (!parentOnly.length)
        failures.push("nested-parent-only-pressure-missing");
      await new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
      );
      const over = nested.flatMap(
        ({ parent, child, parentChip, childChip, width }) => {
          const parentOver = overflow(parent, parentChip);
          const childOver = overflow(child, childChip);
          return parentOver > 0.05 || childOver > 0.05
            ? [{ width, parentOver, childOver }]
            : [];
        },
      );
      readings.push({
        kind: parentFirst ? "nested-parent-first" : "nested-parent-last",
        samples: nested.length,
        fixedOver: over.length,
        parentOnlyBefore: parentOnly.length,
        childPaymentsAfter: parentOnly.filter(
          ({ child }) =>
            parseFloat(child.style.getPropertyValue("--ref-chip-gutter")) > 0,
        ).length,
        examples: over.slice(0, 3),
      });
      if (over.length) failures.push("parent-payment-created-child-overflow");
      for (const { list } of nested) list.remove();
    }
    // Loose/nested lists must pay at the actual paragraph, not every ancestor.
    const list = document.createElement("ul");
    list.innerHTML = '<li><ul><li><p style="width:123px"></p></li></ul></li>';
    const paragraph = list.querySelector("p");
    const link = comment.cloneNode(true);
    link.querySelector("[data-comment-author]").textContent =
      " by Alice Neutral Wideword";
    paragraph.append(link);
    host.append(list);
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    if (
      [...list.querySelectorAll("li")].some(
        (li) => parseFloat(getComputedStyle(li).paddingRight) > 0,
      )
    )
      failures.push("ancestor-flow-charged");
    if (overflow(paragraph, link) > 0.05)
      failures.push("nested-flow-overflows");
    // A formerly unsafe flow must release its padding when its text changes.
    link.querySelector("[data-comment-author]").textContent = " by A";
    paragraph.style.width = "360px";
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    if (parseFloat(getComputedStyle(paragraph).paddingRight) !== 0)
      failures.push("safe-resize-kept-gutter");
    // Removing all chips restores the original inline properties, including
    // the custom-property override used to isolate nested flow budgets.
    link.remove();
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    if (
      paragraph.style.paddingRight !== "" ||
      paragraph.style.getPropertyValue("--ref-chip-gutter") !== ""
    )
      failures.push("removed-chip-kept-flow-style");
    // Paragraph-local overflow must fail independently of document overflow.
    const injected = document.createElement("p");
    injected.style.width = "200px";
    const child = document.createElement("span");
    child.style.cssText = "display:inline-block;width:210px";
    injected.append(child);
    host.append(injected);
    return {
      readings,
      failures,
      coverageErrors: [],
      injectedOverflow: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        paragraphsOver: [
          { index: 0, by: injected.scrollWidth - injected.clientWidth },
        ].filter(({ by }) => by > 0),
      },
    };
  } finally {
    host.remove();
  }
}

/**
 * Flex siblings divide one line's width between them, so a payment at one of
 * them comes out of the other and no ordering can help: they are the same
 * depth. `<summary>` is this repo's own flex row, and a blank line inside one
 * is all the Markdown it takes (T-496).
 *
 * One DOM order per call. The guard's pass over a thousand samples and the
 * thirty frames this waits out afterwards do not share a CDP evaluate's
 * budget with probeRichLinkWidth's own scans.
 */
export async function probeSummaryFlexWidth(wideFirst) {
  await document.fonts.ready;
  const comment = [
    ...document.querySelectorAll(".comment-link-body.border"),
  ].find((link) => !link.querySelector("[data-comment-title]"));
  if (!comment) return { coverageErrors: ["width-chips-missing"] };
  const root = comment.closest(".markdown-body");
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:0;top:0;visibility:hidden;width:380px";
  const failures = [];
  const overflow = (paragraph, link) =>
    Math.max(
      0,
      ...[...link.getClientRects()].map(
        (rect) => rect.right - paragraph.getBoundingClientRect().right,
      ),
    );
  try {
    // Two authors of different widths, in both orders across calls: which
    // sibling pays decides which one gets the bill.
    const authors = [" by Alice Neutral Wideword", " by Alice Neutral"];
    const summaries = [];
    for (let width = 160; width <= 420; width += 0.25) {
      const details = document.createElement("details");
      details.style.cssText = `width:${width}px;position:absolute;top:0;left:0`;
      const summary = document.createElement("summary");
      const paragraphs = (wideFirst ? authors : [...authors].reverse()).map(
        (author) => {
          const paragraph = document.createElement("p");
          const chip = comment.cloneNode(true);
          chip.querySelector("[data-comment-author]").textContent = author;
          paragraph.append(chip);
          summary.append(paragraph);
          return { paragraph, chip };
        },
      );
      details.append(summary);
      host.append(details);
      summaries.push({ width, details, paragraphs });
    }
    const worst = ({ paragraphs }) =>
      Math.max(
        ...paragraphs.map(({ paragraph, chip }) => overflow(paragraph, chip)),
      );
    root.append(host);
    // Before the guard's mutation/resize frame, record the actual old layout.
    const pressured = summaries.filter((one) => worst(one) > 0.05);
    // Without a sample the guard has to act on, "no overflow afterwards" is a
    // reading about an empty set.
    if (!pressured.length) failures.push("summary-flex-pressure-missing");
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    const settled = summaries.flatMap((one) =>
      worst(one) > 0.05 ? [{ width: one.width, over: worst(one) }] : [],
    );
    if (settled.length) failures.push("sibling-payment-created-overflow");

    // Settled has to mean the guard stopped writing, not that the number
    // stopped moving: a flow that re-pays every frame reads zero and still
    // reflows the page forever. Every pass restores before it re-pays, so a
    // flow that is paying cannot run one without writing.
    let writes = 0;
    const watch = new MutationObserver((records) => {
      writes += records.length;
    });
    for (const { details } of summaries)
      watch.observe(details, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    for (let frame = 0; frame < 30; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    writes += watch.takeRecords().length;
    watch.disconnect();
    if (writes) failures.push("summary-flex-guard-kept-writing");

    // The fix is those four inline properties and nothing else, so taking them
    // back off is the chip as it shipped — the same payment, unfrozen. Read in
    // the same frame: the guard's own resize notification puts them back on
    // the next one.
    const frozen = ["flex-grow", "flex-shrink", "flex-basis", "min-width"];
    for (const { paragraphs } of summaries)
      for (const { paragraph } of paragraphs)
        for (const property of frozen) paragraph.style.removeProperty(property);
    const unfrozen = summaries.flatMap((one) =>
      worst(one) > 0.05 ? [{ width: one.width, over: worst(one) }] : [],
    );
    if (!unfrozen.length) failures.push("summary-flex-fault-not-detected");

    // A guard that had merely stopped running would have been quiet too.
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
    );
    const refrozen = summaries.filter(({ paragraphs }) =>
      paragraphs.some(({ paragraph }) =>
        paragraph.style.getPropertyValue("flex-basis"),
      ),
    ).length;
    if (!refrozen) failures.push("summary-flex-guard-not-live");
    if (summaries.some((one) => worst(one) > 0.05))
      failures.push("summary-flex-did-not-recover");

    return {
      failures,
      coverageErrors: [],
      readings: [
        {
          kind: wideFirst ? "summary-wide-first" : "summary-wide-last",
          samples: summaries.length,
          pressuredBefore: pressured.length,
          fixedOver: settled.length,
          unfrozenOver: unfrozen.length,
          quietWrites: writes,
          refrozen,
          examples: settled.slice(0, 3),
          unfrozenExamples: unfrozen.slice(0, 3),
        },
      ],
    };
  } finally {
    host.remove();
  }
}
