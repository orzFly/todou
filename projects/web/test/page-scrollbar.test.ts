import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackPageScrollbarWidth } from "@/lib/page-scrollbar.ts";

// happy-dom lays nothing out, so the observer is driven by hand and the root's
// width is whatever the test says the gutter left it.
let observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  observed: Element[] = [];
  disconnected = false;
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let rootWidth = 0;
const root = document.documentElement;
const width = () => root.style.getPropertyValue("--page-scrollbar-width");
const only = () => {
  expect(observers).toHaveLength(1);
  return observers[0] as FakeResizeObserver;
};

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("innerWidth", 1280);
  vi.spyOn(root, "getBoundingClientRect").mockImplementation(
    () => ({ width: rootWidth }) as DOMRect,
  );
});

afterEach(() => {
  document.body.removeAttribute("data-scroll-locked");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trackPageScrollbarWidth (T-821)", () => {
  it("reserves the gutter on the root and observes the root", () => {
    const stop = trackPageScrollbarWidth();
    expect(root.style.getPropertyValue("scrollbar-gutter")).toBe("stable");
    expect(only().observed).toEqual([root]);
    stop();
  });

  it("publishes what the root is short of the window", () => {
    const stop = trackPageScrollbarWidth();
    rootWidth = 1265;
    only().fire();
    expect(width()).toBe("15px");
    stop();
  });

  it("publishes 0 beside a scrollbar that takes no width", () => {
    const stop = trackPageScrollbarWidth();
    rootWidth = 1280;
    only().fire();
    expect(width()).toBe("0px");
    stop();
  });

  it("keeps the last width while scrolling is locked, and measures again once it lifts", () => {
    const stop = trackPageScrollbarWidth();
    rootWidth = 1265;
    only().fire();
    // The lock hands the gutter back: the root spans the window.
    document.body.setAttribute("data-scroll-locked", "1");
    rootWidth = 1280;
    only().fire();
    expect(width()).toBe("15px");
    // Zoomed meanwhile: the bar is narrower in CSS pixels once it returns.
    document.body.removeAttribute("data-scroll-locked");
    rootWidth = 1272;
    only().fire();
    expect(width()).toBe("8px");
    stop();
  });

  it("stops observing and clears both properties when stopped", () => {
    const stop = trackPageScrollbarWidth();
    rootWidth = 1265;
    only().fire();
    stop();
    expect(only().disconnected).toBe(true);
    expect(root.style.getPropertyValue("scrollbar-gutter")).toBe("");
    expect(width()).toBe("");
  });
});
