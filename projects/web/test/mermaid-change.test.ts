import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  colourChanges,
  MAX_CHANGED,
  surplusLabels,
} from "../src/lib/mermaid-change.ts";
import flowNewRaw from "./fixtures/mermaid/flow-new.svg?raw";
import flowOldRaw from "./fixtures/mermaid/flow-old.svg?raw";
import seqEditRaw from "./fixtures/mermaid/seq-edit.svg?raw";
import seqNewRaw from "./fixtures/mermaid/seq-new.svg?raw";
import seqOldRaw from "./fixtures/mermaid/seq-old.svg?raw";

// happy-dom's parser stops at mermaid's <style> and drops everything after
// it; the sheet only colours, and nothing here reads colour off it.
const unstyled = (svg: string) => svg.replace(/<style>[\s\S]*?<\/style>/, "");
const flowNew = unstyled(flowNewRaw);
const flowOld = unstyled(flowOldRaw);
const seqEdit = unstyled(seqEditRaw);
const seqNew = unstyled(seqNewRaw);
const seqOld = unstyled(seqOldRaw);

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

// happy-dom answers getBBox() with an empty box, so each case installs the
// box it needs, or a getBBox that throws as a browser does on a detached tree.
const proto = SVGGraphicsElement.prototype;
const original = Object.getOwnPropertyDescriptor(proto, "getBBox");

function stubBBox(value: () => unknown) {
  Object.defineProperty(proto, "getBBox", { configurable: true, value });
}

afterEach(() => {
  if (original) Object.defineProperty(proto, "getBBox", original);
});

function parse(markup: string): SVGSVGElement {
  const div = document.createElement("div");
  div.innerHTML = markup;
  const svg = div.querySelector("svg");
  if (svg === null) throw new Error("no svg");
  return svg;
}

const changed = (svg: Element, selector = "[data-change]") =>
  [...svg.querySelectorAll(selector)].map((el) => el.textContent?.trim());

/** The fixture with one attribute value swapped, as a hand edit of mermaid's output. */
function edit(svg: string, from: string, to: string): string {
  expect(svg).toContain(from);
  return svg.replace(from, to);
}

describe("colourChanges: sequence diagrams (T-773)", () => {
  beforeEach(() => stubBBox(() => ({ x: 10, y: 100, width: 30, height: 20 })));

  it("colours a renamed participant without its messages, and the rewritten and new messages", () => {
    const out = colourChanges(seqOld, seqEdit);
    const before = parse(out.before);
    const after = parse(out.after);

    // Participant B, renamed: both its boxes and both its names.
    expect(
      [...before.querySelectorAll("rect.actor[data-change]")].map((r) =>
        r.getAttribute("name"),
      ),
    ).toEqual(["B", "B"]);
    expect(changed(before, "text.actor[data-change]")).toEqual([
      "bump (ci 建)",
      "bump (ci 建)",
    ]);
    expect(changed(after, "text.actor[data-change]")).toEqual([
      "bump 作业",
      "bump 作业",
    ]);
    expect(
      [...before.querySelectorAll("rect.actor[data-change]")].every(
        (r) => r.getAttribute("data-change") === "removed",
      ),
    ).toBe(true);

    expect(changed(before, "text.messageText[data-change]")).toEqual([
      "nix-check: 每个 profile unchanged",
    ]);
    expect(changed(after, "text.messageText[data-change]")).toEqual([
      "nix-check: 每个 profile 都 unchanged?",
      "回报 impact 结果",
    ]);
    // Every message to or from B kept its text, so none is coloured.
    for (const svg of [before, after]) {
      const toB = svg.querySelectorAll(
        '[data-et="message"][data-to="B"], [data-et="message"][data-from="B"]',
      );
      expect(toB.length).toBeGreaterThan(0);
      for (const line of toB)
        expect(line.hasAttribute("data-change")).toBe(false);
    }

    // Lines go with their text; a band under each coloured message.
    expect(
      before.querySelectorAll('[data-et="message"][data-change]'),
    ).toHaveLength(1);
    expect(
      after.querySelectorAll('[data-et="message"][data-change]'),
    ).toHaveLength(2);
    expect(before.querySelectorAll("[data-band]")).toHaveLength(1);
    expect(after.querySelectorAll("[data-band]")).toHaveLength(2);
    const band = after.querySelector("[data-band]");
    expect(band?.getAttribute("x")).toBe("-50");
    expect(band?.getAttribute("width")).toBe("1042.5");
    expect(band?.getAttribute("y")).toBe("95");
    expect(band?.getAttribute("height")).toBe("32");
    expect(after.firstElementChild?.hasAttribute("data-band")).toBe(true);

    // One green arrowhead, shared by both new lines.
    expect(
      after.querySelectorAll('marker[id$="-arrowhead-added"]'),
    ).toHaveLength(1);
    for (const line of after.querySelectorAll(
      '[data-et="message"][data-change]',
    ))
      expect(line.getAttribute("marker-end")).toBe(
        "url(#mlseqEdit-arrowhead-added)",
      );
    expect(
      after
        .querySelector('marker[id$="-arrowhead-added"] path')
        ?.getAttribute("style"),
    ).toContain("var(--diff-addition)");
  });

  it("colours a message whose text stayed but whose receiver changed", () => {
    // The first message, U → G "patchset N", now goes to B.
    const moved = edit(
      seqEdit,
      'data-from="U" data-to="G"',
      'data-from="U" data-to="B"',
    );
    const after = parse(colourChanges(seqOld, moved).after);
    expect(changed(after, "text.messageText[data-change]")).toContain(
      "patchset N",
    );
  });

  it("falls back to boxes when texts and lines do not pair up", () => {
    const missing = seqEdit.replace(
      /<line[^>]*data-et="message"[^>]*>(<\/line>)?/,
      "",
    );
    const after = parse(colourChanges(seqOld, missing).after);
    expect(after.querySelectorAll("[data-band]")).toHaveLength(0);
    expect(after.querySelectorAll("rect[data-change]").length).toBeGreaterThan(
      0,
    );
    expect(after.querySelectorAll("text[data-change]")).toHaveLength(0);
  });

  it("draws a rewrite past the threshold plain", () => {
    expect(colourChanges(seqOld, seqNew)).toEqual({
      before: seqOld,
      after: seqNew,
    });
  });
});

