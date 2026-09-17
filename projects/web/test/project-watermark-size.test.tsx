import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefWatermark } from "../src/components/shared/ref-watermark.tsx";

/**
 * Ink boxes of the strings the mark draws, in em: `dLeft`/`dRight` measured
 * from the text's anchor, which `text-anchor="end"` puts at the advance end,
 * and `dTop`/`dBottom` from the baseline.
 *
 * Observations rather than derivations, and that is the whole point of them:
 * taken in Chrome from `TextMetrics.actualBoundingBox*` at 100px against the
 * running app, Geist Variable at weight 700 with `letter-spacing: -0.05em`.
 * Nothing here is computed from anything the component knows, so the criteria
 * below cannot come out true by restating it.
 *
 * `WWWWWW` is not a string the component draws. It is what a slice count
 * decoupled from the width allowance would draw, and the criterion about the
 * start of the REF needs its ink in order to fail with a number.
 */
const INK_EM = {
  CH: { dLeft: -1.3038, dRight: -0.021, dTop: -0.73, dBottom: 0.02 },
  ROS: { dLeft: -1.919, dRight: -0.001, dTop: -0.73, dBottom: 0.02 },
  REFR: { dLeft: -2.3332, dRight: 0.003, dTop: -0.71, dBottom: 0.01 },
  OBSE: { dLeft: -2.5464, dRight: 0.008, dTop: -0.73, dBottom: 0.02 },
  WWWW: { dLeft: -3.8, dRight: 0.015, dTop: -0.71, dBottom: 0.01 },
  MMMM: { dLeft: -3.348, dRight: -0.015, dTop: -0.71, dBottom: 0.01 },
  TTTT: { dLeft: -2.216, dRight: 0.041, dTop: -0.71, dBottom: 0.01 },
  REF_: { dLeft: -2.2112, dRight: 0.019, dTop: -0.71, dBottom: 0.12 },
  WWWWWW: { dLeft: -5.71, dRight: 0.015, dTop: -0.71, dBottom: 0.01 },
};

/**
 * Every card box the projects page produces, measured on it: the six widths
 * the grid resolves to between a 320px viewport and a 1920px one, and the
 * heights one, two and three lines of description come to.
 */
const CARD_PX = [288, 296, 320, 362.67, 487.5, 607];
const CARD_HEIGHT_PX = [96, 116, 136];

/** `left-3`, which the shape case below asserts literally. */
const LEFT_INSET = 12;

/**
 * How far past the corner the ink may run, in em of the resolved size. Not the
 * bleed plus slack: `_` is the one glyph in `[A-Z0-9_]` with a descender and
 * drops a further 0.12em, so a REF ending in it bleeds 0.18em rather than
 * 0.06em, and that case is what sets the bound.
 */
const BLEED_BOUND_EM = 0.2;

/**
 * Every prefix whose drawn string the frozen table covers, widest ink first.
 * The order carries weight: a run of `W`s is what binds the left edge, and
 * putting it first means a slice count that stopped following the allowance
 * fails with a coordinate rather than on the first string nobody measured.
 */
const PREFIXES = [
  "W".repeat(20),
  "CH",
  "ROS",
  "REFRACT",
  "OBSERVATORY",
  "MMMM",
  "TTTT",
  "REF_",
];

/**
 * Prefixes short enough that a *larger* allowance would not change what is
 * drawn, so a mutation of the allowance shows up as a changed size and not as
 * a string nobody has measured.
 */
const SHORT_PREFIXES = ["CH", "ROS", "MMMM", "TTTT", "REF_"];

function markFor(prefix: string): SVGSVGElement {
  const { container } = render(<RefWatermark prefix={prefix} />);
  return container.querySelector(
    '[data-slot="ref-watermark"]',
  ) as unknown as SVGSVGElement;
}

const allowanceOf = (svg: SVGSVGElement) =>
  Number((svg.getAttribute("viewBox") as string).split(/\s+/)[2]);

/**
 * Where the ink lands on a card of this size, in the card's own pixels with
 * its top-left at the origin.
 *
 * happy-dom lays nothing out, so every geometry here is arithmetic over the
 * attributes the component emitted — never over constants retyped from it,
 * which is how a criterion ends up measuring a value the component has
 * stopped using.
 */
function resolve(svg: SVGSVGElement, cardW: number, cardH: number) {
  const [, , vbW, vbH] = (svg.getAttribute("viewBox") as string)
    .split(/\s+/)
    .map(Number);
  const text = svg.querySelector("text") as SVGTextElement;
  const drawn = text.textContent as string;
  const ink = INK_EM[drawn as keyof typeof INK_EM];
  // A drawn string nobody has measured is itself a failure: the component has
  // started drawing something this file cannot say anything about.
  if (!ink) throw new Error(`no measured ink box for ${JSON.stringify(drawn)}`);
  // The bleed is read back off the rendered element too, as the gap between
  // the anchor and the viewBox corner.
  const bleedX = Number(text.getAttribute("x")) - vbW;
  const bleedY = Number(text.getAttribute("y")) - vbH;
  const scale = Math.min((cardW - LEFT_INSET) / vbW, cardH / vbH);
  // `xMaxYMax` lands the viewBox's bottom-right corner on the element's, which
  // `top-0 left-3 h-full w-[calc(100%-0.75rem)]` puts on the card's right and
  // bottom edges.
  const anchorX = cardW + bleedX * scale;
  const anchorY = cardH + bleedY * scale;
  return {
    drawn,
    scale,
    left: anchorX + ink.dLeft * scale,
    right: anchorX + ink.dRight * scale,
    top: anchorY + ink.dTop * scale,
    bottom: anchorY + ink.dBottom * scale,
  };
}

