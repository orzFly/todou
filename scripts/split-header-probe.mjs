/*
 * Browser probes for T-445: what a comment header measures once it splits
 * into two lines below `sm`.
 *
 * Like user-baseline-faults.mjs, this module has no process, fixture, React
 * or runner imports — `probeSplitHeader` is serialized with `fn.toString()`
 * and executed inside a Chromium page by the runner's `evaluate`, so it can
 * only reach the DOM. The runner (scripts/user-baseline-smoke.mjs) owns the
 * isolated stack, the seeding, the viewports and the reporting.
 *
 * The one measurement deliberately absent is height. Header heights near a
 * wrap threshold move with the *rendered timestamp*: the same fixture gave
 * 77.8px and 53.8px at 360px eighteen minutes apart, because
 * `9/19/2026, 5:39:xx PM` is a few pixels wider than `…5:57:xx PM`. Every
 * assertion below is a containment, an adjacency, or an equality against a
 * baseline taken in the same browser run, and none of them moves with a
 * clock.
 */

/** Anything closer than this reads as the same line, or the same edge. */
const EPSILON = 0.5;

/** The row's column gap, which is as far right of an action as is allowed. */
const COLUMN_GAP = 8;

/** Criterion 7's floor: below this the identity items have visibly merged. */
const MIN_IDENTITY_GAP = 4;

/**
 * Run inside Chromium. How many headers this page is drawing, and nothing
 * else — the production spec routes have no ready signal to wait on, and
 * polling `probeSplitHeader` instead would measure the whole page every
 * 250ms while the answer is still "not yet".
 */
export function probeSplitHeaderCount() {
  const count = (host) => {
    let found = 0;
    for (const meta of host.querySelectorAll(
      '[data-testid="comment-header-meta"]',
    )) {
      // The same condition the measurement applies, not merely "the element
      // exists": the source view mounts its annotations into a shadow root
      // before they have a box, and a readiness check looser than the
      // measurement lets the measurement run against nothing.
      const rect = meta.parentElement?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) found += 1;
    }
    for (const element of host.querySelectorAll("*")) {
      if (element.shadowRoot) found += count(element.shadowRoot);
    }
    return found;
  };
  return count(document);
}

/**
 * Run inside Chromium. Finds every comment header drawn on the current page,
 * optionally damages one rule, and reports the geometry the criteria are
 * written against.
 *
 * `stress` is stubbed content, not seeded content, and every report says so:
 * five-digit ids need thousands of comments to arrive honestly, and what the
 * criteria need from them is the width, which the stub reproduces exactly.
 */
