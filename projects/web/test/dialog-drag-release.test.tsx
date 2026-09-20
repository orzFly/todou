import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../src/components/ui/dialog.tsx";

/**
 * The release `dialog.tsx` performs for a finger (T-450, T-471) needs two
 * things happy-dom cannot produce: a shadow root that retargets `event.target`
 * to its host, and a box with room to scroll. Both are staged here, because
 * what this file grades is the origin bookkeeping between one touchstart and
 * the next, not the geometry — the real gesture over pierre's real shadow root
 * is graded in `scripts/revision-history-wrap-smoke.mjs`.
 *
 * happy-dom does not retarget at all: its `event.target` stays the node the
 * event was dispatched on, while `composedPath()` reads an internal field, so
 * an own `target` property shadows the one without disturbing the other — the
 * same pair of answers a real open shadow root gives.
 */
const HOST = "shadow-host";
const SCROLLER = "shadow-scroller";

function stageScroller(): { host: HTMLElement; scroller: HTMLElement } {
  const host = document.querySelector<HTMLElement>(`[data-testid="${HOST}"]`);
  const scroller = document.querySelector<HTMLElement>(
    `[data-testid="${SCROLLER}"]`,
  );
  if (host === null || scroller === null)
    throw new Error("dialog never opened");
  for (const [property, value] of [
    ["scrollWidth", 500],
    ["clientWidth", 100],
    ["scrollLeft", 0],
  ] as const) {
    Object.defineProperty(scroller, property, {
      value,
      configurable: true,
      writable: true,
    });
  }
  return { host, scroller };
}

function touch(x: number, y: number, identifier: number, target: EventTarget) {
  return new Touch({ identifier, target, clientX: x, clientY: y });
}

/**
 * One touch event, dispatched on the scroller but claiming the host as its
 * target, which is what the lock and the release both read.
 */
function sendTouch(
  type: "touchstart" | "touchmove" | "touchend",
  points: Touch[],
  { host, scroller }: { host: HTMLElement; scroller: HTMLElement },
) {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: points,
    targetTouches: points,
    changedTouches: points,
  });
  Object.defineProperty(event, "target", { value: host, configurable: true });
  fireEvent(scroller, event);
}

function openDialog() {
  return render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Revision</DialogTitle>
        <div data-testid={HOST}>
          <div data-testid={SCROLLER} style={{ overflowX: "scroll" }}>
            a very long line
          </div>
        </div>
      </DialogContent>
    </Dialog>,
  );
}

/** Touchmoves the release let through to the document — the lock's reach. */
function countArrivals(): { count: () => number; stop: () => void } {
  let arrived = 0;
  const listener = () => {
    arrived += 1;
  };
  window.addEventListener("touchmove", listener);
  return {
    count: () => arrived,
    stop: () => window.removeEventListener("touchmove", listener),
  };
}

describe("a sideways drag inside a dialog's shadow scroller", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("stays released after a second finger joins and leaves (T-490)", () => {
    const view = openDialog();
    cleanups.push(() => view.unmount());
    const nodes = stageScroller();
    const window_ = countArrivals();
    cleanups.push(window_.stop);

    const first = (x: number) => touch(x, 100, 1, nodes.host);
    sendTouch("touchstart", [first(300)], nodes);
    sendTouch("touchmove", [first(280)], nodes);
    expect(window_.count()).toBe(0);

    // The interlude: a second finger lands and lifts again, with the first
    // never leaving the glass.
    sendTouch(
      "touchstart",
      [first(280), touch(120, 300, 2, nodes.host)],
      nodes,
    );
    sendTouch("touchend", [first(280)], nodes);

    sendTouch("touchmove", [first(240)], nodes);
    expect(window_.count()).toBe(0);
  });

  it("still stands down while two fingers are on the glass", () => {
    const view = openDialog();
    cleanups.push(() => view.unmount());
    const nodes = stageScroller();
    const window_ = countArrivals();
    cleanups.push(window_.stop);

    const first = (x: number) => touch(x, 100, 1, nodes.host);
    sendTouch("touchstart", [first(300)], nodes);
    sendTouch(
      "touchstart",
      [first(300), touch(120, 300, 2, nodes.host)],
      nodes,
    );
    sendTouch("touchmove", [first(260), touch(140, 300, 2, nodes.host)], nodes);

    // The lock answers a pinch before it asks about scrollers, so this one has
    // to reach it rather than be handed past it.
    expect(window_.count()).toBe(1);
  });
});
