import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommentReference,
  type CommentReferenceProps,
} from "../src/components/shared/comment-reference.tsx";
import {
  allocateCommentRef,
  splitCommentIssueRef,
} from "../src/lib/comment-ref-layout.ts";

const props: CommentReferenceProps = {
  spelled: "beta/B-29",
  slug: "beta",
  prefix: "B",
  number: 29,
  commentId: 209,
  title: "Moved parent",
  refLeads: true,
  inBody: true,
  capTitle: true,
  author: "Alice",
  current: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("comment reference allocation in measured CSS pixels", () => {
  it("equally budgets two long segments with different intrinsic widths", () => {
    const result = allocateCommentRef(240, 80, [
      { full: 360, minimum: 30 },
      { full: 220, minimum: 24 },
    ]);
    expect(result.wrap).toBe(false);
    expect(result.widths[0]).toBeCloseTo(80);
    expect(result.widths[1]).toBeCloseTo(80);
  });

  it("returns a short segment's unused half to the long segment", () => {
    const result = allocateCommentRef(240, 80, [
      { full: 20, minimum: 20 },
      { full: 300, minimum: 24 },
    ]);
    expect(result.wrap).toBe(false);
    expect(result.widths[0]).toBe(20);
    expect(result.widths[1]).toBeCloseTo(140);
  });

  it("uses proportional widths even when both segments have the same character count", () => {
    // Eight narrow i glyphs and eight wide W glyphs must not get eight-char budgets.
    const result = allocateCommentRef(110, 30, [
      { full: 16, minimum: 11 },
      { full: 96, minimum: 31 },
    ]);
    expect(result.widths[0]).toBe(16);
    expect(result.widths[1]).toBeCloseTo(64);
  });

  it("keeps both 1/1 minima on one line at the exact threshold", () => {
    const metrics = [
      { full: 180, minimum: 31 },
      { full: 180, minimum: 11 },
    ];
    const fits = allocateCommentRef(122, 80, metrics);
    expect(fits.wrap).toBe(false);
    expect(fits.widths[0]).toBeCloseTo(31);
    expect(fits.widths[1]).toBeCloseTo(11);
    const wraps = allocateCommentRef(121.5, 80, metrics);
    expect(wraps).toEqual({ widths: [31, 11], wrap: true });
  });

  it("restores both original segments when the parent grows", () => {
    const metrics = [
      { full: 130, minimum: 30 },
      { full: 110, minimum: 20 },
    ];
    expect(allocateCommentRef(400, 80, metrics)).toEqual({
      widths: [130, 110],
      wrap: false,
    });
    expect(allocateCommentRef(60, 80, []).wrap).toBe(true);
  });
});

describe("lossless issue spelling decomposition", () => {
  it.each([
    ["beta/B-29", "beta", "B", 29],
    ["beta#29", "beta", null, 29],
    ["B-29", "beta", "B", 29],
    ["#29", "beta", null, 29],
    ["unrecognized-original", "beta", "B", 29],
  ] as const)(
    "keeps every original character of %s",
    (spelled, slug, prefix, number) => {
      expect(
        splitCommentIssueRef(spelled, slug, prefix, number)
          .map(({ text }) => text)
          .join(""),
      ).toBe(spelled);
    },
  );

  it("only identifies slug and prefix as shrinkable", () => {
    expect(splitCommentIssueRef("beta/B-29", "beta", "B", 29)).toEqual([
      { kind: "slug", text: "beta" },
      { kind: "fixed", text: "/" },
      { kind: "prefix", text: "B" },
      { kind: "fixed", text: "-29" },
    ]);
  });
});

describe("comment reference renderer structure", () => {
  it.each([
    [
      true,
      false,
      "Moved parent",
      "beta/B-29 Moved parent · #comment-209 by Alice",
    ],
    [
      false,
      false,
      "Moved parent",
      "Moved parent · beta/B-29#comment-209 by Alice",
    ],
    [true, false, null, "beta/B-29#comment-209 by Alice"],
    [false, false, null, "beta/B-29#comment-209 by Alice"],
    [true, true, "Moved parent", "#comment-209 by Alice"],
    [false, true, "Moved parent", "#comment-209 by Alice"],
    [true, true, null, "#comment-209 by Alice"],
    [false, true, null, "#comment-209 by Alice"],
  ] as const)(
    "renders placement=%s current=%s title=%s",
    (refLeads, current, title, expected) => {
      const { container } = render(
        <CommentReference
          {...props}
          refLeads={refLeads}
          current={current}
          title={title}
        />,
      );
      expect(container.textContent).toBe(expected);
      const scope = container.querySelector("[data-comment-ref]");
      expect(scope).not.toBeNull();
      expect(
        Array.from(scope?.querySelectorAll("[data-ref-part]") ?? [])
          .map((part) => part.textContent)
          .join(""),
      ).toBe(current ? "#comment-209" : "beta/B-29#comment-209");
      expect(scope?.querySelector("[data-comment-author]")).toBeNull();
      expect(
        container.querySelector("[data-comment-author]")?.textContent,
      ).toBe(" by Alice");
      expect(
        scope?.querySelector("[data-comment-title]")?.textContent ?? null,
      ).toBe(current ? null : title);
      expect(container.querySelector("a, br")).toBeNull();
      expect(container.textContent).not.toMatch(/[\u200b\u00ad…]/);
    },
  );

  it("keeps non-body references outside every body selection and layout rule", () => {
    const { container } = render(
      <CommentReference {...props} inBody={false} />,
    );
    expect(container.querySelector(".comment-reference-body")).toBeNull();
    expect(
      container.querySelector("[style], .truncate, [data-comment-wrap]"),
    ).toBeNull();
    expect(container.textContent).toBe(
      "beta/B-29 Moved parent · #comment-209 by Alice",
    );
  });

  it("preserves title cap preference and an unabridged author outside the scope", () => {
    const author = "An author whose complete display name must remain readable";
    const view = render(<CommentReference {...props} author={author} />);
    expect(
      view.container.querySelector("[data-comment-title]")?.className,
    ).toContain("max-w-[24em]");
    view.rerender(
      <CommentReference {...props} capTitle={false} author={author} />,
    );
    expect(
      view.container.querySelector("[data-comment-title]")?.className,
    ).not.toContain("max-w-[24em]");
    expect(
      view.container.querySelector("[data-comment-author]")?.textContent,
    ).toBe(` by ${author}`);
  });
});

/**
 * Deliberate geometry doubles test the measurement/allocation connection.
 * happy-dom cannot establish browser drag-selection, native plain/HTML copy,
 * line boxes, clipping or scroll overflow. Those require Main's browser pass.
 */
function installGeometry(initialWidth: number) {
  let width = initialWidth;
  const observers: Array<{
    callback: ResizeObserverCallback;
    targets: Element[];
  }> = [];
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      if (this.hasAttribute("data-outer-container")) return 900;
      return this.hasAttribute("data-layout-container") ? width : 0;
    },
  );
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
    this: Range,
  ) {
    const text = (this.startContainer.textContent ?? "").slice(
      this.startOffset,
      this.endOffset,
    );
    const measured = Array.from(text).reduce(
      (sum, char) => sum + (char === "W" ? 12 : char === "i" ? 2 : 7),
      0,
    );
    return [{ width: measured }] as unknown as DOMRectList;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({
      width: Array.from(text).reduce(
        (sum, char) => sum + (char === "W" ? 12 : char === "i" ? 2 : 7),
        0,
      ),
    }),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      disconnect() {
        this.entry.targets = [];
      }
      unobserve() {}
    },
  );
  return {
    observers,
    resize(nextWidth: number) {
      width = nextWidth;
      act(() => {
        for (const { callback } of observers)
          callback([], {} as ResizeObserver);
      });
    },
  };
}

