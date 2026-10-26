import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { visibleSpace } from "../src/lib/editor/tooltip-space.ts";

/** happy-dom has no layout: give an element the box a browser would. */
function box(
  el: HTMLElement,
  rect: { top: number; left: number; width: number; height: number },
) {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }) as DOMRect;
  for (const [key, value] of [
    ["clientWidth", rect.width],
    ["clientHeight", rect.height],
  ] as const) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
}

/** dialog (fixed, scrolling) > wrapper > .cm-editor > .cm-tooltip */
function mount(position: "fixed" | "absolute") {
  box(document.documentElement, { top: 0, left: 0, width: 1024, height: 768 });
  const dialog = document.createElement("div");
  dialog.style.position = "fixed";
  dialog.style.overflowY = "auto";
  box(dialog, { top: 200, left: 300, width: 400, height: 200 });
  const outer = document.createElement("div");
  outer.style.overflow = "hidden";
  box(outer, { top: 0, left: 0, width: 1000, height: 120 });
  const dom = document.createElement("div");
  const tooltip = document.createElement("div");
  tooltip.className = "cm-tooltip";
  tooltip.style.position = position;
  dom.append(tooltip);
  dialog.append(dom);
  outer.append(dialog);
  document.body.append(outer);
  return { dom } as unknown as EditorView;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("visibleSpace", () => {
  it("is the window while tooltips are fixed", () => {
    expect(visibleSpace(mount("fixed"))).toEqual({
      top: 0,
      left: 0,
      bottom: 768,
      right: 1024,
    });
  });

  it("shrinks to the clipping ancestors of an absolute tooltip, up to the first fixed one", () => {
    // The outer box would cut the bottom to 120 — but the dialog is fixed,
    // so nothing above it clips what is inside.
    expect(visibleSpace(mount("absolute"))).toEqual({
      top: 200,
      left: 300,
      bottom: 400,
      right: 700,
    });
  });
});
