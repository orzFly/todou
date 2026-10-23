import { expect } from "vitest";

/** Checks DOM visibility without relying on layout APIs absent from happy-dom. */
export function expectVisible(element: Element) {
  expect(element.isConnected).toBe(true);
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    // `hidden` is an HTML attribute; a project's fallback REF is SVG text.
    if (node instanceof HTMLElement) expect(node.hidden).toBe(false);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toBe("hidden");
    expect(style.visibility).not.toBe("collapse");
  }
}
