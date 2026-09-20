/**
 * Browser-only and closure-free: embed findUserChipName.toString() in evaluate,
 * or pass it as options.nameFinderSource to the historical probe and drill.
 * expectedText MUST come from seed/API data, never from this DOM lookup.
 * Returns the unique visible name HTMLElement, or null (fail closed).
 */
export function findUserChipName(chip, expectedText) {
  const fail = () => null;
  if (typeof expectedText !== "string" || !expectedText.trim()) {
    return fail("independent expected name is required");
  }
  if (!(chip instanceof HTMLElement) || !chip.isConnected) {
    return fail("chip is missing or disconnected", "missing");
  }
  if (!chip.matches("a, span") || chip.closest('[data-slot="avatar"]')) {
    return fail("name owner is not a chip");
  }
  const clips = [...chip.children].filter((child) =>
    child.matches("span.block.overflow-clip.text-ellipsis"),
  );
  if (clips.length !== 1) return fail("expected one direct name clipping box");
  const clip = clips[0];
  const avatars = [...chip.querySelectorAll('[data-slot="avatar"]')];
  if (avatars.length !== 1 || clip.contains(avatars[0])) {
    return fail("expected one avatar outside the name clipping box");
  }
  // Bound ownership to this chip's direct avatar branch, including machine badge.
  const avatar = avatars[0];
  const avatarBranch = [...chip.children].find((child) =>
    child.contains(avatar),
  );
  if (
    !avatarBranch ||
    avatarBranch === clip ||
    avatarBranch.querySelector("a")
  ) {
    return fail("avatar belongs to a nested chip");
  }
  const candidates = [...clip.children].filter(
    (child) =>
      child.matches("span.ml-1\\.5") &&
      !(
        child.classList.contains("text-muted-foreground") &&
        child.textContent?.trim().startsWith("@")
      ),
  );
  if (candidates.length !== 1) {
    return fail(`expected one name candidate, found ${candidates.length}`);
  }
  const name = candidates[0];
  const text = name.textContent?.trim() ?? "";
  if (!text || text !== expectedText.trim())
    return fail("name text does not match independent expectation");
  // UserChip renders one text child; nested chips, decoys and split text are invalid.
  const texts = [...name.childNodes].filter(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
  if (name.children.length || texts.length !== 1)
    return fail("name is not one direct text leaf");
  for (let ancestor = name; ancestor; ancestor = ancestor.parentElement) {
    const css = getComputedStyle(ancestor);
    if (
      ancestor.hidden ||
      ancestor.getAttribute("aria-hidden") === "true" ||
      css.display === "none" ||
      css.visibility !== "visible" ||
      css.contentVisibility === "hidden" ||
      Number(css.opacity) === 0
    ) {
      return fail("name or ancestor is hidden");
    }
  }
  const textNode = texts[0];
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const boxes = [...range.getClientRects()].filter(
    (box) => box.width > 0 && box.height > 0,
  );
  if (!boxes.length || !name.getClientRects().length)
    return fail("name has no rendered text rectangle");
  // Ellipsis is allowed, but some text must survive every clipping ancestor.
  const visible = boxes.some((box) => {
    let left = box.left,
      right = box.right,
      top = box.top,
      bottom = box.bottom;
    for (
      let ancestor = name.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const css = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (["hidden", "clip", "auto", "scroll"].includes(css.overflowX)) {
        left = Math.max(left, bounds.left);
        right = Math.min(right, bounds.right);
      }
      if (["hidden", "clip", "auto", "scroll"].includes(css.overflowY)) {
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return right > left && bottom > top;
  });
  if (!visible) return fail("name text is fully clipped");
  return name;
}

/**
 * Independent fixed-DOM oracle, deliberately not a second name lookup.
 * await evaluate(page, probeUserChipNameLookup, {
 *   nameFinderSource: findUserChipName.toString(),
 * });
 * Require result.status === "pass". Every mutation has its own restored check.
 */
export async function probeUserChipNameLookup(options = {}) {
  if (typeof options.nameFinderSource !== "string") {
    return {
      status: "fail",
      reason: "nameFinderSource is required",
      samples: [],
    };
  }
  const findName = new Function(`return (${options.nameFinderSource});`)();
  await document.fonts.ready;
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:16px;top:16px;z-index:2147483647;background:white;color:black;font:16px/24px sans-serif";
  const chip = document.createElement("a");
  chip.href = "/users/alice";
  chip.style.cssText =
    "display:inline-block;position:relative;padding-inline-start:20px;white-space:nowrap";
  const branch = document.createElement("span");
  branch.style.cssText =
    "position:absolute;inset-block:0;inset-inline-start:0;display:flex;align-items:center";
  const avatar = document.createElement("span");
  avatar.dataset.slot = "avatar";
  avatar.style.cssText = "display:inline-flex;width:20px;height:20px";
  avatar.textContent = "A";
  branch.append(avatar);
  const clip = document.createElement("span");
  clip.className = "block overflow-clip text-ellipsis";
  clip.style.cssText = "display:block;overflow:clip;text-overflow:ellipsis";
  const name = document.createElement("span");
  name.className = "ml-1.5";
  name.textContent = "Alice";
  const knownTextNode = name.firstChild;
  const login = document.createElement("span");
  login.className = "ml-1.5 text-muted-foreground";
  login.textContent = "@alice";
  clip.append(name, login);
  chip.append(branch, clip);
  host.append(chip);
  document.body.append(host);
  const samples = [];
  const record = (id, expected, effective = true) => {
    const result = findName(chip, "Alice");
    const identityConfirmed =
      result === name &&
      result?.parentElement === clip &&
      result?.firstChild === knownTextNode &&
      result?.textContent === "Alice";
    const pass =
      effective && (expected === "ok" ? identityConfirmed : result === null);
    samples.push({
      id,
      expected,
      actual: result === null ? "invalid" : "ok",
      mutationConfirmed: effective,
      identityConfirmed,
      status: pass ? "pass" : "fail",
    });
  };
  try {
    record("healthy", "ok");
    const decoy = document.createElement("span");
    decoy.className = "ml-1.5";
    decoy.textContent = "Avatar Decoy";
    avatar.prepend(decoy);
    record("avatar-decoy", "ok", avatar.contains(decoy));
    decoy.remove();
    record("avatar-decoy/restored", "ok", !decoy.isConnected);
    name.remove();
    record(
      "name-removed-with-login",
      "invalid",
      !name.isConnected && login.textContent === "@alice" && login.isConnected,
    );
    clip.prepend(name);
    record(
      "name-removed-with-login/restored",
      "ok",
      name.parentElement === clip,
    );
    const duplicate = name.cloneNode(true);
    clip.append(duplicate);
    record(
      "duplicate",
      "invalid",
      duplicate.parentElement === clip && duplicate.textContent === "Alice",
    );
    duplicate.remove();
    record("duplicate/restored", "ok", !duplicate.isConnected);
    knownTextNode.data = "";
    record("empty", "invalid", name.textContent === "");
    knownTextNode.data = "Alice";
    record("empty/restored", "ok", name.textContent === "Alice");
    name.style.display = "none";
    record("hidden", "invalid", getComputedStyle(name).display === "none");
    name.style.removeProperty("display");
    record("hidden/restored", "ok", getComputedStyle(name).display !== "none");
    return {
      status: samples.every((sample) => sample.status === "pass")
        ? "pass"
        : "fail",
      oracle:
        "fixed DOM, literal Alice, retained name/clip/Text node identities",
      samples,
    };
  } finally {
    host.remove();
  }
}
