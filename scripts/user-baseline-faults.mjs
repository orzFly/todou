/*
 * Historical browser fault probes for the T-433 user-baseline smoke runner.
 *
 * This module deliberately has no process, fixture, React, or runner imports.
 * The two browser functions are self-contained so the runner's existing
 * `evaluate(page, fn, ...args)` serializer can execute `fn.toString()` in a
 * Chromium page. They mutate the current document and intentionally do not
 * undo the mutation: restoration is valid only when the runner closes that
 * target, opens a fresh page, and runs the same function in `clean` mode.
 *
 * Exact runner sequence:
 * Import the named functions below from "./user-baseline-faults.mjs" in the
 * main runner. Build the existing fixture URL with the seeded slug/number.
 * For EACH call below: create the page with pageFor(browser, viewport,
 * seeded.cookie, url), armAvatarNetwork(page) before navigation, load(page,
 * url), release the avatar network and wait for settlement. Close EVERY page
 * in finally via Target.closeTarget. The clean calls use newly created pages.
 *
 *   const nameFinderSource = findUserChipName.toString();
 *   const fault = await evaluate(page390, probeT359AvatarFault, { mode: "fault", nameFinderSource });
 *   await page390.cdp.send("Target.closeTarget", { targetId: page390.targetId });
 *   const restored = await evaluate(freshPage390, probeT359AvatarFault, { mode: "clean", nameFinderSource });
 *   const verdict = assessT359FreshPageRestore(fault, restored);
 *
 *   const fault = await evaluate(pageDesktop, probeT416BadgeClippingFault, { mode: "fault" });
 *   await pageDesktop.cdp.send("Target.closeTarget", { targetId: pageDesktop.targetId });
 *   const restored = await evaluate(freshPageDesktop, probeT416BadgeClippingFault, { mode: "clean" });
 *   const verdict = assessT416FreshPageRestore(fault, restored);
 *
 * Wait for the fixture ready signal and document.fonts.ready first. For T-359,
 * release the delayed avatar request and wait for image settlement before the
 * call. Treat any browser result other than `ok`, or either assessment other
 * than `pass`, as fatal. A clean call on the mutated page is not a restore.
 */

export const USER_BASELINE_FAULT_INTEGRATION = Object.freeze({
  t359: Object.freeze({
    viewport: Object.freeze({ width: 390, height: 844, deviceScaleFactor: 1 }),
    fixture: "/test/browser/user-baseline.html",
    browserFunction: "probeT359AvatarFault",
    assessment: "assessT359FreshPageRestore",
    nameFinderSource:
      "required: findUserChipName.toString() from user-chip-name-probe.mjs",
    preparation: Object.freeze([
      "wait for window.__USER_BASELINE_READY__ and document.fonts.ready",
      "release the delayed avatar request and wait for avatar images to settle",
      "use the real data-avatar-case matrix rendered by AvatarBaselineSamples",
    ]),
    restore:
      "close the mutated target and evaluate clean mode in a newly loaded target",
    seed: "no additional API seed; the browser fixture supplies the neutral human/machine avatar matrix",
  }),
  t416: Object.freeze({
    viewport: Object.freeze({ width: 1280, height: 800, deviceScaleFactor: 1 }),
    fixture: "/test/browser/user-baseline.html",
    browserFunction: "probeT416BadgeClippingFault",
    assessment: "assessT416FreshPageRestore",
    preparation: Object.freeze([
      "wait for window.__USER_BASELINE_READY__ and document.fonts.ready",
      "render one real EventRow whose summary contains a machine UserChip",
      "render one closed real CollapsedGroup whose summary contains a machine UserChip",
      "keep each target badge horizontally visible inside the truncating summary span",
    ]),
    restore:
      "close the mutated target and evaluate clean mode in a newly loaded target",
    seed: "seed a short neutral machine member and assignment events; render a bot assignment EventRow and the assignee EventGroup from those fetched events (do not recreate either component in probe JSX)",
  }),
  limitations: Object.freeze([
    "T-359 measures the settled avatar states; request-transition stability remains the main runner's responsibility.",
    "T-416 measures CSS overflow rectangles, not painted-pixel antialiasing.",
    "A machine chip used only as the row actor is outside the clipped summary and is intentionally not a T-416 sample.",
    "Responsive T-416 padding is effective only at the desktop breakpoint, so a mobile invocation is invalid rather than a passing sample.",
  ]),
});

