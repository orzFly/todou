import { expect } from "vitest";

/** Checks DOM visibility without relying on layout APIs absent from happy-dom. */
export function expectVisible(element: HTMLElement) {
  expect(element.isConnected).toBe(true);
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    expect(node.hidden).toBe(false);
    expect(style.display).not.toBe("none");
    expect(style.visibility).not.toBe("hidden");
    expect(style.visibility).not.toBe("collapse");
  }
}