export async function probeSplitHeader(options = {}) {
  const fault = options.fault ?? null;
  const stress = options.stress === true;

  await document.fonts.ready;
  if (!document.fonts.check('12px "Geist Variable"')) {
    return { status: "error", reason: "Geist Variable did not load" };
  }

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

  const contentBox = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      left:
        rect.left +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.paddingLeft),
      right:
        rect.right -
        parseFloat(style.borderRightWidth) -
        parseFloat(style.paddingRight),
    };
  };

  // pierre renders the source and diff views into shadow roots, so a flat
  // query would find the timeline's headers and none of the spec ones.
  const metasIn = (host) => {
    const found = [
      ...host.querySelectorAll('[data-testid="comment-header-meta"]'),
    ];
    for (const element of host.querySelectorAll("*")) {
      if (element.shadowRoot) found.push(...metasIn(element.shadowRoot));
    }
    return found;
  };

  const seen = new Map();
  const headers = [];
  for (const meta of metasIn(document)) {
    const row = meta.parentElement;
    if (!row || !visible(row)) continue;
    // Named by the surface that drew it, so a failure says which entry point
    // moved rather than "header 3". The fixture's sections name their own;
    // the previews and the annotation bubble are portalled to `document.body`
    // by Radix and have to be named by what they landed in. Both previews
    // answer to one name — they are the same shape, and which of the two
    // failed is one line away in the report.
    const section = row.closest("section[id^='fixture-']");
    const base =
      section?.id.replace(/^fixture-/, "") ??
      (row.closest("[data-slot='hover-card-content']")
        ? "hover-card"
        : row.closest(".border-y.bg-background.px-3.py-2")
          ? "diff-annotation"
          : row.closest(".space-y-2.rounded-lg.border.px-4.py-3")
            ? "unplaced-comment"
            : row.closest(".rounded-md.border.p-2")
              ? "spec-annotation-bubble"
              : null);
    if (base === null) continue;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const id = nth === 1 ? base : `${base}#${nth}`;

    const children = [...row.children];
    // Structural, never by the classes under test: an identity group found
    // by `max-sm:col-start-1` would go missing exactly when the class did,
    // and the criterion would pass by measuring nothing.
    const identity =
      children.find(
        (child) =>
          child !== meta &&
          (child.matches("a[href^='/users/']") ||
            child.querySelector("a[href^='/users/']") !== null),
      ) ?? null;
    const spacer =
      children.find(
        (child) =>
          child !== meta &&
          child !== identity &&
          child.tagName === "SPAN" &&
          child.childElementCount === 0 &&
          (child.textContent ?? "") === "",
      ) ?? null;
    const actions = children.filter(
      (child) => child !== meta && child !== identity && child !== spacer,
    );
    headers.push({ id, row, meta, identity, spacer, actions });
  }

  if (headers.length === 0) {
    return { status: "error", reason: "no comment header on this page" };
  }

  if (stress) {
    for (const { meta } of headers) {
      const token = meta.querySelector(".select-all");
      if (token) token.textContent = "#comment-99999";
    }
  }

  if (fault === "strip") {
    // The header exactly as it stood before this card: every rule the change
    // introduced is `max-sm:`-prefixed, so removing that prefix's classes
    // restores the old shape without touching anything else. Above the
    // breakpoint it changes nothing, which is what makes it usable as
    // criterion 5's baseline rather than only as a fault.
    for (const element of document.querySelectorAll("[class]")) {
      for (const name of [...element.classList]) {
        if (name.startsWith("max-sm:")) element.classList.remove(name);
      }
    }
  }

  for (const { row, meta, identity, spacer, actions } of headers) {
    switch (fault) {
      case "drop-spacer":
        // What "cleaning up dead code" costs. The span is empty and inert,
        // so nothing on the page reads differently for it — except that the
        // row loses one `gap-2` with it, and everything to its right moves.
        // Measured against a baseline that still has it, at a desktop width
        // where the header is the row it has always been.
        spacer?.remove();
        break;
      case "meta-auto":
        // The design "simplified" back to the minimal fix this card rejected:
        // the row a wrapping flex again, and the right-hand edge the meta's
        // `ml-auto` rather than a column of its own. Every other `ml-auto` in
        // these rows lives on the meta, so that is where a later reader will
        // put this one — and the row is then free to wrap the controls onto a
        // line the meta is not on, which is where they go left.
        //
        // Taking only the placement off the controls proves nothing: grid
        // auto-flow drops them into the very cell the explicit placement
        // named, so the shape survives its own rule being deleted.
        row.style.display = "flex";
        row.style.flexWrap = "wrap";
        for (const action of actions) {
          action.style.gridColumnStart = "auto";
          action.style.gridRowStart = "auto";
          action.style.justifySelf = "auto";
        }
        meta.style.marginLeft = "auto";
        break;
      case "nowrap":
        meta.style.flexWrap = "nowrap";
        break;
      case "no-indent":
        meta.style.paddingInlineStart = "0px";
        break;
      case "no-time-auto":
        if (meta.lastElementChild) {
          meta.lastElementChild.style.marginLeft = "0px";
        }
        break;
      case "justify-end":
        meta.style.justifyContent = "flex-end";
        break;
      case "identity-block":
        if (identity) identity.style.display = "block";
        break;
      case "desktop-grid":
        row.style.display = "grid";
        row.style.gridTemplateColumns = "minmax(0,1fr) auto";
        break;
      case "desktop-identity-flex":
        if (identity) identity.style.display = "flex";
        break;
      default:
        break;
    }
  }

  const round = (value) =>
    value === null ? null : Math.round(value * 100) / 100;

  const rows = headers.map(({ id, row, meta, identity, spacer, actions }) => {
    const box = contentBox(row);
    const rowRect = row.getBoundingClientRect();
    const shown = [...row.querySelectorAll("*")].filter(visible);
    const overflowRight =
      shown.length === 0
        ? 0
        : Math.max(...shown.map((el) => el.getBoundingClientRect().right)) -
          box.right;

    const liveActions = actions.filter(visible);
    const actionInset =
      liveActions.length === 0
        ? null
        : box.right -
          Math.max(
            ...liveActions.map((el) => el.getBoundingClientRect().right),
          );

    const metaBox = contentBox(meta);
    const nameSpan =
      identity?.querySelector("a[href^='/users/'] span[class~='ml-1.5']") ??
      null;
    const links = [...meta.querySelectorAll("a")];
    const idLink = links.find((link) => link.querySelector("time") === null);
    const time = meta.querySelector("time");
    const idRect = idLink?.getBoundingClientRect() ?? null;
    const timeRect = time?.getBoundingClientRect() ?? null;

    const kids = identity ? [...identity.children].filter(visible) : [];
    const identityGaps = [];
    for (let i = 1; i < kids.length; i++) {
      const before = kids[i - 1].getBoundingClientRect();
      const after = kids[i].getBoundingClientRect();
      // Overlapping vertical ranges, not equal tops: a chip and an agent
      // badge share a line by their baselines and have boxes of different
      // heights, so equal tops is a condition neither of them ever meets —
      // and a gap measurement that never runs reads exactly like one that
      // always passes.
      if (before.bottom > after.top && after.bottom > before.top) {
        identityGaps.push(round(after.left - before.right));
      }
    }

    return {
      id,
      hasIdentity: identity !== null,
      hasSpacer: spacer !== null,
      spacerShown: spacer !== null && visible(spacer),
      actions: liveActions.length,
      actionInset: round(actionInset),
      overflowRight: round(overflowRight),
      rowScrolls: row.scrollWidth > row.clientWidth + 1,
      metaLeft: round(metaBox.left),
      metaRight: round(metaBox.right),
      nameLeft: nameSpan ? round(nameSpan.getBoundingClientRect().left) : null,
      idLeft: idRect ? round(idRect.left) : null,
      idText: idLink?.textContent ?? null,
      timeRight: timeRect ? round(timeRect.right) : null,
      // Which of criterion 4's two halves this sample is evidence for.
      idAndTimeSameLine:
        idRect && timeRect
          ? idRect.bottom > timeRect.top && timeRect.bottom > idRect.top
          : null,
      identityGaps,
      // Criterion 5's fingerprint, taken relative to the row so a shift in
      // one header cannot report every header below it as moved too.
      fingerprint: shown.map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? "").slice(0, 40),
        top: round(element.getBoundingClientRect().top - rowRect.top),
        left: round(element.getBoundingClientRect().left - rowRect.left),
      })),
    };
  });

  return {
    status: "ok",
    fault,
    stress,
    rows,
    documentOverflows:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  };
}

