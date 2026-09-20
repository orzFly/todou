/**
 * Search jump-row width probes (T-446), serialized into a real Chromium page
 * by scripts/lib/browser-cdp.mjs's evaluate(). No imports, no closure
 * dependencies. The caller owns the authenticated page, the 390px viewport,
 * and getting the row on screen — the banner by navigating to /search?q=…,
 * the panel by typing into the box and waiting for the offer.
 *
 * Two surfaces, two different questions, and they are not interchangeable:
 *
 * - The banner sits in the page's ordinary flow with nothing containing it, so
 *   a ref it cannot fit pushes the document sideways. `document-scroll-overflow`.
 * - The offer panel is `overflow-y-auto`, which makes its computed `overflow-x`
 *   `auto` as well, so it is its own horizontal scroller and the page never
 *   moves at all. Grading that surface by `document.scrollWidth` yields an
 *   assertion that is green while the row is 972px out of reach — measured, not
 *   supposed. `panel-scroll-overflow` is the one that can see it.
 *
 * Both failures are always reported where they apply; the runner decides which
 * one a case requires and which one it requires to stay green, so the pair
 * above is itself checked rather than described.
 *
 * `probeShortRowParity` is the other direction: a ref with room to spare has to
 * render exactly as it did before any of this, judged against a replica built
 * from the pre-fix markup in the same box and the same fonts rather than
 * against numbers this code could compute for itself.
 */