/** A sequence diagram of messages A → B, one per text, as mermaid draws them. */
function sequence(id: string, messages: readonly string[]): string {
  const body = messages
    .map(
      (text, i) =>
        `<text class="messageText" y="${i * 10}">${text}</text>` +
        `<line data-et="message" data-from="A" data-to="B" marker-end="url(#${id}-arrowhead)"></line>`,
    )
    .join("");
  return (
    `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-roledescription="sequence">` +
    `<defs><marker id="${id}-arrowhead"><path d="M0,0"></path></marker></defs>${body}</svg>`
  );
}

describe("colourChanges: the threshold (T-773)", () => {
  beforeEach(() => stubBBox(() => ({ x: 0, y: 0, width: 1, height: 1 })));

  it("colours exactly half changed, and nothing past it", () => {
    expect(MAX_CHANGED).toBe(0.5);
    // 4 units, 2 unpaired: one each side.
    const half = colourChanges(
      sequence("a", ["x", "y"]),
      sequence("b", ["x", "z"]),
    );
    expect(parse(half.before).querySelectorAll("[data-band]")).toHaveLength(1);
    expect(parse(half.after).querySelectorAll("[data-band]")).toHaveLength(1);
    // 5 units, 3 unpaired.
    const before = sequence("a", ["x", "y"]);
    const after = sequence("b", ["x", "z", "w"]);
    expect(colourChanges(before, after)).toEqual({ before, after });
  });

  it("holds for diagrams that fall back to boxes, by label", () => {
    const klass = (labels: readonly string[]) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" aria-roledescription="class">${labels
        .map(
          (l) =>
            `<g class="node"><foreignObject><div>${l}</div></foreignObject></g>`,
        )
        .join("")}</svg>`;
    const half = colourChanges(klass(["a", "b"]), klass(["a", "c"]));
    expect(
      parse(half.before).querySelectorAll("rect[data-change]"),
    ).toHaveLength(1);
    expect(
      parse(half.after).querySelectorAll("rect[data-change]"),
    ).toHaveLength(1);
    const before = klass(["a"]);
    const after = klass(["b", "c"]);
    expect(colourChanges(before, after)).toEqual({ before, after });
  });

  it("boxes both sides when only one is a type it reads", () => {
    const out = colourChanges(seqOld, flowNew);
    // Past the threshold either way: the two share no label.
    expect(out).toEqual({ before: seqOld, after: flowNew });
    const mixed = colourChanges(
      sequence("a", ["x", "y", "z"]),
      sequence("b", ["x", "y", "w"]).replace('"sequence"', '"class"'),
    );
    expect(parse(mixed.before).querySelectorAll("[data-band]")).toHaveLength(0);
    expect(
      parse(mixed.before).querySelectorAll("rect[data-change]"),
    ).toHaveLength(1);
  });
});

describe("colourChanges: flowcharts (T-773)", () => {
  beforeEach(() => stubBBox(() => ({ x: 0, y: 0, width: 1, height: 1 })));

  it("colours the added node and both its unlabelled and labelled edges", () => {
    const out = colourChanges(flowOld, flowNew);
    expect(parse(out.before).querySelectorAll("[data-change]")).toHaveLength(0);
    const after = parse(out.after);
    expect(
      [...after.querySelectorAll("g.node[data-change]")].map((g) => g.id),
    ).toEqual(["mlflowNew-flowchart-wd-7"]);
    expect(
      [...after.querySelectorAll('path[data-et="edge"][data-change]')].map(
        (p) => p.getAttribute("data-id"),
      ),
    ).toEqual(["L_pending_wd_0", "L_wd_push_0"]);
    for (const el of after.querySelectorAll("[data-change]"))
      expect(el.getAttribute("data-change")).toBe("added");
    expect(
      after
        .querySelector("g.node[data-change] > :is(rect, path, polygon)")
        ?.getAttribute("style"),
    ).toContain("var(--diff-addition)");
  });

  it("cuts an edge between ids that hold underscores", () => {
    const rename = (svg: string) =>
      svg
        .replaceAll("-flowchart-cr-", "-flowchart-c_r-")
        .replaceAll("L_pending_cr_0", "L_pending_c_r_0")
        .replaceAll("L_cr_push_0", "L_c_r_push_0");
    const out = colourChanges(rename(flowOld), rename(flowNew));
    const after = parse(out.after);
    expect(
      [...after.querySelectorAll('path[data-et="edge"][data-change]')].map(
        (p) => p.getAttribute("data-id"),
      ),
    ).toEqual(["L_pending_wd_0", "L_wd_push_0"]);
  });

  it("colours only the edge whose label changed", () => {
    const relabel = edit(flowNew, "<p>approve</p>", "<p>accept</p>");
    const out = colourChanges(flowOld, relabel);
    const after = parse(out.after);
    expect(
      [...after.querySelectorAll('path[data-et="edge"][data-change]')].map(
        (p) => p.getAttribute("data-id"),
      ),
    ).toContain("L_pending_ok_0");
    expect(
      after.querySelector(
        '.edgeLabel[data-change] .label[data-id="L_pending_ok_0"]',
      ),
    ).not.toBeNull();
    expect(
      after
        .querySelector('g.node[id$="-flowchart-ok-3"]')
        ?.hasAttribute("data-change"),
    ).toBe(false);
  });
});

describe("colourChanges: boxes (T-724)", () => {
  const svg = (node: string, edge: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">` +
    `<g class="node" id="n"><rect></rect><foreignObject><div>${node}</div></foreignObject></g>` +
    `<text transform="translate(5, 6)">  ${edge}\n </text>` +
    `<text>same</text><text>also</text></svg>`;

  it("boxes only the unpaired labels, a node's label on its node", () => {
    stubBBox(() => ({ x: 10, y: 20, width: 30, height: 40 }));
    const out = colourChanges(svg("old", "same edge"), svg("new", "edge"));
    const before = parse(out.before);
    const after = parse(out.after);

    const node = before.querySelector("g.node");
    expect(node?.lastElementChild?.getAttribute("data-change")).toBe("removed");
    expect(node?.lastElementChild?.getAttribute("x")).toBe("8");
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

    expect(before.querySelectorAll("[data-change]")).toHaveLength(2);
    expect(after.querySelectorAll("[data-change]")).toHaveLength(2);
  });

  it("leaves both renders alone when nothing can be measured", () => {
    stubBBox(() => {
      throw new TypeError("getBBox is not a function");
    });
    for (const [before, after] of [
      [svg("old", "a"), svg("new", "a")],
      [seqOld, seqEdit],
    ] as const)
      expect(colourChanges(before, after)).toEqual({ before, after });
  });

  it("takes its measuring host down again", () => {
    stubBBox(() => ({ x: 0, y: 0, width: 1, height: 1 }));
    const childCount = document.body.childElementCount;
    colourChanges(seqOld, seqEdit);
    expect(document.body.childElementCount).toBe(childCount);
  });
});
