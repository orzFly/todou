import { afterEach, describe, expect, it } from "vitest";
import {
  markChangedLabels,
  surplusLabels,
} from "../src/lib/mermaid-label-diff.ts";

describe("surplusLabels (T-724)", () => {
  it("marks nothing when both sides hold the same labels", () => {
    expect(surplusLabels(["a", "b"], ["b", "a"])).toEqual({
      before: [false, false],
      after: [false, false],
    });
  });

  it("marks a renamed label on both sides", () => {
    expect(surplusLabels(["approve"], ["accept"])).toEqual({
      before: [true],
      after: [true],
    });
  });

  it("marks only the label the new side added", () => {
    expect(surplusLabels(["a"], ["a", "b"])).toEqual({
      before: [false],
      after: [false, true],
    });
  });

  it("pairs repeated labels one to one", () => {
    expect(surplusLabels(["A", "A"], ["A"])).toEqual({
      before: [false, true],
      after: [false],
    });
  });
});

const svg = (node: string, edge: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">` +
  `<g class="node" id="n"><rect></rect><foreignObject><div>${node}</div></foreignObject></g>` +
  `<text transform="translate(5, 6)">  ${edge}\n </text>` +
  `<text>same</text></svg>`;

// happy-dom answers getBBox() with an empty box, so each case installs the
// box it needs, or a getBBox that throws as a browser does on a detached tree.
describe("markChangedLabels (T-724)", () => {
  const proto = SVGGraphicsElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "getBBox");

  afterEach(() => {
    if (original) Object.defineProperty(proto, "getBBox", original);
  });

  function stubBBox(value: () => unknown) {
    Object.defineProperty(proto, "getBBox", { configurable: true, value });
  }

  function parse(markup: string): Element {
    const div = document.createElement("div");
    div.innerHTML = markup;
    return div;
  }

  it("boxes only the unpaired labels, a node's label on its node", () => {
    stubBBox(() => ({ x: 10, y: 20, width: 30, height: 40 }));
    const out = markChangedLabels(svg("old", "same edge"), svg("new", "edge"));
    const before = parse(out.before);
    const after = parse(out.after);

    const node = before.querySelector("g.node");
    expect(node?.lastElementChild?.getAttribute("data-change")).toBe("removed");
    expect(node?.lastElementChild?.getAttribute("x")).toBe("8");
    expect(after.querySelector("g.node")?.lastElementChild?.tagName).toBe(
      "rect",
    );
    expect(
      after
        .querySelector("g.node > rect:last-child")
        ?.getAttribute("data-change"),
    ).toBe("added");

    const edge = after.querySelector("svg > rect[data-change]");
    expect(edge?.previousElementSibling?.textContent).toContain("edge");
    expect(edge?.getAttribute("transform")).toBe("translate(5, 6)");
    expect(edge?.getAttribute("x")).toBe("7");
    expect(edge?.getAttribute("style")).toContain("var(--diff-addition)");

    // "same" is on both sides, so only the node and the edge label are boxed.
    expect(before.querySelectorAll("[data-change]")).toHaveLength(2);
    expect(after.querySelectorAll("[data-change]")).toHaveLength(2);
  });

  it("leaves both renders alone when nothing can be measured", () => {
    stubBBox(() => {
      throw new TypeError("getBBox is not a function");
    });
    const before = svg("old", "a");
    const after = svg("new", "b");
    expect(markChangedLabels(before, after)).toEqual({ before, after });
  });

  it("takes its measuring host down again", () => {
    stubBBox(() => ({ x: 0, y: 0, width: 1, height: 1 }));
    const childCount = document.body.childElementCount;
    markChangedLabels(svg("old", "a"), svg("new", "b"));
    expect(document.body.childElementCount).toBe(childCount);
  });
});
