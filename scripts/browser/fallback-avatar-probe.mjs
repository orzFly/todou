/**
 * In-page probe for scripts/fallback-avatar-smoke.mjs. Serialised through
 * `evaluate`, so it must not close over anything outside its own body.
 *
 * Every avatar of `shape` on the page whose fallback is showing is graded
 * where it stands, and then again with its box forced to each `sizes` entry:
 * the requirement is that the letters scale with the icon, so a glyph that
 * only fits at the size its surface happens to draw it has not met it. Each
 * fallback is then graded as the `generator` the account is set to.
 */
export async function probeFallbacks({
  shape,
  generator,
  sizes,
  minContrast,
  faults = {},
}) {
  const failures = [];
  const coverageErrors = [];
  const icons = [];
  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  await document.fonts.ready;
  if (!document.fonts.check('600 16px "Geist Variable"')) {
    coverageErrors.push("geist-not-loaded");
  }

  const avatars = [
    ...document.querySelectorAll(`[data-slot="avatar"][data-shape="${shape}"]`),
  ].filter((avatar) =>
    avatar.querySelector(':scope > [data-slot="avatar-fallback"]'),
  );
  const glyphs = () =>
    avatars.flatMap((avatar) => [
      ...avatar.querySelectorAll(
        '[data-slot="avatar-fallback"] [data-glyph-text]',
      ),
    ]);

  if (faults.unfit) {
    // A stylesheet rather than the element's own style: the glyph refits
    // whenever its box resizes, which the forced sizes below make it do.
    const style = document.createElement("style");
    style.textContent =
      "[data-generator] > :has(> [data-glyph-text]) { transform: none !important; }";
    document.head.append(style);
  }
  if (faults.lightTint) {
    for (const avatar of avatars) {
      for (const stop of avatar.querySelectorAll("stop")) {
        stop.setAttribute("stop-color", "#8ec9ff");
      }
    }
  }
  if (faults.driftOne) {
    for (const stop of avatars[0]?.querySelectorAll("stop") ?? []) {
      stop.setAttribute("stop-color", "#2f3a4f");
    }
  }
  if (faults.inheritCentre) {
    const style = document.createElement("style");
    style.textContent =
      "[data-generator] > :has(> [data-glyph-text]) { text-align: center !important; }";
    document.head.append(style);
  }
  if (faults.relabel) {
    for (const avatar of avatars) {
      avatar
        .querySelector("[data-generator]")
        ?.setAttribute("data-generator", "relabelled");
    }
  }
  if (faults.whiteText) {
    for (const text of glyphs()) text.style.color = "#fff";
  }
  await nextFrame();
  await nextFrame();

  const parseRgb = (value) => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const luminance = ([r, g, b]) => {
    const decode = (channel) => {
      const v = channel / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** A theme token as the browser resolves it right now. */
  const token = (name, property) => {
    const probe = document.createElement("span");
    probe.style.setProperty(property, `var(${name})`);
    document.body.append(probe);
    const value = getComputedStyle(probe).getPropertyValue(property);
    probe.remove();
    return value;
  };
  const muted = token("--muted", "background-color");
  const mutedForeground = token("--muted-foreground", "color");

  /**
   * The glyph's box: the text run itself, never its element, whose line is as
   * tall as the avatar by design and so would always touch both edges.
   */
  const glyphRect = (fallback) => {
    const range = document.createRange();
    range.selectNodeContents(
      fallback.querySelector("[data-glyph-text]") ?? fallback,
    );
    return range.getBoundingClientRect();
  };

  for (const avatar of avatars) {
    const fallback = avatar.querySelector(
      ':scope > [data-slot="avatar-fallback"]',
    );
    // A card or a breadcrumb links to its project; the settings editor sits
    // on that project's own page. People are keyed by what they draw.
    const href =
      avatar.closest("a[href^='/projects/']")?.getAttribute("href") ??
      location.pathname;
    const slug =
      shape === "square"
        ? (/^\/projects\/([^/?#]+)/.exec(href)?.[1] ?? null)
        : null;
    if (shape === "square" && !slug) {
      coverageErrors.push("icon-without-slug");
      continue;
    }
    const key = slug ?? fallback.textContent;
    const entry = {
      slug,
      key,
      glyph: fallback.textContent,
      generator:
        fallback
          .querySelector("[data-generator]")
          ?.getAttribute("data-generator") ?? null,
      drawnAt: avatar.getBoundingClientRect().width,
      sizes: [],
      tint: null,
      contrast: null,
    };

    const original = avatar.getAttribute("style");
    for (const size of [null, ...sizes]) {
      if (size !== null) {
        avatar.style.setProperty("width", `${size}px`, "important");
        avatar.style.setProperty("height", `${size}px`, "important");
        await nextFrame();
      }
      const box = avatar.getBoundingClientRect();
      if (size !== null && Math.abs(box.width - size) > 0.01) {
        coverageErrors.push("size-not-applied");
      }
      const glyph = glyphRect(fallback);
      if (glyph.width === 0) coverageErrors.push("glyph-not-drawn");
      const over = Math.max(
        box.left - glyph.left,
        glyph.right - box.right,
        box.top - glyph.top,
        glyph.bottom - box.bottom,
      );
      entry.sizes.push({
        size: size ?? box.width,
        glyph: [glyph.width, glyph.height].map((v) => +v.toFixed(2)),
        // Left, right, top, bottom: how far inside the box each edge sits.
        margins: [
          glyph.left - box.left,
          box.right - glyph.right,
          glyph.top - box.top,
          box.bottom - glyph.bottom,
        ].map((v) => +v.toFixed(2)),
        over: +over.toFixed(2),
      });
      if (over > 0.5) {
        failures.push({
          name: "glyph-outside-box",
          key,
          size: size ?? box.width,
          over: +over.toFixed(2),
          glyphRect: [
            glyph.left - box.left,
            glyph.top - box.top,
            glyph.width,
            glyph.height,
          ].map((v) => +v.toFixed(2)),
          fit:
            fallback.querySelector("[data-glyph-text]")?.parentElement?.style
              .transform ?? null,
        });
      }
      // Inside the box is not enough: a glyph pushed against one side by the
      // alignment it inherits still fits, and still looks wrong.
      const skew = Math.abs(glyph.left - box.left - (box.right - glyph.right));
      if (skew > 0.5) {
        failures.push({
          name: "glyph-off-centre",
          key,
          size: size ?? box.width,
          skew: +skew.toFixed(2),
        });
      }
    }
    if (original === null) avatar.removeAttribute("style");
    else avatar.setAttribute("style", original);

    if (entry.generator !== generator) {
      failures.push({
        name: "wrong-generator",
        key,
        expected: generator,
        seen: entry.generator,
      });
    }
    const stops = [...fallback.querySelectorAll("stop")].map((stop) =>
      parseRgb(getComputedStyle(stop).stopColor),
    );
    const text = fallback.querySelector("[data-glyph-text]");
    const fill = text ? getComputedStyle(text).color : null;
    if (generator === "colorful_text") {
      const rgb = fill ? parseRgb(fill) : null;
      if (stops.length !== 2 || stops.includes(null) || !rgb) {
        failures.push({ name: "no-tint", key });
      } else {
        entry.tint = stops.map((c) => c.join(","));
        entry.contrast = Math.min(...stops.map((c) => contrast(c, rgb)));
        if (entry.contrast < minContrast) {
          failures.push({
            name: "text-contrast-below-threshold",
            key,
            contrast: +entry.contrast.toFixed(2),
          });
        }
      }
    } else {
      // The pre-T-544 scheme: the theme's muted box under its muted text,
      // and nothing of the gradient left over.
      const background = getComputedStyle(fallback).backgroundColor;
      if (
        stops.length > 0 ||
        fallback.querySelector("svg rect") ||
        fill !== mutedForeground ||
        background !== muted
      ) {
        failures.push({
          name: "not-monochrome",
          key,
          stops: stops.length,
          fill,
          background,
          expected: { fill: mutedForeground, background: muted },
        });
      }
    }
    icons.push(entry);
  }
  if (icons.length === 0) coverageErrors.push(`no-${shape}-fallbacks`);
  return {
    theme: document.documentElement.dataset.theme ?? null,
    dark: document.documentElement.classList.contains("dark"),
    icons,
    failures,
    coverageErrors: [...new Set(coverageErrors)],
  };
}
