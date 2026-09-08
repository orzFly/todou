import { render } from "@testing-library/react";
import { createElement, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockFor,
  restingScrollY,
  usableViewport,
  useScrollInsets,
} from "../src/lib/scroll-insets.ts";
import { currentIndex } from "../src/lib/spec-change-nav.ts";

// The overlays measured on a 1280×800 screen: shell header 57, floating title
// bar 40, comment composer 93 collapsed — 129, 167 and 385 as a draft grows.
const USABLE = { top: 97, height: 610 };

const CASES: [
  label: string,
  block: { top: number; height: number },
  mode: "auto" | "start" | undefined,
  block_: ScrollLogicalPosition,
  resting: number,
][] = [
  // Centre of the block (1000 + 40) onto centre of the strip (97 + 305).
  [
    "a block shorter than the strip",
    { top: 1000, height: 80 },
    "auto",
    "center",
    638,
  ],
  // Exactly as tall as the strip still centres — `<=`, so the one block that
  // fills the strip perfectly is not thrown to the other branch.
  [
    "a block exactly as tall as the strip",
    { top: 1000, height: 610 },
    "auto",
    "center",
    903,
  ],
  // Top of the block onto top of the strip: 1000 − 97.
  [
    "a block taller than the strip",
    { top: 1000, height: 611 },
    "auto",
    "start",
    903,
  ],
  [
    "a tall block under an explicit start",
    { top: 1000, height: 80 },
    "start",
    "start",
    903,
  ],
  ["no mode given at all", { top: 1000, height: 80 }, undefined, "center", 638],
];

describe("reveal geometry (T-299)", () => {
  for (const [label, block, mode, expectedBlock, resting] of CASES) {
    it(`lands ${label}`, () => {
      expect(blockFor(block, USABLE, mode)).toBe(expectedBlock);
      expect(restingScrollY(block, USABLE, mode)).toBe(resting);
    });
  }

  it.each([0, -120])(
    "tops-aligns rather than centring when the overlays leave %d px",
    (height) => {
      const usable = { top: 97, height };
      const block = { top: 1000, height: 80 };
      expect(blockFor(block, usable)).toBe("start");
      expect(restingScrollY(block, usable)).toBe(903);
    },
  );
});

describe("the landing and the counter agree (T-299)", () => {
  // One taller than the strip, so both branches of the mode are in play.
  const BLOCKS = [
    { top: 200, height: 90 },
    { top: 600, height: 1400 },
    { top: 2400, height: 120 },
    { top: 3000, height: 300 },
  ];

  it("names the stop it just landed on", () => {
    const positions = BLOCKS.map((b) => restingScrollY(b, USABLE));
    // Ascending, or ↑↓ would step in the wrong direction: the top-aligned
    // tall block rests above where the next block can come to rest.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const [i, pivot] of positions.entries()) {
      expect(currentIndex({ positions, pivot })).toBe(i + 1);
    }
  });
});

describe("usableViewport (T-299)", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("scroll-padding-top");
    document.documentElement.style.removeProperty("scroll-padding-bottom");
  });

  it("reads the strip back off <html>", () => {
    document.documentElement.style.scrollPaddingTop = "97px";
    document.documentElement.style.scrollPaddingBottom = "129px";
    expect(usableViewport()).toEqual({
      top: 97,
      height: window.innerHeight - 226,
    });
  });

  it("treats an unset scroll-padding as no overlay", () => {
    expect(usableViewport()).toEqual({
      top: 0,
      height: window.innerHeight,
    });
  });
});

/**
 * happy-dom answers 0 from every `getBoundingClientRect()`, so heights only
 * reach the hook when the element carries one. `data-h` puts each test's
 * numbers in the markup instead of in a lookup table beside it.
 */
function stubHeights() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const height = Number((this as HTMLElement).dataset?.h ?? 0);
      return { height, width: 0, top: 0, left: 0 } as DOMRect;
    },
  );
}

function Harness({ composer }: { composer: "mounted" | "absent" }) {
  const bar = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useScrollInsets({ top: [bar], bottom: [composerRef] });
  return createElement(
    "div",
    null,
    createElement("div", { ref: bar, "data-h": "40" }),
    composer === "mounted"
      ? createElement("div", { ref: composerRef, "data-h": "93" })
      : null,
  );
}

const insets = () => ({
  top: document.documentElement.style.scrollPaddingTop,
  bottom: document.documentElement.style.scrollPaddingBottom,
});

describe("useScrollInsets (T-299)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const header of document.querySelectorAll("header")) header.remove();
  });

  it("sums the shell header, the page's own overlays and a breathing gap", () => {
    const header = document.createElement("header");
    header.dataset.h = "57";
    document.body.append(header);
    stubHeights();

    const view = render(createElement(Harness, { composer: "mounted" }));
    expect(insets()).toEqual({ top: "105px", bottom: "93px" });

    view.unmount();
    expect(insets()).toEqual({ top: "", bottom: "" });
  });

  it("counts a ref pointing at nothing as no overlay", () => {
    stubHeights();
    // A trashed card renders no composer at all, and a fallback height would
    // reserve a strip for an overlay that is not there.
    render(createElement(Harness, { composer: "absent" }));
    expect(insets()).toEqual({ top: "48px", bottom: "0px" });
  });
});