/**
 * Run inside Chromium. Selects a whole header with a `Range` and leaves the
 * selection in place for the runner's real Ctrl+C; `mode: "read"` reads back
 * what the paste produced.
 */
export async function probeHeaderCopy(options = {}) {
  const mode = options.mode ?? "select";
  if (mode === "read") {
    const sink = document.querySelector("#split-header-clipboard-sink");
    if (!sink) return { error: "clipboard sink vanished" };
    sink.focus();
    try {
      const text = await navigator.clipboard.readText();
      sink.value = text;
      return { value: sink.value };
    } catch (error) {
      return { error: String(error) };
    }
  }

  await document.fonts.ready;
  if (options.strip === true) {
    for (const element of document.querySelectorAll("[class]")) {
      for (const name of [...element.classList]) {
        if (name.startsWith("max-sm:")) element.classList.remove(name);
      }
    }
  }
  const meta = document.querySelector(
    "#fixture-comment-item [data-testid='comment-header-meta']",
  );
  const row = meta?.parentElement ?? null;
  if (!row) return { error: "no comment header to select" };
  row.scrollIntoView({ block: "center" });

  // Measurement apparatus, not product markup: the paste has to land
  // somewhere a read can see it.
  let sink = document.querySelector("#split-header-clipboard-sink");
  if (!sink) {
    sink = document.createElement("textarea");
    sink.id = "split-header-clipboard-sink";
    sink.style.cssText =
      "position:fixed;left:0;bottom:0;width:240px;height:40px;z-index:9999";
    document.body.append(sink);
  }
  sink.value = "";

  const range = document.createRange();
  range.selectNodeContents(row);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return { selected: selection?.toString() ?? "" };
}