describe("parent container measurement and resize", () => {
  const longProps = {
    ...props,
    slug: "WWWWWWWWWWWW",
    prefix: "WWWWWWWWWWWW",
    spelled: "WWWWWWWWWWWW/WWWWWWWWWWWW-29",
    title: null,
  };

  it("allocates equally, reaches 1/1, wraps only below that, then restores full text", () => {
    const geometry = installGeometry(260);
    const view = render(
      <div
        data-layout-container
        style={{ display: "block", padding: "0 10px", border: "3px solid" }}
      >
        <a href="#comment-209" className="comment-link-body">
          <CommentReference {...longProps} />
        </a>
      </div>,
    );
    const scope = view.container.querySelector("[data-comment-ref]");
    const segments = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-comment-segment]"),
    );
    // clientWidth already excludes borders; only 20px of padding is removed.
    // fixed '/' + '-29' + '#comment-209' = 112px, remaining 128px -> 64px each.
    for (const segment of segments) {
      const head = segment.querySelector<HTMLElement>(
        ".comment-reference-head",
      );
      expect(Number.parseFloat(head?.style.width ?? "")).toBeCloseTo(52);
      expect(segment.getAttribute("data-comment-clipped")).toBe("true");
    }
    expect(scope?.hasAttribute("data-comment-wrap")).toBe(false);
    expect(geometry.observers[0].targets).toContain(
      view.container.firstElementChild,
    );
    geometry.resize(194); // content 174 = fixed 112 + two 31px minima.
    expect(scope?.hasAttribute("data-comment-wrap")).toBe(false);
    for (const segment of segments) {
      expect(segment.lastElementChild?.textContent).toBe("W");
      expect(
        Number.parseFloat(
          (segment.firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(19);
    }
    geometry.resize(193);
    expect(scope?.hasAttribute("data-comment-wrap")).toBe(true);
    expect(
      Array.from(scope?.querySelectorAll("[data-ref-part]") ?? [])
        .map((part) => part.textContent)
        .join(""),
    ).toBe(`${longProps.spelled}#comment-209`);
    geometry.resize(700);
    expect(scope?.hasAttribute("data-comment-wrap")).toBe(false);
    expect(view.container.querySelector("[data-comment-clipped]")).toBeNull();
    for (const head of view.container.querySelectorAll<HTMLElement>(
      ".comment-reference-head",
    )) {
      expect(head.style.width).toBe("");
    }
    view.unmount();
    expect(
      geometry.observers.every(({ targets }) => targets.length === 0),
    ).toBe(true);
  });

  it.each([0, 9])(
    "charges the cloned end edge once with a %ipx flow gutter",
    (gutter) => {
      installGeometry(260);
      const { container } = render(
        <div
          data-layout-container
          style={{
            display: "block",
            padding: `0 ${10 + gutter}px 0 10px`,
            ...{ "--ref-chip-gutter": `${gutter}px` },
          }}
        >
          <a
            href="#comment-209"
            className="comment-link-body"
            style={{ padding: "0 8px 0 2px", border: "1px solid" }}
          >
            <CommentReference
              {...props}
              slug="WWWWWWWWWWWW"
              prefix="WWWWWWWWWWWW"
              spelled="WWWWWWWWWWWW/WWWWWWWWWWWW-29"
            />
          </a>
        </div>,
      );
      // 240 of content, less the chip's own 12px box, less its 9px end edge.
      // Charging the 3px opening edge instead reads 225, so asymmetric padding
      // distinguishes the direction as well as detecting a missing reservation.
      expect(
        container.querySelector<HTMLElement>("[data-comment-title]")?.style
          .maxWidth,
      ).toBe("min(24em, 219px)");
      // fixed '/' + '-29' + '#comment-209' = 112px, so 53.5px a segment, less
      // the 12px tail glyph each keeps.
      for (const head of container.querySelectorAll<HTMLElement>(
        ".comment-reference-head",
      )) {
        expect(Number.parseFloat(head.style.width)).toBeCloseTo(41.5);
      }
    },
  );

  it("keeps equal budgets through repeated 1/3 tail changes despite clipped Range fragments", () => {
    const geometry = installGeometry(260);
    // Chromium may return a second visual fragment for a clipped Range.
    // Segment measurements must be independent of the old clipping state.
    const rangeRects = vi
      .mocked(Range.prototype.getClientRects)
      .getMockImplementation();
    if (!rangeRects) throw new Error("Expected the geometry Range double");
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range,
    ) {
      const rects = rangeRects.call(this);
      if (
        this.startContainer.parentElement?.closest("[data-comment-clipped]")
      ) {
        return [...Array.from(rects), { width: 24 }] as unknown as DOMRectList;
      }
      return rects;
    });
    const mixedProps = {
      ...longProps,
      prefix: "WWWWWWWWWWWi",
      spelled: "WWWWWWWWWWWW/WWWWWWWWWWWi-29",
    };
    const { container } = render(
      <div
        data-layout-container
        style={{ display: "block", padding: "0 10px" }}
      >
        <CommentReference {...mixedProps} />
      </div>,
    );
    const segments = Array.from(
      container.querySelectorAll<HTMLElement>("[data-comment-segment]"),
    );
    for (let round = 0; round < 3; round++) {
      // The first iteration remeasures the already-clipped initial render.
      // This is the path a full-width -> narrow-only fixture never exercises.
      geometry.resize(260);
      expect(segments[0].lastElementChild?.textContent).toBe("W");
      expect(segments[1].lastElementChild?.textContent).toBe("i");
      expect(
        Number.parseFloat(
          (segments[0].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(52);
      expect(
        Number.parseFloat(
          (segments[1].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(62);
      expect(
        segments.every((segment) =>
          segment.hasAttribute("data-comment-clipped"),
        ),
      ).toBe(true);

      // Both remain clipped, but now have space for different-width 3-char tails.
      geometry.resize(300);
      expect(segments[0].lastElementChild?.textContent).toBe("WWW");
      expect(segments[1].lastElementChild?.textContent).toBe("WWi");
      expect(
        Number.parseFloat(
          (segments[0].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(48);
      expect(
        Number.parseFloat(
          (segments[1].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(58);
      expect(
        segments.every((segment) =>
          segment.hasAttribute("data-comment-clipped"),
        ),
      ).toBe(true);
      geometry.resize(260);
      expect(segments[0].lastElementChild?.textContent).toBe("W");
      expect(segments[1].lastElementChild?.textContent).toBe("i");
      expect(
        Number.parseFloat(
          (segments[0].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(52);
      expect(
        Number.parseFloat(
          (segments[1].firstElementChild as HTMLElement).style.width,
        ),
      ).toBeCloseTo(62);
      geometry.resize(700);
      expect(container.querySelector("[data-comment-clipped]")).toBeNull();
      geometry.resize(260);
    }
    expect(container.textContent).toBe(
      `${mixedProps.spelled}#comment-209 by Alice`,
    );
  });

  it("measures proportional glyphs and returns the narrow segment's unused width", () => {
    installGeometry(200);
    const { container } = render(
      <div data-layout-container style={{ display: "block" }}>
        <CommentReference
          {...longProps}
          slug="iiiiiiiiiiii"
          spelled="iiiiiiiiiiii/WWWWWWWWWWWW-29"
        />
      </div>,
    );
    const slug = container.querySelector('[data-comment-segment="slug"]');
    const prefix = container.querySelector('[data-comment-segment="prefix"]');
    expect(slug?.hasAttribute("data-comment-clipped")).toBe(false);
    // 200 - fixed 112 - twelve i glyphs at 2px = 64px for the wide prefix.
    expect(
      Number.parseFloat(
        prefix?.querySelector<HTMLElement>(".comment-reference-head")?.style
          .width ?? "",
      ),
    ).toBeCloseTo(52);
    expect(container.textContent).toBe(
      "iiiiiiiiiiii/WWWWWWWWWWWW-29#comment-209 by Alice",
    );
  });

  it("observes the nearest initially hidden block and measures it when revealed", () => {
    const geometry = installGeometry(0);
    const view = render(
      <div data-outer-container style={{ display: "block", width: 900 }}>
        <details>
          <summary>Details</summary>
          <p
            data-layout-container
            style={{ display: "block", padding: "0 10px" }}
          >
            <a href="#comment-209" className="comment-link-body">
              <CommentReference {...longProps} />
            </a>
          </p>
        </details>
      </div>,
    );
    const paragraph = view.container.querySelector("p");
    expect(geometry.observers[0].targets).toEqual([paragraph]);
    expect(
      view.container.querySelector(
        "[data-comment-clipped], [data-comment-wrap]",
      ),
    ).toBeNull();
    act(() => {
      view.container.querySelector("details")?.setAttribute("open", "");
    });
    geometry.resize(260);
    for (const head of view.container.querySelectorAll<HTMLElement>(
      ".comment-reference-head",
    )) {
      expect(Number.parseFloat(head.style.width)).toBeCloseTo(52);
    }
    expect(geometry.observers[0].targets).toEqual([paragraph]);
    geometry.resize(193);
    expect(view.container.querySelector("[data-comment-wrap]")).not.toBeNull();
  });

  it("does not measure or allocate non-body references even in a narrow parent", () => {
    const geometry = installGeometry(40);
    const { container } = render(
      <div data-layout-container style={{ display: "block" }}>
        <CommentReference {...longProps} inBody={false} />
      </div>,
    );
    expect(geometry.observers).toHaveLength(0);
    expect(
      container.querySelector(
        "[data-comment-wrap], [data-comment-clipped], .comment-reference-head[style]",
      ),
    ).toBeNull();
    expect(container.textContent).toBe(
      `${longProps.spelled}#comment-209 by Alice`,
    );
  });
});
