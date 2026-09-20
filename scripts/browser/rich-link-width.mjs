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