/**
 * Grade one measured page. `baseline` is the same page with every `max-sm:`
 * class removed, measured in the same browser run — font loading and clock
 * drift are then common to both sides instead of being compared across them.
 */
export function assessSplitHeaders(measured, width, baseline = null) {
  const failures = [];
  const note = (criterion, row, detail) =>
    failures.push({ criterion, row, detail });

  if (measured.status !== "ok") {
    return { failures: [{ criterion: 0, row: "-", detail: measured.reason }] };
  }
  const narrow = width < 640;

  if (measured.documentOverflows) {
    note(2, "document", "the page scrolls sideways");
  }

  for (const row of measured.rows) {
    if (!row.hasIdentity) {
      note(0, row.id, "no identity group in this header");
      continue;
    }

    // 2. Zero overflow, at every width and under the five-digit stress id.
    if (row.overflowRight > EPSILON) {
      note(2, row.id, `overflows its header by ${row.overflowRight}px`);
    }
    if (row.rowScrolls) note(2, row.id, "the header scrolls");

    if (!narrow) {
      // 5. Above the breakpoint nothing may have moved at all.
      const before = baseline?.rows?.find((entry) => entry.id === row.id);
      if (!before) {
        note(5, row.id, "no stripped baseline for this header");
        continue;
      }
      if (before.fingerprint.length !== row.fingerprint.length) {
        note(
          5,
          row.id,
          `${row.fingerprint.length} elements, baseline has ${before.fingerprint.length}`,
        );
        continue;
      }
      for (const [index, now] of row.fingerprint.entries()) {
        const was = before.fingerprint[index];
        if (
          now.text !== was.text ||
          Math.abs(now.top - was.top) > EPSILON ||
          Math.abs(now.left - was.left) > EPSILON
        ) {
          note(
            5,
            row.id,
            `${now.tag} ${JSON.stringify(now.text)} at (${now.top},${now.left}), baseline (${was.top},${was.left})`,
          );
        }
      }
      continue;
    }

    // 1. The controls end the first line, against the right edge.
    if (row.actions > 0 && row.actionInset > COLUMN_GAP + EPSILON) {
      note(1, row.id, `controls sit ${row.actionInset}px from the right edge`);
    }

    // 3. The second line starts under the name, not under the avatar.
    if (row.nameLeft === null) {
      note(3, row.id, "no name to align the second line to");
    } else if (Math.abs(row.metaLeft - row.nameLeft) > EPSILON) {
      note(
        3,
        row.id,
        `second line starts at ${row.metaLeft}, the name at ${row.nameLeft}`,
      );
    }

    // 4. The id holds that edge and the time holds the other one, whether
    //    the pair shares a line or has been split onto two.
    if (row.idLeft !== null && Math.abs(row.idLeft - row.metaLeft) > EPSILON) {
      note(
        4,
        row.id,
        `id at ${row.idLeft}, the line it starts at ${row.metaLeft}` +
          (row.idAndTimeSameLine ? "" : " (wrapped)"),
      );
    }
    if (
      row.timeRight !== null &&
      Math.abs(row.timeRight - row.metaRight) > EPSILON
    ) {
      note(
        4,
        row.id,
        `time ends at ${row.timeRight}, the line at ${row.metaRight}` +
          (row.idAndTimeSameLine ? "" : " (wrapped)"),
      );
    }

    // 7. The group still spaces what it now owns.
    for (const gap of row.identityGaps) {
      if (gap < MIN_IDENTITY_GAP) {
        note(7, row.id, `identity items ${gap}px apart`);
      }
    }
  }

  return { failures };
}