export async function probeRefRowWidth(options = {}, fault = {}) {
  // Each probe is serialized on its own and runs with nothing else in scope,
  // so the pre-fix classes are spelled out in both. Changing either copy
  // changes what this file means by "unchanged".
  const WAS = { ref: "shrink-0 font-mono text-xs text-muted-foreground" };
  const { surface = null, spelled = null, minimumRows = 1 } = options;
  if (surface !== "banner" && surface !== "panel") {
    throw new Error('surface must be "banner" or "panel"');
  }
  if (fault && Object.keys(fault).some((key) => key !== "rigidToken")) {
    throw new Error("unknown search-wrap width fault");
  }
  await document.fonts.ready;
  const failures = [];
  const coverageErrors = [];
  const round = (value) =>
    Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  const rectOf = (element) => {
    const r = element.getBoundingClientRect();
    return {
      left: round(r.left),
      right: round(r.right),
      top: round(r.top),
      width: round(r.width),
      height: round(r.height),
    };
  };

  const panel = document.querySelector('[role="listbox"]');
  const inPanel = (element) => panel !== null && panel.contains(element);
  const blocks = [...document.querySelectorAll("[data-jump-row]")].filter(
    (block) => inPanel(block) === (surface === "panel"),
  );
  if (surface === "panel" && panel === null) {
    return { ok: false, failures, coverageErrors: ["offer-panel-not-open"] };
  }
  if (blocks.length < minimumRows) {
    return {
      ok: false,
      failures,
      coverageErrors: ["too-few-ref-rows"],
      rows: blocks.length,
      wanted: minimumRows,
    };
  }
  const tokenOf = (block) => block.querySelector("[data-jump-part][title]");
  if (blocks.some((block) => tokenOf(block) === null)) {
    return { ok: false, failures, coverageErrors: ["ref-token-missing"] };
  }
  // The title and the author are drawn in the app's own face; a run measured
  // before it arrives would allocate against fallback metrics.
  const titleStyle = getComputedStyle(blocks[0]);
  if (
    !titleStyle.fontFamily.includes("Geist") ||
    !document.fonts.check(`${titleStyle.fontSize} "Geist Variable"`)
  ) {
    coverageErrors.push("row-font-not-loaded");
  }

  const restore = [];
  try {
    if (fault?.rigidToken) {
      for (const block of blocks) {
        const token = tokenOf(block);
        restore.push({ element: token, className: token.className });
        // Both halves at once, which is the only way this fault reproduces the
        // report: putting `shrink-0` back while the allocator still hands out
        // widths leaves the elision doing its job and the row still fits.
        token.className = WAS.ref;
        for (const clipped of block.querySelectorAll("[style]")) {
          restore.push({ element: clipped, width: clipped.style.width });
          clipped.style.removeProperty("width");
        }
      }
      if (blocks.some((block) => tokenOf(block).className !== WAS.ref)) {
        coverageErrors.push("fault-not-applied");
      }
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    // Integer CSSOM dimensions on both: one extra pixel is one pixel the
    // reader has to travel to.
    const documentWidth = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
    // Which elements actually cross the right edge, outermost only. A
    // page-level number says the page is wide; this says who made it wide, and
    // without it a surface is graded for whatever else happens to share its
    // page — which is how T-500's account chip nearly ended up in this card.
    const offenders = [];
    if (documentWidth.scrollWidth > documentWidth.clientWidth) {
      failures.push("document-scroll-overflow");
      for (const element of document.querySelectorAll("body *")) {
        const r = element.getBoundingClientRect();
        if (r.width === 0 || r.right <= documentWidth.clientWidth + 0.5)
          continue;
        if (offenders.some((entry) => entry.element.contains(element)))
          continue;
        offenders.push({
          element,
          tag: element.tagName.toLowerCase(),
          className: element.className?.baseVal ?? element.className ?? "",
          right: round(r.right),
          width: round(r.width),
          text: (element.textContent ?? "").trim().slice(0, 60),
          inRefRow: blocks.some(
            (block) => block.contains(element) || element.contains(block),
          ),
        });
      }
    }
    const panelWidth =
      panel === null
        ? null
        : {
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
            overflowX: getComputedStyle(panel).overflowX,
          };
    if (surface === "panel") {
      if (panelWidth.scrollWidth > panelWidth.clientWidth) {
        failures.push("panel-scroll-overflow");
      }
      // The reason the page-level number is useless here. A panel that had
      // stopped containing its own overflow would move the failure to the
      // document and quietly make the pair above agree again.
      if (panelWidth.overflowX === "visible") {
        coverageErrors.push("panel-no-longer-its-own-scroller");
      }
    }

    const rows = blocks.map((block) => {
      const token = tokenOf(block);
      const parts = [...block.children].filter((child) =>
        child.hasAttribute("data-jump-part"),
      );
      return {
        spelled: token.getAttribute("title"),
        text: token.textContent,
        elided: block.querySelectorAll("[style]").length,
        wrapped: round(block.getBoundingClientRect().height),
        block: {
          scrollWidth: block.scrollWidth,
          clientWidth: block.clientWidth,
        },
        row: rectOf(block.parentElement),
        parts: parts.map((part) => ({
          width: rectOf(part).width,
          text: part.textContent,
        })),
      };
    });
    if (spelled !== null) {
      const named = rows.find((row) => row.spelled === spelled);
      if (named === undefined) coverageErrors.push("named-ref-row-missing");
      // Elision is a matter of painting. A token whose DOM lost characters
      // has been truncated instead, and hovering it would confirm a lie.
      else if (named.text !== spelled) failures.push("ref-text-truncated");
    }
    if (rows.some((row) => row.spelled === null || row.spelled === "")) {
      failures.push("ref-title-missing");
    }
    // What the row itself is answerable for, on either surface and regardless
    // of what else shares its page. The two numbers above say whether the
    // surface travels; this one says whether the row made it travel.
    if (rows.some((row) => row.block.scrollWidth > row.block.clientWidth)) {
      failures.push("ref-row-overflow");
    }

    return {
      ok: failures.length === 0 && coverageErrors.length === 0,
      failures,
      coverageErrors,
      surface,
      fault: Boolean(fault?.rigidToken),
      viewportWidth: document.documentElement.clientWidth,
      documentWidth,
      panelWidth,
      // eslint-disable-next-line no-unused-vars -- the node stays out of the report
      overflowing: offenders.map(({ element, ...entry }) => entry),
      rows,
    };
  } finally {
    for (const entry of restore.reverse()) {
      if (entry.className !== undefined)
        entry.element.className = entry.className;
      else entry.element.style.width = entry.width;
    }
  }
}

/**
 * A ref with room to spare, against a replica of the markup it had before
 * T-446: same box, same fonts, same status pill, the pre-fix classes written
 * out below. Every child is compared by width and by where it sits inside the
 * row, because the symptom of getting this wrong is a few pixels of vertical
 * drift rather than anything that overflows.
 *
 * The replica is the expectation, and nothing in it is computed by the code
 * under test. `itemsStart` is its red: the row's own `items-center` is what
 * keeps a single-line row where it was, and taking it away moves the text
 * against a status pill that stays put.
 */
export async function probeShortRowParity(options = {}, fault = {}) {
  // Its own copy; see the note in probeRefRowWidth.
  const WAS = {
    ref: "shrink-0 font-mono text-xs text-muted-foreground",
    author: "shrink-0 text-muted-foreground",
    pill: "ml-auto",
  };
  const { spelled = null, titleClassName = "truncate" } = options;
  if (typeof spelled !== "string" || spelled === "") {
    throw new Error("spelled must name the row to compare");
  }
  if (fault && Object.keys(fault).some((key) => key !== "itemsStart")) {
    throw new Error("unknown short-row parity fault");
  }
  await document.fonts.ready;
  const failures = [];
  const coverageErrors = [];
  const epsilon = 0.5; // Subpixel rounding tolerance, not a layout target.
  const round = (value) =>
    Number.isFinite(value) ? Number(value.toFixed(2)) : null;

  const block = [...document.querySelectorAll("[data-jump-row]")].find(
    (candidate) =>
      candidate
        .querySelector("[data-jump-part][title]")
        ?.getAttribute("title") === spelled,
  );
  if (block === undefined) {
    return { ok: false, failures, coverageErrors: ["named-ref-row-missing"] };
  }
  // A ref the allocator had to clip is not the case this grades: the whole
  // claim is about the rows that never came under pressure.
  if (block.querySelectorAll("[style]").length > 0) {
    return { ok: false, failures, coverageErrors: ["short-ref-was-elided"] };
  }
  const row = block.parentElement;
  const pristine = row.className;
  const parts = [...block.children].filter((child) =>
    child.hasAttribute("data-jump-part"),
  );
  if (parts.length < 2 || parts.length > 3) {
    return {
      ok: false,
      failures,
      coverageErrors: ["unexpected-row-structure"],
      parts: parts.length,
    };
  }
  const siblings = [...row.children];
  const icon = siblings[0] === block ? null : siblings[0];
  const pill = siblings.at(-1) === block ? null : siblings.at(-1);
  if (icon === null) {
    return {
      ok: false,
      failures,
      coverageErrors: ["unexpected-row-structure"],
    };
  }

  const replica = document.createElement(row.tagName);
  replica.className = pristine;
  const href = row.getAttribute("href");
  if (href !== null) replica.setAttribute("href", href);
  replica.append(icon.cloneNode(true));
  const written = [
    [parts[0].textContent, WAS.ref],
    [parts[1].textContent, titleClassName],
    ...(parts.length === 3 ? [[parts[2].textContent, WAS.author]] : []),
  ];
  for (const [text, className] of written) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    replica.append(span);
  }
  if (pill !== null) {
    const copy = pill.cloneNode(true);
    copy.className = `${pill.className} ${WAS.pill}`;
    replica.append(copy);
  }

  try {
    if (fault?.itemsStart) {
      row.className = pristine.replace("items-center", "items-start");
      if (getComputedStyle(row).alignItems !== "flex-start") {
        coverageErrors.push("fault-not-confirmed");
      }
    }
    row.insertAdjacentElement("afterend", replica);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    const rowRect = row.getBoundingClientRect();
    const replicaRect = replica.getBoundingClientRect();
    const madeOf = (element, origin) => {
      const r = element.getBoundingClientRect();
      return {
        width: round(r.width),
        x: round(r.left - origin.left),
        y: round(r.top - origin.top),
        text: element.textContent,
      };
    };
    const mine = [icon, ...parts, ...(pill === null ? [] : [pill])].map(
      (element) => madeOf(element, rowRect),
    );
    const theirs = [...replica.children].map((element) =>
      madeOf(element, replicaRect),
    );
    if (mine.length !== theirs.length) {
      coverageErrors.push("replica-shape-mismatch");
    } else {
      for (const [index, want] of theirs.entries()) {
        const got = mine[index];
        if (got.text !== want.text) failures.push("short-ref-text-changed");
        if (Math.abs(got.width - want.width) > epsilon)
          failures.push("short-ref-width-changed");
        if (
          Math.abs(got.x - want.x) > epsilon ||
          Math.abs(got.y - want.y) > epsilon
        ) {
          failures.push("short-ref-offset-changed");
        }
      }
    }
    if (Math.abs(rowRect.height - replicaRect.height) > epsilon) {
      failures.push("short-ref-height-changed");
    }
    if (Math.abs(rowRect.width - replicaRect.width) > epsilon) {
      coverageErrors.push("replica-box-differs");
    }

    return {
      ok: failures.length === 0 && coverageErrors.length === 0,
      failures,
      coverageErrors,
      spelled,
      fault: Boolean(fault?.itemsStart),
      viewportWidth: document.documentElement.clientWidth,
      geometry: {
        row: { width: round(rowRect.width), height: round(rowRect.height) },
        replica: {
          width: round(replicaRect.width),
          height: round(replicaRect.height),
        },
        mine,
        theirs,
      },
    };
  } finally {
    replica.remove();
    row.className = pristine;
  }
}