/**
 * Run inside Chromium at 390 CSS px. `fault` applies the exact pre-T-359
 * chip/avatar declarations to every real fixture matrix row. `clean` is the
 * read-only half of the fresh-page restoration contract.
 */
export async function probeT359AvatarFault(options = {}) {
  const mode = options.mode ?? "fault";
  const epsilon = options.epsilon ?? 0.125;
  const expectedWidth = options.expectedWidth ?? 390;
  if (typeof options.nameFinderSource !== "string") {
    return {
      id: "T-359",
      mode,
      status: "invalid",
      reason: "nameFinderSource is required",
      samples: [],
    };
  }
  const findName = new Function(`return (${options.nameFinderSource});`)();
  const expectedCases = [
    "human-none",
    "human-success",
    "human-failure",
    "human-delayed",
    "machine-none",
    "machine-success",
    "machine-failure",
    "machine-delayed",
  ];

  const round = (value) =>
    Number.isFinite(value) ? Number(value.toFixed(5)) : null;
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return {
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      top: round(box.top),
      right: round(box.right),
      bottom: round(box.bottom),
      left: round(box.left),
    };
  };
  const sameRect = (left, right) =>
    ["x", "y", "width", "height"].every(
      (key) => Math.abs(left[key] - right[key]) <= epsilon,
    );
  const documentKey = "__todouUserBaselineFaultDocumentId__";
  if (!globalThis[documentKey]) {
    const words = new Uint32Array(4);
    crypto.getRandomValues(words);
    Object.defineProperty(globalThis, documentKey, {
      value: [...words]
        .map((word) => word.toString(16).padStart(8, "0"))
        .join("-"),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  await document.fonts.ready;
  await Promise.all(
    [...document.querySelectorAll("[data-avatar-case] img")].map((image) =>
      image.decode().catch(() => undefined),
    ),
  );

  const baseline = (element, geometry) => {
    const before = geometry.map(rect);
    const marker = document.createElement("span");
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText =
      "display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline";
    element.insertBefore(marker, element.firstChild);
    const cssPx = marker.getBoundingClientRect().top;
    const after = geometry.map(rect);
    marker.remove();
    return {
      cssPx: round(cssPx),
      marker: "zero-size-inline-block",
      geometryStable: before.every((box, index) => sameRect(box, after[index])),
      geometryBefore: before,
      geometryWithMarker: after,
    };
  };

  const styles = (chip, name, avatar, machineWrapper, avatarOuter, clip) => {
    const chipStyle = getComputedStyle(chip);
    const nameStyle = getComputedStyle(name);
    const avatarStyle = getComputedStyle(avatar);
    const wrapperStyle = machineWrapper
      ? getComputedStyle(machineWrapper)
      : null;
    return {
      chip: {
        display: chipStyle.display,
        alignItems: chipStyle.alignItems,
        columnGap: chipStyle.columnGap,
        whiteSpace: chipStyle.whiteSpace,
        paddingInlineStart: chipStyle.paddingInlineStart,
        minWidth: chipStyle.minWidth,
      },
      name: {
        marginLeft: nameStyle.marginLeft,
        whiteSpace: nameStyle.whiteSpace,
      },
      avatar: {
        display: avatarStyle.display,
        verticalAlign: avatarStyle.verticalAlign,
      },
      machineWrapper: wrapperStyle
        ? {
            display: wrapperStyle.display,
            verticalAlign: wrapperStyle.verticalAlign,
          }
        : null,
      avatarOuter: {
        display: getComputedStyle(avatarOuter).display,
        position: getComputedStyle(avatarOuter).position,
        alignItems: getComputedStyle(avatarOuter).alignItems,
      },
      clip: {
        display: getComputedStyle(clip).display,
        overflowX: getComputedStyle(clip).overflowX,
        overflowY: getComputedStyle(clip).overflowY,
      },
    };
  };

  const currentStyleConfirmed = (value, kind) =>
    value.chip.display === "inline-block" &&
    value.chip.whiteSpace === "nowrap" &&
    Math.abs(Number.parseFloat(value.chip.paddingInlineStart) - 20) <= 0.01 &&
    Number.parseFloat(value.name.marginLeft) > 0 &&
    // Both kinds sit inside the absolute flex branch. Human avatars are
    // flex items too, and inline-flex therefore computes to flex.
    value.avatar.display === "flex" &&
    value.avatar.verticalAlign === "middle" &&
    value.avatarOuter.display === "flex" &&
    value.avatarOuter.position === "absolute" &&
    value.avatarOuter.alignItems === "center" &&
    value.clip.display === "block" &&
    value.clip.overflowX === "clip" &&
    value.clip.overflowY === "clip" &&
    (kind !== "machine" ||
      (value.machineWrapper?.display === "flex" &&
        value.machineWrapper?.verticalAlign === "middle"));

  const historicalStyleConfirmed = (value, kind) =>
    value.chip.display === "inline-flex" &&
    value.chip.alignItems === "center" &&
    Math.abs(Number.parseFloat(value.chip.columnGap) - 6) <= 0.01 &&
    value.chip.whiteSpace === "normal" &&
    value.chip.paddingInlineStart === "0px" &&
    value.chip.minWidth === "0px" &&
    value.avatarOuter.position === "static" &&
    value.avatarOuter.display === "contents" &&
    value.clip.display === "contents" &&
    value.clip.overflowX === "visible" &&
    value.clip.overflowY === "visible" &&
    value.name.marginLeft === "0px" &&
    value.name.whiteSpace === "nowrap" &&
    value.avatar.display === "flex" &&
    value.avatar.verticalAlign === "baseline" &&
    (kind !== "machine" ||
      (value.machineWrapper?.display === "flex" &&
        value.machineWrapper?.verticalAlign === "baseline"));

  const samples = [];
  const matrix = document.querySelector(
    '#fixture-avatar-matrix[aria-label="Avatar baseline matrix"]',
  );

  for (const id of expectedCases) {
    const row = matrix?.querySelector(`[data-avatar-case="${CSS.escape(id)}"]`);
    const chip = row?.querySelector('[data-avatar-participant="author"]');
    const peer = row?.querySelector('[data-avatar-participant="peer"]');
    const avatar = chip?.querySelector('[data-slot="avatar"]');
    const kind = id.startsWith("machine-") ? "machine" : "human";
    // Independent literals from AvatarBaselineSamples, never from the lookup.
    const expectedName = kind === "machine" ? "Bot One" : "Alice";
    const name = findName(chip, expectedName);
    const clip = name?.parentElement;
    const avatarOuter = avatar
      ? [...(chip?.children ?? [])].find((child) => child.contains(avatar))
      : null;
    const state = id.slice(id.indexOf("-") + 1);
    const badge = chip?.querySelector('svg[aria-label="agent"]') ?? null;
    const machineWrapper =
      kind === "machine" && avatar?.parentElement !== avatarOuter
        ? (avatar?.parentElement ?? null)
        : null;

    if (
      !row ||
      !chip ||
      !peer ||
      !avatar ||
      !name ||
      !clip ||
      !avatarOuter ||
      clip.parentElement !== chip ||
      avatarOuter.parentElement !== chip
    ) {
      samples.push({
        id,
        kind,
        state,
        status: "missing",
        reason:
          "real avatar matrix row, chip structure, or unique expected name did not render",
      });
      continue;
    }
    if ((kind === "machine") !== Boolean(badge && machineWrapper)) {
      samples.push({
        id,
        kind,
        state,
        status: "invalid",
        reason: "rendered UserChip kind does not match the matrix case",
      });
      continue;
    }

    const image = avatar.querySelector("img");
    const imageState = image
      ? { complete: image.complete, naturalWidth: image.naturalWidth }
      : null;
    const imageSettled =
      (state === "none" && image === null) ||
      (state === "failure" && (!image || image.naturalWidth === 0)) ||
      (["success", "delayed"].includes(state) &&
        image?.complete === true &&
        image.naturalWidth > 0);

    const beforeStyle = styles(
      chip,
      name,
      avatar,
      machineWrapper,
      avatarOuter,
      clip,
    );
    const geometry = [row, chip, name, peer, avatar];
    const nameBefore = baseline(name, geometry);
    const peerBefore = baseline(peer, geometry);
    const before = {
      nameBaselineCssPx: nameBefore.cssPx,
      peerBaselineCssPx: peerBefore.cssPx,
      nameMinusPeerCssPx: round(nameBefore.cssPx - peerBefore.cssPx),
      absoluteDeltaCssPx: round(Math.abs(nameBefore.cssPx - peerBefore.cssPx)),
      excessCssPx: round(
        Math.max(0, Math.abs(nameBefore.cssPx - peerBefore.cssPx) - epsilon),
      ),
      thresholdCssPx: epsilon,
      rowHeightCssPx: rect(row).height,
      chipHeightCssPx: rect(chip).height,
      markers: { name: nameBefore, peer: peerBefore },
    };

    if (mode === "fault") {
      chip.style.display = "inline-flex";
      chip.style.alignItems = "center";
      chip.style.gap = "0.375rem";
      chip.style.whiteSpace = "normal";
      // T-487 moved the avatar out of flow and reserved its width with ps-5.
      // Dissolve that positioning box and T-486's clipping box, so the actual
      // avatar (or machine wrapper) and name become the historical flex items.
      // Retain nodes/classes for diagnostics; restoration needs a new document.
      chip.style.paddingInlineStart = "0px";
      chip.style.minWidth = "0px";
      avatarOuter.style.position = "static";
      avatarOuter.style.display = "contents";
      clip.style.display = "contents";
      clip.style.overflow = "visible";
      name.style.marginLeft = "0px";
      name.style.whiteSpace = "nowrap";
      avatar.style.display = "flex";
      avatar.style.verticalAlign = "baseline";
      if (machineWrapper) machineWrapper.style.verticalAlign = "baseline";
    }

    const afterStyle = styles(
      chip,
      name,
      avatar,
      machineWrapper,
      avatarOuter,
      clip,
    );
    const nameAfter = baseline(name, geometry);
    const peerAfter = baseline(peer, geometry);
    const after = {
      nameBaselineCssPx: nameAfter.cssPx,
      peerBaselineCssPx: peerAfter.cssPx,
      nameMinusPeerCssPx: round(nameAfter.cssPx - peerAfter.cssPx),
      absoluteDeltaCssPx: round(Math.abs(nameAfter.cssPx - peerAfter.cssPx)),
      excessCssPx: round(
        Math.max(0, Math.abs(nameAfter.cssPx - peerAfter.cssPx) - epsilon),
      ),
      thresholdCssPx: epsilon,
      rowHeightCssPx: rect(row).height,
      chipHeightCssPx: rect(chip).height,
      markers: { name: nameAfter, peer: peerAfter },
    };
    const markerStable = [nameBefore, peerBefore, nameAfter, peerAfter].every(
      (reading) => reading.geometryStable,
    );
    const cleanConfirmed = currentStyleConfirmed(beforeStyle, kind);
    const mutationConfirmed =
      mode === "fault" &&
      cleanConfirmed &&
      historicalStyleConfirmed(afterStyle, kind);
    const cleanReadConfirmed =
      mode === "clean" &&
      cleanConfirmed &&
      currentStyleConfirmed(afterStyle, kind);
    const confirmed = mode === "fault" ? mutationConfirmed : cleanReadConfirmed;

    samples.push({
      id,
      kind,
      state,
      status:
        !imageSettled || !markerStable || !confirmed ? "invalid" : "measured",
      reason: !imageSettled
        ? "avatar image state is not settled"
        : !markerStable
          ? "zero-size baseline marker changed measured geometry"
          : !confirmed
            ? mode === "fault"
              ? "historical chip/avatar declarations were not effective"
              : "fresh page does not expose the current chip/avatar declarations"
            : null,
      expectedName,
      measuredName: name.textContent?.trim(),
      targets: {
        chip: chip.tagName.toLowerCase(),
        avatarOuter: avatarOuter.className,
        clip: clip.className,
        avatar: avatar.className,
      },
      image: imageState,
      style: {
        before: beforeStyle,
        after: afterStyle,
        currentBeforeConfirmed: cleanConfirmed,
        effectiveMutationConfirmed: mutationConfirmed,
        cleanReadConfirmed,
      },
      baseline: { before, after },
    });
  }

  const widthConfirmed = innerWidth === expectedWidth;
  const missing = samples.some((sample) => sample.status === "missing");
  const invalid = samples.some((sample) => sample.status === "invalid");
  return {
    id: "T-359",
    mode,
    status: !widthConfirmed
      ? "invalid"
      : missing
        ? "missing"
        : invalid
          ? "invalid"
          : "ok",
    reason: !widthConfirmed
      ? `expected ${expectedWidth} CSS px viewport, received ${innerWidth}`
      : missing
        ? "one or more real avatar matrix samples are missing"
        : invalid
          ? "one or more avatar samples could not confirm the effective style or measurement"
          : null,
    documentId: globalThis[documentKey],
    viewport: {
      widthCssPx: innerWidth,
      heightCssPx: innerHeight,
      devicePixelRatio,
    },
    mutation: {
      requested: mode === "fault",
      restore: "fresh-page-required",
      expectedSampleCount: expectedCases.length,
      confirmedSampleCount: samples.filter(
        (sample) => sample.style?.effectiveMutationConfirmed,
      ).length,
    },
    samples,
  };
}

/**
 * Run inside Chromium at a desktop viewport. It finds machine badges inside
 * the overflow-clipping summary span of genuine EventRow and CollapsedGroup
 * roots. Actor badges outside that span are not candidates.
 */
export async function probeT416BadgeClippingFault(options = {}) {
  const mode = options.mode ?? "fault";
  const epsilon = options.epsilon ?? 0.125;
  const requiredSurfaces = ["event-row", "collapsed-group"];
  const round = (value) => {
    if (!Number.isFinite(value)) return null;
    const rounded = Number(value.toFixed(5));
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const documentKey = "__todouUserBaselineFaultDocumentId__";
  if (!globalThis[documentKey]) {
    const words = new Uint32Array(4);
    crypto.getRandomValues(words);
    Object.defineProperty(globalThis, documentKey, {
      value: [...words]
        .map((word) => word.toString(16).padStart(8, "0"))
        .join("-"),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  await document.fonts.ready;

  const clipsAxis = (value) =>
    ["auto", "clip", "hidden", "scroll"].includes(value);
  const rootFor = (badge) => {
    const event = badge.closest('[id^="event-"]');
    if (event && /^event-[0-9]+$/.test(event.id)) {
      return { surface: "event-row", root: event };
    }
    const group = badge.closest('[data-testid="event-group"]');
    const root = group?.firstElementChild ?? null;
    const toggle = root?.querySelector(
      ':scope > button[data-testid="event-group-toggle"]',
    );
    return root?.contains(badge) &&
      toggle?.getAttribute("aria-expanded") === "false"
      ? { surface: "collapsed-group", root }
      : null;
  };
  const clippingTargetFor = (badge, root) => {
    for (
      let element = badge.parentElement;
      element;
      element = element.parentElement
    ) {
      const style = getComputedStyle(element);
      if (clipsAxis(style.overflowX) || clipsAxis(style.overflowY)) {
        // Only the direct production summary span is this fault's target.
        return element.parentElement === root &&
          element.tagName === "SPAN" &&
          element.hasAttribute("title") &&
          element.classList.contains("min-w-0") &&
          element.classList.contains("sm:truncate")
          ? element
          : null;
      }
      if (element === root) break;
    }
    return null;
  };
  const targetStyle = (target) => {
    const style = getComputedStyle(target);
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
    };
  };
  const currentAllowanceConfirmed = (style) =>
    Number.parseFloat(style.paddingTop) > 0 &&
    Number.parseFloat(style.paddingBottom) > 0 &&
    Math.abs(
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.marginTop),
    ) <= epsilon &&
    Math.abs(
      Number.parseFloat(style.paddingBottom) +
        Number.parseFloat(style.marginBottom),
    ) <= epsilon &&
    clipsAxis(style.overflowX) &&
    clipsAxis(style.overflowY);
  const removedAllowanceConfirmed = (style) =>
    style.paddingTop === "0px" &&
    style.paddingBottom === "0px" &&
    style.marginTop === "0px" &&
    style.marginBottom === "0px" &&
    clipsAxis(style.overflowX) &&
    clipsAxis(style.overflowY);
  const clippingAncestors = (badge) => {
    const ancestors = [];
    let depth = 0;
    for (
      let element = badge.parentElement;
      element;
      element = element.parentElement
    ) {
      const style = getComputedStyle(element);
      const clipX = clipsAxis(style.overflowX);
      const clipY = clipsAxis(style.overflowY);
      if (clipX || clipY) {
        const box = element.getBoundingClientRect();
        const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
        const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
        const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
        const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
        ancestors.push({
          depth,
          tag: element.tagName.toLowerCase(),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          clipX,
          clipY,
          left: box.left + borderLeft,
          right: box.right - borderRight,
          top: box.top + borderTop,
          bottom: box.bottom - borderBottom,
        });
      }
      depth += 1;
    }
    return ancestors;
  };
  const measureBadge = (badge) => {
    const box = badge.getBoundingClientRect();
    const ancestors = clippingAncestors(badge);
    let clipLeft = 0;
    let clipRight = innerWidth;
    // Vertical viewport cropping is scrolling, not this CSS-overflow fault.
    // Every accepted candidate has a summary clipping ancestor, so these
    // bounds become finite when that ancestor is intersected below.
    let clipTop = -Infinity;
    let clipBottom = Infinity;
    for (const ancestor of ancestors) {
      if (ancestor.clipX) {
        clipLeft = Math.max(clipLeft, ancestor.left);
        clipRight = Math.min(clipRight, ancestor.right);
      }
      if (ancestor.clipY) {
        clipTop = Math.max(clipTop, ancestor.top);
        clipBottom = Math.min(clipBottom, ancestor.bottom);
      }
    }
    const horizontalVisible = Math.max(
      0,
      Math.min(box.right, clipRight) - Math.max(box.left, clipLeft),
    );
    const verticalVisible = Math.max(
      0,
      Math.min(box.bottom, clipBottom) - Math.max(box.top, clipTop),
    );
    const topSigned = clipTop - box.top;
    const bottomSigned = box.bottom - clipBottom;
    return {
      badge: {
        top: round(box.top),
        right: round(box.right),
        bottom: round(box.bottom),
        left: round(box.left),
        width: round(box.width),
        height: round(box.height),
      },
      intersection: {
        top: round(clipTop),
        right: round(clipRight),
        bottom: round(clipBottom),
        left: round(clipLeft),
        horizontalVisibleCssPx: round(horizontalVisible),
        verticalVisibleCssPx: round(verticalVisible),
      },
      // Positive means that edge is clipped; negative means CSS-pixel clearance.
      topSignedClippedCssPx: round(topSigned),
      bottomSignedClippedCssPx: round(bottomSigned),
      positiveClippedCssPx: round(
        Math.max(0, topSigned) + Math.max(0, bottomSigned),
      ),
      horizontallyVisible: horizontalVisible > epsilon,
      clippingAncestors: ancestors.map((ancestor) => ({
        depth: ancestor.depth,
        tag: ancestor.tag,
        overflowX: ancestor.overflowX,
        overflowY: ancestor.overflowY,
        clipX: ancestor.clipX,
        clipY: ancestor.clipY,
        edges: {
          top: round(ancestor.top),
          right: round(ancestor.right),
          bottom: round(ancestor.bottom),
          left: round(ancestor.left),
        },
      })),
    };
  };

  const rejected = [];
  const candidates = [];
  for (const badge of document.querySelectorAll('svg[aria-label="agent"]')) {
    const owner = rootFor(badge);
    if (!owner) {
      rejected.push({
        reason:
          "badge is not in a genuine EventRow or closed CollapsedGroup root",
      });
      continue;
    }
    const target = clippingTargetFor(badge, owner.root);
    if (!target?.contains(badge)) {
      rejected.push({
        surface: owner.surface,
        reason: "machine badge is outside the overflow-clipping summary",
      });
      continue;
    }
    candidates.push({ badge, target, ...owner });
  }

  const targetRecords = new Map();
  for (const candidate of candidates) {
    if (targetRecords.has(candidate.target)) continue;
    targetRecords.set(candidate.target, {
      beforeStyle: targetStyle(candidate.target),
    });
  }
  const rootHeights = new Map(
    candidates.map(({ root }) => [root, root.getBoundingClientRect().height]),
  );
  const beforeMeasurements = new Map(
    candidates.map(({ badge }) => [badge, measureBadge(badge)]),
  );

  if (mode === "fault") {
    for (const target of targetRecords.keys()) {
      // This is the exact pre-T-416 absence of both sm:py-1 and sm:-my-1.
      target.style.paddingTop = "0px";
      target.style.paddingBottom = "0px";
      target.style.marginTop = "0px";
      target.style.marginBottom = "0px";
    }
  }
  // Force the post-mutation layout before recording effective styles/rectangles.
  void document.documentElement.offsetHeight;

  for (const [target, record] of targetRecords) {
    record.afterStyle = targetStyle(target);
    record.currentBeforeConfirmed = currentAllowanceConfirmed(
      record.beforeStyle,
    );
    record.effectiveMutationConfirmed =
      mode === "fault" &&
      record.currentBeforeConfirmed &&
      removedAllowanceConfirmed(record.afterStyle);
    record.cleanReadConfirmed =
      mode === "clean" &&
      record.currentBeforeConfirmed &&
      currentAllowanceConfirmed(record.afterStyle);
  }

  const measured = candidates.map((candidate, index) => {
    const before = beforeMeasurements.get(candidate.badge);
    const after = measureBadge(candidate.badge);
    const record = targetRecords.get(candidate.target);
    const horizontallyVisible =
      before.horizontallyVisible && after.horizontallyVisible;
    const confirmed =
      mode === "fault"
        ? record.effectiveMutationConfirmed
        : record.cleanReadConfirmed;
    return {
      sample: index + 1,
      surface: candidate.surface,
      status: !horizontallyVisible
        ? "filtered"
        : !confirmed
          ? "invalid"
          : "measured",
      reason: !horizontallyVisible
        ? "badge is not horizontally visible through every clipping ancestor"
        : !confirmed
          ? mode === "fault"
            ? "removing the py-1/-my-1 allowance was not effective"
            : "desktop py-1/-my-1 allowance is not effective on the fresh page"
          : null,
      rowHeightCssPx: {
        before: round(rootHeights.get(candidate.root)),
        after: round(candidate.root.getBoundingClientRect().height),
      },
      targetStyle: {
        before: record.beforeStyle,
        after: record.afterStyle,
        currentBeforeConfirmed: record.currentBeforeConfirmed,
        effectiveMutationConfirmed: record.effectiveMutationConfirmed,
        cleanReadConfirmed: record.cleanReadConfirmed,
      },
      clipping: { before, after },
    };
  });

  const surfaces = requiredSurfaces.map((surface) => {
    const entries = measured.filter((sample) => sample.surface === surface);
    const usable = entries.filter((sample) => sample.status !== "filtered");
    const missing = usable.length === 0;
    const invalid = usable.some((sample) => sample.status === "invalid");
    return {
      surface,
      status: missing ? "missing" : invalid ? "invalid" : "measured",
      reason: missing
        ? "no horizontally-visible machine badge rendered inside the clipping summary"
        : invalid
          ? "effective summary style could not be confirmed"
          : null,
      candidateCount: entries.length,
      measuredCount: usable.length,
    };
  });
  const missing = surfaces.some((surface) => surface.status === "missing");
  const invalid = surfaces.some((surface) => surface.status === "invalid");

  return {
    id: "T-416",
    mode,
    status: missing ? "missing" : invalid ? "invalid" : "ok",
    reason: missing
      ? "one or more genuine machine-badge surfaces are missing"
      : invalid
        ? "one or more surfaces did not confirm the effective style mutation"
        : null,
    documentId: globalThis[documentKey],
    viewport: {
      widthCssPx: innerWidth,
      heightCssPx: innerHeight,
      devicePixelRatio,
    },
    mutation: {
      requested: mode === "fault",
      restore: "fresh-page-required",
      targetCount: targetRecords.size,
      confirmedTargetCount: [...targetRecords.values()].filter(
        (record) => record.effectiveMutationConfirmed,
      ).length,
    },
    surfaces,
    samples: measured,
    rejected,
  };
}

/** Pure runner-side proof that T-359 went red and a newly loaded page is green. */
export function assessT359FreshPageRestore(fault, restored, epsilon = 0.125) {
  const reasons = [];
  if (
    fault?.id !== "T-359" ||
    fault?.mode !== "fault" ||
    fault?.status !== "ok"
  ) {
    reasons.push("fault run is not an ok T-359 fault result");
  }
  if (
    restored?.id !== "T-359" ||
    restored?.mode !== "clean" ||
    restored?.status !== "ok"
  ) {
    reasons.push("restore run is not an ok T-359 clean result");
  }
  if (
    !fault?.documentId ||
    !restored?.documentId ||
    fault.documentId === restored.documentId
  ) {
    reasons.push("restore was not measured in a fresh document");
  }
  if (
    fault?.viewport?.widthCssPx !== 390 ||
    restored?.viewport?.widthCssPx !== 390
  ) {
    reasons.push("both T-359 runs must use the 390 CSS px viewport");
  }
  const expected = ["human", "machine"].flatMap((kind) =>
    ["none", "success", "failure", "delayed"].map(
      (state) => `${kind}-${state}`,
    ),
  );
  for (const [label, result] of [
    ["fault", fault],
    ["restore", restored],
  ]) {
    const ids = (result?.samples ?? []).map((sample) => sample.id);
    if (
      ids.length !== expected.length ||
      expected.some((id) => !ids.includes(id))
    ) {
      reasons.push(`${label}: complete eight-case avatar matrix is required`);
    }
  }
  for (const sample of fault?.samples ?? []) {
    if (
      !Number.isFinite(sample.baseline?.before?.nameMinusPeerCssPx) ||
      Math.abs(sample.baseline.before.nameMinusPeerCssPx) > epsilon
    ) {
      reasons.push(
        `${sample.id ?? "unknown"}: pre-fault baseline was not healthy`,
      );
    }
    if (
      sample.status !== "measured" ||
      !sample.style?.effectiveMutationConfirmed
    ) {
      reasons.push(
        `${sample.id ?? "unknown"}: fault mutation was not confirmed`,
      );
    } else if (
      !Number.isFinite(sample.baseline?.after?.nameMinusPeerCssPx) ||
      Math.abs(sample.baseline.after.nameMinusPeerCssPx) <= epsilon
    ) {
      reasons.push(
        `${sample.id}: historical style did not create a baseline fault`,
      );
    }
  }
  for (const sample of restored?.samples ?? []) {
    if (sample.status !== "measured" || !sample.style?.cleanReadConfirmed) {
      reasons.push(`${sample.id ?? "unknown"}: clean style was not confirmed`);
    } else if (
      !Number.isFinite(sample.baseline?.after?.nameMinusPeerCssPx) ||
      Math.abs(sample.baseline.after.nameMinusPeerCssPx) > epsilon
    ) {
      reasons.push(`${sample.id}: fresh-page baseline was not restored`);
    }
  }
  return {
    id: "T-359",
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    thresholdCssPx: epsilon,
    samples: expected.map((id) => {
      const faulty = fault?.samples?.find((sample) => sample.id === id);
      const clean = restored?.samples?.find((sample) => sample.id === id);
      return {
        id,
        fault: faulty?.baseline ?? null,
        restore: clean?.baseline ?? null,
        faultStyle: faulty?.style ?? null,
        restoreStyle: clean?.style ?? null,
        faultStatus: faulty?.status ?? "missing",
        restoreStatus: clean?.status ?? "missing",
      };
    }),
  };
}

/** Pure runner-side proof that T-416 clipped and a newly loaded page did not. */
export function assessT416FreshPageRestore(fault, restored, epsilon = 0.125) {
  const reasons = [];
  if (
    fault?.id !== "T-416" ||
    fault?.mode !== "fault" ||
    fault?.status !== "ok"
  ) {
    reasons.push("fault run is not an ok T-416 fault result");
  }
  if (
    restored?.id !== "T-416" ||
    restored?.mode !== "clean" ||
    restored?.status !== "ok"
  ) {
    reasons.push("restore run is not an ok T-416 clean result");
  }
  if (!fault?.documentId || fault.documentId === restored?.documentId) {
    reasons.push("restore was not measured in a fresh document");
  }
  for (const surface of ["event-row", "collapsed-group"]) {
    const faultSamples = (fault?.samples ?? []).filter(
      (sample) => sample.surface === surface && sample.status === "measured",
    );
    const cleanSamples = (restored?.samples ?? []).filter(
      (sample) => sample.surface === surface && sample.status === "measured",
    );
    if (faultSamples.length === 0)
      reasons.push(`${surface}: fault sample is missing`);
    if (cleanSamples.length === 0)
      reasons.push(`${surface}: clean sample is missing`);
    if (
      faultSamples.some(
        (sample) =>
          !sample.targetStyle.effectiveMutationConfirmed ||
          !Number.isFinite(sample.clipping?.after?.positiveClippedCssPx) ||
          sample.clipping.after.positiveClippedCssPx <= epsilon ||
          !Number.isFinite(sample.rowHeightCssPx?.before) ||
          !Number.isFinite(sample.rowHeightCssPx?.after) ||
          Math.abs(sample.rowHeightCssPx.before - sample.rowHeightCssPx.after) >
            epsilon,
      )
    ) {
      reasons.push(
        `${surface}: py-1 fault did not produce confirmed positive clipping with stable row height`,
      );
    }
    if (
      cleanSamples.some(
        (sample) =>
          !sample.targetStyle.cleanReadConfirmed ||
          !Number.isFinite(sample.clipping?.after?.positiveClippedCssPx) ||
          sample.clipping.after.positiveClippedCssPx > epsilon ||
          !Number.isFinite(sample.rowHeightCssPx?.before) ||
          !Number.isFinite(sample.rowHeightCssPx?.after) ||
          Math.abs(sample.rowHeightCssPx.before - sample.rowHeightCssPx.after) >
            epsilon,
      )
    ) {
      reasons.push(
        `${surface}: fresh page retained clipping or changed row height`,
      );
    }
  }
  return {
    id: "T-416",
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
  };
}
