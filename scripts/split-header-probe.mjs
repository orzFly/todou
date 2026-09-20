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
 * assertion below uses containment, adjacency, or the exported class token
 * contract. Same-run geometry is retained as a diagnostic, not proof that
 * desktop rules are unchanged.
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
      //
      // The row, two levels up, and not the meta's own parent: that one is
      // the baseline line (T-487), which is `display: contents` below `sm`
      // and reports an empty rect at every width this runner measures
      // narrow, so asking it would report a drawn page as never ready.
      const rect = meta.parentElement?.parentElement?.getBoundingClientRect();
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

  // Import the values the running app uses, inside its Vite/DOM context.
  // Looking only at the rendered classList would also include each caller's
  // legitimate desktop classes, which are outside these three constants.
  const exported = await import(
    "/src/components/shared/comment-header-meta.tsx"
  );
  const classConstants = Object.fromEntries(
    [
      "COMMENT_HEADER_ROW",
      "COMMENT_HEADER_ACTION",
      "COMMENT_HEADER_IDENTITY",
    ].map((name) => [name, exported[name]]),
  );
  // Mutate real class tokens and install the same changes on their DOM
  // targets below. Spacer deletion remains a separate structural fault.
  const tokenFaults = {
    "desktop-grid": ["COMMENT_HEADER_ROW", "max-sm:grid", "grid"],
    "desktop-identity-flex": ["COMMENT_HEADER_IDENTITY", "contents", "flex"],
    "action-unconditional": ["COMMENT_HEADER_ACTION", null, "w-full"],
  };
  const tokenFault = tokenFaults[fault];
  if (tokenFault) {
    const [name, removed, added] = tokenFault;
    if (typeof classConstants[name] === "string") {
      classConstants[name] = [
        ...classConstants[name]
          .split(/\s+/)
          .filter((token) => token && token !== removed),
        added,
      ].join(" ");
    }
  }
  const classContract = Object.entries(classConstants).map(([name, value]) => {
    const tokens =
      typeof value === "string"
        ? value.trim().split(/\s+/).filter(Boolean)
        : [];
    return {
      name,
      tokens,
      valid: tokens.length > 0,
      unconditional: tokens.filter(
        (token) => token !== "contents" && !token.startsWith("max-sm:"),
      ),
    };
  });
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
    // The meta's own parent is the baseline line the row centres as one
    // group (T-487); the row is its parent. Walked structurally rather than
    // matched on the line's class, for the reason the identity below is.
    const line = meta.parentElement;
    const row = line?.parentElement ?? null;
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

    // What the row lays out, read through the line: above the breakpoint the
    // line is a box holding the identity, the meta and the marks beside them,
    // and below it the line is `contents` and the grid places the same
    // elements itself. Flattening it keeps every criterion measuring the same
    // four roles it measured before the line existed.
    const children = [...row.children].flatMap((child) =>
      child === line ? [...child.children] : [child],
    );
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
    headers.push({ id, row, line, meta, identity, spacer, actions });
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

  if (fault === "strip" || options.strip === true) {
    // Useful same-run geometry only: unconditional regressions survive on
    // both sides, so equality here cannot establish criterion 5.
    const stripIn = (host) => {
      for (const element of host.querySelectorAll("*")) {
        for (const name of [...element.classList]) {
          if (name.startsWith("max-sm:")) element.classList.remove(name);
        }
        if (element.shadowRoot) stripIn(element.shadowRoot);
      }
    };
    stripIn(document);
  }

  for (const { row, meta, identity, spacer, actions } of headers) {
    if (tokenFault) {
      const [name, removed, added] = tokenFault;
      const targets =
        name === "COMMENT_HEADER_ROW"
          ? [row]
          : name === "COMMENT_HEADER_IDENTITY"
            ? [identity]
            : actions;
      for (const target of targets.filter(Boolean)) {
        if (removed) target.classList.remove(removed);
        target.classList.add(added);
      }
    }
    switch (fault) {
      case "drop-spacer":
        spacer?.remove();
        break;
      case "meta-unconditional":
        // The private `box` class string is not one of the exported
        // constants. Exercise its real DOM token on both measurement pages.
        meta.classList.add("w-full");
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
      default:
        break;
    }
  }

  const round = (value) =>
    value === null ? null : Math.round(value * 100) / 100;

  const rows = headers.map((header) => {
    const { id, row, line, meta, identity, spacer, actions } = header;
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
    // Still where the row lays it out, which since T-487 means the line as
    // well as the row itself — `drop-spacer` removes the element, and this
    // is what tells that apart from the spacer merely moving a level in.
    const hasSpacer =
      spacer?.isConnected === true &&
      (spacer.parentElement === row || spacer.parentElement === line);
    const spacerStyle = hasSpacer ? getComputedStyle(spacer) : null;

    return {
      id,
      metaTokens: [...meta.classList],
      hasIdentity: identity !== null,
      hasSpacer,
      // Empty flex spacers can be zero-height and still contribute a gap.
      // Check that the connected element generates an in-flow layout box.
      spacerShown:
        hasSpacer &&
        !["none", "contents"].includes(spacerStyle.display) &&
        !["absolute", "fixed"].includes(spacerStyle.position) &&
        spacer.getClientRects().length > 0,
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
      // Same-run diagnostic, relative to the row so one header's shift does
      // not report every header below it as moved too.
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
    classContract,
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
    if (options.fault === "split-copy-both-error") {
      document.querySelector("#split-header-clipboard-sink")?.remove();
    }
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
  // A failed Ctrl+C must not re-read the same nonempty payload from an earlier
  // probe and make both sides look identical. An unchanged clipboard is empty
  // after this reset and assessSplitCopy rejects it.
  try {
    await navigator.clipboard.writeText("");
  } catch (error) {
    return { error: `clipboard reset failed: ${String(error)}` };
  }

  const range = document.createRange();
  range.selectNodeContents(row);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return { selected: selection?.toString() ?? "" };
}

/**
 * Grade one measured page. Criterion 5 checks exported constants and meta DOM
 * tokens against the pre-existing base/caller classes.
 * The stripped baseline supplies geometry diagnostics only: an unconditional
 * token survives stripping, making equality insufficient evidence of safety.
 */
export function assessSplitHeaders(measured, width, baseline = null) {
  const failures = [];
  const diagnostics = [];
  const note = (criterion, row, detail) =>
    failures.push({ criterion, row, detail });

  if (measured.status !== "ok") {
    return {
      failures: [{ criterion: 0, row: "-", detail: measured.reason }],
      diagnostics,
    };
  }
  const narrow = width < 640;
  if (!narrow) {
    const contracts = measured.classContract ?? [];
    for (const name of [
      "COMMENT_HEADER_ROW",
      "COMMENT_HEADER_ACTION",
      "COMMENT_HEADER_IDENTITY",
    ]) {
      const contract = contracts.find((entry) => entry.name === name);
      if (!contract?.valid) {
        note(5, name, "missing or empty DOM-side class constant");
      } else if (contract.unconditional.length) {
        note(
          5,
          name,
          `unconditional token(s): ${contract.unconditional.join(" ")}`,
        );
      }
    }
  }

  if (measured.documentOverflows) {
    note(2, "document", "the page scrolls sideways");
  }

  for (const row of measured.rows) {
    if (!narrow) {
      // These surfaces explicitly render the empty desktop spacer. The
      // expectation comes from the surface, never from finding the node:
      // deletion must still be checked, including the cached detached node.
      const needsSpacer = [
        "unplaced-comment",
        "spec-annotation-bubble",
        "annotation-chip",
      ].includes(row.id.replace(/#\d+$/, ""));
      if (needsSpacer && (!row.hasSpacer || !row.spacerShown)) {
        note(
          5,
          row.id,
          "required desktop spacer is missing or has no in-flow box",
        );
      }
      // CommentHeaderMeta's private `box` predates T-445 with these five
      // tokens. All current callers add only ml-auto (or no className):
      // comment-item, both hover cards, and spec-view's unplaced comments.
      // Do not derive this allowlist from current product source: doing so
      // would silently bless an unconditional regression such as w-full.
      const metaBaseTokens = new Set([
        "flex",
        "flex-wrap",
        "items-baseline",
        "justify-end",
        "gap-x-2",
        "ml-auto",
      ]);
      if (!Array.isArray(row.metaTokens) || row.metaTokens.length === 0) {
        note(5, row.id, "missing or empty DOM meta box class tokens");
      } else {
        const unconditional = row.metaTokens.filter(
          (token) => !token.startsWith("max-sm:") && !metaBaseTokens.has(token),
        );
        if (unconditional.length) {
          note(
            5,
            row.id,
            `meta box unconditional token(s): ${unconditional.join(" ")}`,
          );
        }
      }
    }
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
      // Equality cannot pass criterion 5; differences still help diagnosis.
      const before = baseline?.rows?.find((entry) => entry.id === row.id);
      if (!before) {
        diagnostics.push({
          row: row.id,
          detail: "no stripped baseline for this header",
        });
        continue;
      }
      if (before.fingerprint.length !== row.fingerprint.length) {
        diagnostics.push({
          row: row.id,
          detail: `${row.fingerprint.length} elements, baseline has ${before.fingerprint.length}`,
        });
        continue;
      }
      for (const [index, now] of row.fingerprint.entries()) {
        const was = before.fingerprint[index];
        if (
          now.text !== was.text ||
          Math.abs(now.top - was.top) > EPSILON ||
          Math.abs(now.left - was.left) > EPSILON
        ) {
          diagnostics.push({
            row: row.id,
            detail: `${now.tag} ${JSON.stringify(now.text)} at (${now.top},${now.left}), baseline (${was.top},${was.left})`,
          });
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

  return { failures, diagnostics };
}

/** Criterion 6: successful nonempty probes before byte-for-byte comparison. */
export function assessSplitCopy(after, before) {
  const failures = [];
  const validString = (value) =>
    typeof value === "string" && value.trim().length > 0;
  for (const [side, run] of [
    ["current", after],
    ["stripped", before],
  ]) {
    if (
      run?.status !== "ok" ||
      run.error ||
      !Array.isArray(run.fixtureErrors) ||
      run.fixtureErrors.length ||
      run.pasted?.error ||
      !validString(run.selected) ||
      !validString(run.pasted?.value)
    ) {
      failures.push({
        criterion: 6,
        row: side,
        detail: `${side} copy probe failed or returned invalid/empty text: ${run?.error ?? run?.pasted?.error ?? JSON.stringify(run)}`,
      });
    }
  }
  const payload = after?.pasted?.value ?? null;
  const was = before?.pasted?.value ?? null;
  // No trimming for equality: trailing newlines remain part of the payload.
  if (failures.length === 0 && payload !== was) {
    failures.push({
      criterion: 6,
      row: "copy",
      detail: `clipboard bytes changed: ${JSON.stringify(payload)} vs ${JSON.stringify(was)}`,
    });
  }
  return { failures, payload, was };
}
