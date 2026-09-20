/*
 * Browser probe for T-487: the agent pill a comment header draws against the
 * one an event row draws, property by property.
 *
 * The user named the event row as the reference — "现在 event 的实现是完全
 * 正确的" — so this compares the two rather than asserting numbers of its
 * own. Every property below is either a relation inside one pill (where the
 * text sits between the pill's own edges) or a value both pills must agree
 * on; none is a height at a viewport width, which T-445 forbids because a
 * rendered timestamp's width moves those.
 *
 * Like split-header-probe.mjs this module has no imports: the runner
 * serializes the function with `fn.toString()` and evaluates it in the page,
 * so it can only reach the DOM.
 */

/**
 * Run inside Chromium. Measures both pills, and — in the same pass — measures
 * them again with the rule this card removed put back, because a comparison
 * that has never been shown to fail is not evidence that it holds.
 */
export function probePillParity() {
  // Declared in here rather than beside the module's other prose: the runner
  // ships this function through `fn.toString()`, so a name from module scope
  // is a ReferenceError in the page and not a constant.
  const EPSILON = 0.125;
  const header = document.querySelector(
    "#fixture-comment-item-agent-session [data-testid='agent-context-badge']",
  );
  const event = document.querySelector(
    "#fixture-agent-event-row [data-testid='agent-context-badge']",
  );
  if (!header || !event) {
    // Which half is missing, and whether its section is even on the page:
    // the event row only draws a pill for an event that carries agent
    // context, and a seed that writes none looks exactly like a pill that
    // stopped rendering.
    const section = (id) =>
      document.getElementById(id) === null ? "no section" : "section, no pill";
    return {
      status: "error",
      reason:
        `pills not drawn (header: ${header ? "ok" : section("fixture-comment-item-agent-session")}, ` +
        `event: ${event ? "ok" : section("fixture-agent-event-row")})`,
    };
  }

  const round = (value) => Math.round(value * 1000) / 1000;
  const shape = (pill) => {
    const text = pill.querySelector("span.truncate");
    const icon = pill.querySelector("svg");
    if (!text || !icon) return null;
    const box = pill.getBoundingClientRect();
    const run = text.getBoundingClientRect();
    const mark = icon.getBoundingClientRect();
    const pillStyle = getComputedStyle(pill);
    const textStyle = getComputedStyle(text);
    return {
      // The box the text sits in, and how the two are arranged in it.
      //
      // `display` is deliberately absent: below `sm` the event row is not a
      // flex container, so its pill keeps the `inline-flex` the badge asks
      // for while the header's — a flex item there — blockifies to `flex`.
      // That difference is the row around the pill, not the pill, and
      // `alignItems` below is the half of it that decides anything.
      height: round(box.height),
      alignItems: pillStyle.alignItems,
      paddingBlock: `${pillStyle.paddingTop}/${pillStyle.paddingBottom}`,
      gap: pillStyle.columnGap,
      fontSize: textStyle.fontSize,
      lineHeight: textStyle.lineHeight,
      // Where the text is between the pill's own edges: this pair is what
      // "the text moves inside its own box" shows up as, and it was 1/4.72
      // in the header against 2.86/2.86 in the event row (T-487).
      textFromTop: round(run.top - box.top),
      textFromBottom: round(box.bottom - run.bottom),
      iconFromTop: round(mark.top - box.top),
      iconHeight: round(mark.height),
      iconToText: round(run.left - mark.right),
    };
  };

  const compare = () => {
    const a = shape(header);
    const b = shape(event);
    if (!a || !b)
      return { differing: ["shape unavailable"], header: a, event: b };
    const differing = Object.keys(a).filter((key) =>
      typeof a[key] === "number"
        ? Math.abs(a[key] - b[key]) > EPSILON
        : a[key] !== b[key],
    );
    return { differing, header: a, event: b };
  };

  const clean = compare();
  // The fault this card removed, put back on the header's pill alone: with
  // it the model name hangs from the header's baseline inside a box of fixed
  // height, which is the shape the user reported.
  //
  // The badge's own `items-center` comes off with it, because that is what
  // the source did: the caller's class reaches the element through `cn`,
  // whose merge drops the base class it conflicts with. Added alongside
  // instead, the two are one property in one layer and the stylesheet's own
  // order decides — which it does in favour of `items-center`, leaving a
  // fault that changes nothing and a check that cannot fail.
  header.classList.remove("items-center");
  header.classList.add("items-baseline");
  const faulted = compare();
  header.classList.remove("items-baseline");
  header.classList.add("items-center");
  const restored = compare();

  return {
    status: "ok",
    clean: clean.differing,
    faulted: faulted.differing,
    restored: restored.differing,
    shapes: { header: clean.header, event: clean.event },
  };
}

/**
 * The verdict, outside the page. Parity is only evidence if the same
 * comparison goes red on the damaged pill, so both halves are required.
 */
export function assessPillParity(measured) {
  if (!measured || measured.status !== "ok") {
    return [measured?.reason ?? "pill parity did not run"];
  }
  const failures = [];
  if (measured.clean.length > 0) {
    failures.push(
      `header and event pills differ on: ${measured.clean.join(", ")}`,
    );
  }
  if (measured.faulted.length === 0) {
    failures.push(
      "the comparison did not notice `items-baseline` back on the header's pill",
    );
  }
  if (measured.restored.length > 0) {
    failures.push(
      `the fault did not come back off: ${measured.restored.join(", ")}`,
    );
  }
  return failures;
}
