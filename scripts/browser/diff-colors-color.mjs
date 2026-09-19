/**
 * Colors are unpremultiplied, encoded sRGB [r, g, b, a], with all channels in
 * [0, 1]. RGB comparisons allow one 8-bit step; alpha must match exactly.
 */
export function colorsEqual(actual, expected) {
  const valid = (color) =>
    Array.isArray(color) &&
    color.length === 4 &&
    [0, 1, 2, 3].every(
      (index) =>
        Number.isFinite(color[index]) && color[index] >= 0 && color[index] <= 1,
    );
  return (
    valid(actual) &&
    valid(expected) &&
    actual[3] === expected[3] &&
    actual.slice(0, 3).every(
      // A subtraction at the one-step boundary can round up by one float ULP.
      (value, index) =>
        Math.abs(value - expected[index]) <= 1 / 255 + Number.EPSILON,
    )
  );
}

/** WCAG 2.x: composite the foreground first; a translucent backdrop is unknown. */
export function contrastRatio(foreground, background) {
  const painted = browserColorTools().composite(foreground, background);
  if (background[3] !== 1)
    throw new Error("Contrast requires an opaque, resolved background");
  const luminance = (color) => {
    const linear = color
      .slice(0, 3)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const fg = luminance(painted);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

/**
 * Serialize this entire function for injection; it has no module dependencies.
 * DOM access is lazy, so composite() also works in host-side math checks.
 */
export function browserColorTools() {
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const number = (token, scale = 1) => {
    if (token === "none") return 0;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(token))
      throw new Error(`Unsupported computed color component: ${token}`);
    const value = token.endsWith("%")
      ? Number(token.slice(0, -1)) / 100
      : Number(token) / scale;
    if (!Number.isFinite(value))
      throw new Error(`Non-finite computed color component: ${token}`);
    return value;
  };
  const parts = (value) => {
    const match = /^(rgba?|color|(?:ok)?lab|(?:ok)?lch)\((.*)\)$/i.exec(
      value.trim(),
    );
    if (!match) return null;
    const body = match[2].replaceAll(",", " ").replaceAll("/", " / ");
    const tokens = body.trim().split(/\s+/);
    const space = match[1].toLowerCase();
    if (space === "color" && tokens.shift()?.toLowerCase() !== "srgb")
      return null;
    const slash = tokens.indexOf("/");
    const components = slash < 0 ? tokens.slice(0, 3) : tokens.slice(0, slash);
    const alphaTokens = slash < 0 ? tokens.slice(3) : tokens.slice(slash + 1);
    if (components.length !== 3 || alphaTokens.length > 1)
      throw new Error(`Unsupported computed color: ${value}`);
    return {
      space,
      components,
      alpha: clamp(alphaTokens.length ? number(alphaTokens[0]) : 1),
    };
  };
  const readSrgb = (value) => {
    const parsed = parts(value);
    // Lab/LCH (D50) and OKLab/OKLCH need the browser's color-space conversion.
    if (!parsed || !["rgb", "rgba", "color"].includes(parsed.space))
      return null;
    const scale = parsed.space.startsWith("rgb") ? 255 : 1;
    return [
      ...parsed.components.map((token) => number(token, scale)),
      parsed.alpha,
    ];
  };
  const valid = (color) =>
    Array.isArray(color) &&
    color.length === 4 &&
    [0, 1, 2, 3].every(
      (index) =>
        Number.isFinite(color[index]) && color[index] >= 0 && color[index] <= 1,
    );

  function composite(top, bottom) {
    if (!valid(top) || !valid(bottom))
      throw new Error("Composite requires normalized sRGB [r, g, b, a] colors");
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    // CSS source-over composites encoded sRGB; linearization happens afterward
    // for WCAG luminance, not during this operation.
    return [
      ...top
        .slice(0, 3)
        .map((value, index) =>
          clamp(
            (value * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha,
          ),
        ),
      alpha,
    ];
  }

  function probe(doc, context, callback) {
    const view = doc.defaultView;
    if (!view || !doc.documentElement)
      throw new Error("Color resolution requires an active browser document");
    const host = doc.createElement("span");
    host.style.cssText = "all: initial !important; display: none !important;";
    const node = doc.createElement("span");
    node.style.cssText = "all: initial !important;";
    host.attachShadow({ mode: "closed" }).append(node);
    if (context) {
      const style = view.getComputedStyle(context);
      // Copy onto the probe itself, including registered non-inheriting custom
      // properties. The shadow root prevents selectors/animations from changing
      // the measurement and the host is removed even when resolution fails.
      for (const name of style) {
        if (name.startsWith("--"))
          node.style.setProperty(
            name,
            style.getPropertyValue(name) || "initial",
            "important",
          );
      }
      node.style.setProperty("color", style.color, "important");
      node.style.setProperty("color-scheme", style.colorScheme, "important");
    }
    doc.documentElement.append(host);
    try {
      return callback(node, view);
    } finally {
      host.remove();
    }
  }

  function computed(node, view, expression) {
    node.style.removeProperty("background-color");
    node.style.setProperty("background-color", expression, "important");
    if (!node.style.backgroundColor)
      throw new Error(`Browser rejected color: ${expression}`);
    return view.getComputedStyle(node).backgroundColor;
  }

  function opaqueCanvas(doc, value, alpha) {
    const parsed = parts(value);
    if (!parsed)
      throw new Error(
        `Cannot safely remove alpha from computed color: ${value}`,
      );
    const prefix =
      parsed.space === "color" ? "color(srgb " : `${parsed.space}(`;
    const opaque = `${prefix}${parsed.components.join(" ")} / 1)`;
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", {
      colorSpace: "srgb",
      willReadFrequently: true,
    });
    if (!ctx)
      throw new Error("sRGB Canvas 2D is unavailable for color conversion");
    // Two sentinels distinguish an unsupported fillStyle from any valid color.
    ctx.fillStyle = "#010203";
    ctx.fillStyle = opaque;
    const first = ctx.fillStyle;
    ctx.fillStyle = "#040506";
    ctx.fillStyle = opaque;
    if (ctx.fillStyle !== first)
      throw new Error(`Canvas cannot convert color: ${value}`);
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    if (pixel[3] !== 255)
      throw new Error(`Canvas did not produce an opaque conversion: ${value}`);
    // Crucially, paint with alpha ONE and restore the independently parsed
    // alpha. Reading a translucent 8-bit canvas can amplify quantization error
    // by 1/alpha (and destroys hidden channels at alpha zero). This fallback's
    // channel rounding is at most half an 8-bit step, independent of alpha.
    return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, alpha];
  }

  function normalizeInDocument(cssColor, doc) {
    if (typeof cssColor !== "string" || !cssColor.trim())
      throw new Error("A nonempty computed CSS color is required");
    const value = cssColor.trim();
    const direct = readSrgb(value);
    if (direct?.slice(0, 3).every((channel) => channel >= 0 && channel <= 1))
      return direct;
    return probe(doc, null, (node, view) => {
      if (
        /\b(?:var|env|attr|light-dark)\s*\(|\bcurrentcolor\b/i.test(value) ||
        /^(?:initial|inherit|unset|revert|revert-layer)$/i.test(value)
      )
        throw new Error(
          "Contextual colors require resolve(element, expression)",
        );
      const absolute = computed(node, view, value);
      const parsed = parts(absolute);
      if (!parsed) throw new Error(`Unsupported computed color: ${absolute}`);
      const srgb = readSrgb(absolute);
      if (srgb?.slice(0, 3).every((channel) => channel >= 0 && channel <= 1))
        return srgb;
      const relative = `color(from ${absolute} srgb r g b / alpha)`;
      if (view.CSS.supports("background-color", relative)) {
        const converted = readSrgb(computed(node, view, relative));
        if (!converted)
          throw new Error(
            `Browser failed relative sRGB conversion: ${absolute}`,
          );
        if (
          converted.slice(0, 3).every((channel) => channel >= 0 && channel <= 1)
        )
          return [...converted.slice(0, 3), parsed.alpha];
      }
      // Older browsers, or out-of-gamut colors: let the browser render/map to
      // sRGB instead of inventing a gamut mapping by clamping relative channels.
      return opaqueCanvas(doc, absolute, parsed.alpha);
    });
  }

  function normalize(cssColor) {
    return normalizeInDocument(cssColor, document);
  }

  function resolve(element, expression) {
    if (!element?.isConnected || element.nodeType !== 1)
      throw new Error("Color resolution requires a connected element");
    if (typeof expression !== "string" || !expression.trim())
      throw new Error("A nonempty expected color expression is required");
    return probe(element.ownerDocument, element, (node, view) => {
      // A custom property exposes failed var() substitution, which otherwise
      // silently becomes the transparent initial background-color value.
      const name = "--__diff-colors-probe-value";
      if (expression.includes(name))
        throw new Error(
          "Color expression refers to the reserved probe property",
        );
      node.style.setProperty(name, expression, "important");
      const substituted = view
        .getComputedStyle(node)
        .getPropertyValue(name)
        .trim();
      if (
        !substituted ||
        /^(?:initial|inherit|unset|revert|revert-layer)$/i.test(substituted) ||
        !view.CSS.supports("background-color", substituted)
      )
        throw new Error(`Cannot resolve expected color: ${expression}`);
      const absolute = computed(node, view, substituted);
      // Actual computed values and independently constructed expected mixes
      // pass through exactly the same conversion, with no role-specific math.
      return normalizeInDocument(absolute, element.ownerDocument);
    });
  }

  function parent(element) {
    return (
      element.assignedSlot ||
      element.parentElement ||
      element.getRootNode().host ||
      null
    );
  }

  function background(element) {
    if (!element?.isConnected || element.nodeType !== 1)
      throw new Error("Background resolution requires a connected element");
    let result = [0, 0, 0, 0];
    const view = element.ownerDocument.defaultView;
    for (let current = element; current; current = parent(current)) {
      const style = view.getComputedStyle(current);
      const label = current.localName;
      // Group opacity/filter/blending can alter descendants even after an
      // opaque inner background. Inspect these all the way to the root.
      if (
        style.opacity !== "1" ||
        (style.filter && style.filter !== "none") ||
        (style.backdropFilter && style.backdropFilter !== "none") ||
        (style.mixBlendMode && style.mixBlendMode !== "normal") ||
        (style.maskImage && style.maskImage !== "none")
      )
        throw new Error(
          `Unsupported opacity, filter, blend or mask on ${label}`,
        );
      if (style.display === "none" || style.visibility !== "visible")
        throw new Error(`Cannot measure contrast of hidden ${label}`);
      if (result[3] === 1 || style.display === "contents") continue;
      // Uniform color backgrounds only. Images/gradients can vary under each
      // glyph, even when a background-color is opaque. Do not assume white or
      // ignore an image. Outer images fully hidden by opaque layers are safe.
      if (style.backgroundImage !== "none")
        throw new Error(`Unsupported background image on ${label}`);
      if (
        style.backgroundClip.split(",").some((clip) => clip.trim() === "text")
      )
        throw new Error(`Unsupported text-clipped background on ${label}`);
      if (/\binset\b/.test(style.boxShadow))
        throw new Error(`Unsupported inset shadow on ${label}`);
      result = composite(
        result,
        normalizeInDocument(style.backgroundColor, element.ownerDocument),
      );
    }
    // Assumes the sampled text lies inside its ancestor backgrounds, with no
    // overlapping siblings, generated overlays or replaced image content.
    // The target's own badge background is included. Slots and shadow hosts are
    // walked as part of the flattened ancestry. A transparent document canvas
    // has no knowable color here (iframes/embedders/dark UA canvases differ).
    if (result[3] !== 1)
      throw new Error(
        "No opaque ancestor background; document canvas is unknown",
      );
    return result;
  }

  function contrast(element) {
    const bg = background(element);
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const foreground = normalizeInDocument(style.color, element.ownerDocument);
    if (
      style.webkitTextFillColor &&
      style.webkitTextFillColor !== style.color &&
      style.webkitTextFillColor !== "currentcolor"
    )
      throw new Error("A separate text-fill color is unsupported for contrast");
    const fg = composite(foreground, bg);
    // Keep the WCAG formula identical to host contrastRatio; this function must
    // remain serializable without references to any module-level helpers.
    const luminance = (color) => {
      const linear = color
        .slice(0, 3)
        .map((value) =>
          value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
        );
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const fgLuminance = luminance(fg);
    const bgLuminance = luminance(bg);
    return (
      (Math.max(fgLuminance, bgLuminance) + 0.05) /
      (Math.min(fgLuminance, bgLuminance) + 0.05)
    );
  }

  return { normalize, composite, background, contrast, resolve };
}
