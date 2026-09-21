import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JumpRowBody } from "../src/components/search/jump-row.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * happy-dom lays no text out, so the allocation has nothing to read and the
 * component deliberately leaves the DOM alone. These doubles give it a
 * geometry simple enough to compute the expected widths by hand: every
 * character is 7px wide, the ellipsis included, and the row's content box is
 * whatever the case says it is.
 *
 * What they cannot stand in for is the thing the card is about — whether the
 * finished row fits its panel or its page. That is measured in Chromium by
 * scripts/search-wrap-smoke.mjs.
 */
const CHAR = 7;
function installGeometry(width: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-jump-row") ? width : 0;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: Array.from(text).length * CHAR }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
}

const SPELLED = "beta/B-29#comment-209";
const IDENTITY = { slug: "beta", prefix: "B", number: 29, commentId: 209 };

function renderRow(width: number | null) {
  if (width !== null) installGeometry(width);
  return render(
    <div>
      <JumpRowBody
        icon={<span data-testid="icon" />}
        spelled={SPELLED}
        identity={IDENTITY}
        text="A card that was found"
        author="Alice"
        trailing={<span data-testid="pill" />}
      />
    </div>,
  );
}

const block = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("[data-jump-row]") as HTMLElement;
const parts = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-jump-part]"),
];
const token = (root: HTMLElement) => parts(root)[0];
const credit = (root: HTMLElement) => parts(root).at(-1) as HTMLElement;
const heads = (scope: HTMLElement) =>
  [...scope.querySelectorAll<HTMLElement>("[style]")].map((element) =>
    Number.parseFloat(element.style.width),
  );

describe("a search row that leads with a ref token", () => {
  it("leaves a row it never had to elide exactly as it was written", () => {
    // 21 characters of ref and 5 of author against a 400px box: nothing is
    // under pressure, so nothing is rewritten and the token is one text node.
    const { container } = renderRow(400);
    const ref = token(container);
    expect(ref.childNodes).toHaveLength(1);
    expect(ref.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(ref.textContent).toBe(SPELLED);
    expect(heads(container)).toEqual([]);
    expect(credit(container).textContent).toBe("· by Alice");
  });

  it("does nothing at all where there is no text geometry to read", () => {
    const { container } = renderRow(null);
    expect(token(container).childNodes).toHaveLength(1);
    expect(heads(container)).toEqual([]);
  });

  it("elides the slug and the author in the middle, losing no character", () => {
    // 200px of box, 147px of which never shrinks — `/`, `-29`, `#comment-209`
    // and `· by `. The 53px left over goes to `beta` (28 full, 21 at its
    // narrowest) and `Alice` (35 full, 21) at a common 23px each.
    const { container } = renderRow(200);
    const ref = token(container);
    expect(ref.textContent).toBe(SPELLED);
    expect(ref.title).toBe(SPELLED);
    expect(credit(container).textContent).toBe("· by Alice");
    // The prefix is a single character and already at its minimum, so it is
    // not one of the two that gave width up.
    expect(heads(ref)).toHaveLength(1);
    expect(heads(ref)[0]).toBeCloseTo(23 - CHAR, 6);
    // The body contract forbids this one; a 390px search row cannot close
    // without it, which is the single deliberate divergence (T-446).
    expect(heads(credit(container))).toHaveLength(1);
    expect(heads(credit(container))[0]).toBeCloseTo(23 - CHAR, 6);
    expect(ref.className).not.toContain("wrap-anywhere");
    // Flex breaks lines by content width before anything shrinks, so a
    // standing `flex-wrap` would send the title to a row of its own the
    // moment it outgrew the space left — measured in Chromium, and the reason
    // wrapping is switched on by the allocator rather than left on.
    expect(block(container).className).not.toContain("flex-wrap");
  });

  it("wraps only once every run is down to a character each side", () => {
    // 147px immovable plus 49px of minima needs 196px; 150px cannot hold it.
    const { container } = renderRow(150);
    const ref = token(container);
    expect(ref.className).toContain("wrap-anywhere");
    expect(block(container).className).toContain("flex-wrap");
    expect(ref.textContent).toBe(SPELLED);
    expect(ref.title).toBe(SPELLED);
    expect(heads(ref)[0]).toBeCloseTo(21 - CHAR, 6);
    expect(heads(credit(container))[0]).toBeCloseTo(21 - CHAR, 6);
  });

  it("shrinks a token nobody can decompose, which is most of the rows", () => {
    // A project offer, an external link and a peeked card all spell something
    // todou never formatted. Leaving those rigid would fix the panel for one
    // row kind out of four.
    installGeometry(100);
    const typed = `${"a".repeat(40)}/`;
    const { container } = render(
      <div>
        <JumpRowBody
          icon={<span />}
          spelled={typed}
          identity={null}
          text="A project"
        />
      </div>,
    );
    const ref = token(container);
    expect(ref.textContent).toBe(typed);
    expect(ref.title).toBe(typed);
    expect(heads(ref)).toHaveLength(1);
    // 100px of budget is room for the 3/3 tier the body chip also has, so the
    // head stops 21px short and three characters survive on the other side.
    expect(heads(ref)[0]).toBeCloseTo(100 - 3 * CHAR, 6);
    expect(ref.lastElementChild?.lastElementChild?.textContent).toBe("aa/");
  });

  it("keeps the middle column as the one that yields first", () => {
    const { container } = renderRow(200);
    expect(parts(container)[1].className).toContain("truncate");
  });
});