/**
 * Every prefix against every card box, resolved one at a time. A generator
 * rather than an array because building the whole list first would let an
 * unmeasured string further down the list throw before the widest one has been
 * asserted, and the widest one is what every edge criterion turns on.
 */
function* eachCase(prefixes: string[] = PREFIXES) {
  for (const prefix of prefixes) {
    for (const cardW of CARD_PX) {
      for (const cardH of CARD_HEIGHT_PX) {
        yield {
          prefix,
          cardW,
          cardH,
          where: `${prefix} on ${cardW}×${cardH}`,
          ...resolve(markFor(prefix), cardW, cardH),
        };
      }
    }
  }
}

describe("the shape of the mark the component emits", () => {
  it("is stretched over the card and clipped by nothing nearer than it", () => {
    const svg = markFor("REFRACT");
    // `h-full` and the explicit width because an <svg> is a replaced element
    // and would otherwise fall back to 300×150; `overflow-visible` because the
    // cut is meant to be the card's, not the mark's own.
    for (const className of [
      "absolute",
      "top-0",
      "left-3",
      "h-full",
      "w-[calc(100%-0.75rem)]",
      "overflow-visible",
      "z-0",
    ]) {
      expect(svg.getAttribute("class")).toContain(className);
    }
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMaxYMax meet");
    expect(svg.getAttribute("role")).toBe("img");
    const text = svg.querySelector("text");
    expect(text?.getAttribute("font-size")).toBe("1");
    expect(text?.getAttribute("text-anchor")).toBe("end");
  });

  it("holds one viewBox for every REF, which is what makes one size", () => {
    const boxes = PREFIXES.map((prefix) =>
      markFor(prefix).getAttribute("viewBox"),
    );
    expect([...new Set(boxes)]).toEqual(["0 0 4 0.73"]);
  });

  it("draws the allowance's worth of characters and labels the whole REF", () => {
    for (const prefix of PREFIXES) {
      const svg = markFor(prefix);
      // Read back rather than retyped: a slice count that stopped following
      // the allowance is the thing this is here to catch.
      const drawn = prefix.slice(0, allowanceOf(svg));
      expect(svg.querySelector("text")?.textContent, prefix).toBe(drawn);
      // Four characters are drawn; a screen reader still meets the REF whole,
      // because this is the only place on the card it appears.
      expect(svg.getAttribute("aria-label"), prefix).toBe(prefix);
    }
  });
});

describe("where the mark lands, against ink measured in a browser", () => {
  it("resolves to one size for every REF on a page of equal cards", () => {
    for (const cardW of CARD_PX) {
      for (const cardH of CARD_HEIGHT_PX) {
        const scales = PREFIXES.map(
          (prefix) => resolve(markFor(prefix), cardW, cardH).scale,
        );
        expect([...new Set(scales)], `${cardW}×${cardH}`).toHaveLength(1);
      }
    }
  });

  it("keeps the start of the REF on the card", () => {
    for (const c of eachCase()) {
      expect(c.left, c.where).toBeGreaterThanOrEqual(0);
    }
  });

  it("runs the ink past the right and bottom edges, and not far past", () => {
    for (const c of eachCase()) {
      expect(c.right, c.where).toBeGreaterThan(c.cardW);
      expect(c.bottom, c.where).toBeGreaterThan(c.cardH);
      expect(c.right - c.cardW, c.where).toBeLessThanOrEqual(
        BLEED_BOUND_EM * c.scale,
      );
      expect(c.bottom - c.cardH, c.where).toBeLessThanOrEqual(
        BLEED_BOUND_EM * c.scale,
      );
    }
  });

  it("never runs off the top, which is what the cap ratio is for", () => {
    // Asserted on the ink's top edge and not on its height: a REF ending in
    // `_` is legitimately taller than a short card, because the extra lands in
    // the bleed below.
    for (const c of eachCase()) {
      expect(c.top, c.where).toBeGreaterThanOrEqual(0);
    }
  });

  it("fills the card rather than retreating from it", () => {
    const smallest = (cardW: number, cardH: number) =>
      Math.min(
        ...SHORT_PREFIXES.map((prefix) => {
          const r = resolve(markFor(prefix), cardW, cardH);
          return (r.bottom - r.top) / cardH;
        }),
      );
    // The width allowance binds here — the card the defect was reported on.
    expect(smallest(362.67, 96)).toBeGreaterThanOrEqual(0.5);
    // And the height ceiling here, where the mark comes out as tall as its
    // card. Against the 17px of ink this geometry used to draw for `REFRACT`.
    expect(smallest(607, 96)).toBeGreaterThanOrEqual(0.9);
  });
});
