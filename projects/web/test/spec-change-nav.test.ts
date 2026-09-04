import { afterEach, describe, expect, it } from "vitest";
import {
  acceptsShortcut,
  currentIndex,
  type Stops,
  stepIndex,
} from "../src/lib/spec-change-nav.ts";

const POSITIONS = [100, 300, 500];

// What each pivot means for a reader: above everything, resting on the second
// candidate, and past the last one.
const CASES: [label: string, stops: Stops, next: number, prev: number][] = [
  ["resting on the second stop", { positions: POSITIONS, pivot: 300 }, 2, 0],
  ["above every stop", { positions: POSITIONS, pivot: 0 }, 0, -1],
  ["below every stop", { positions: POSITIONS, pivot: 1000 }, -1, 2],
  // 305 is inside 300's ±8 band, 310 is outside it: the stop the reader is on
  // excludes itself from both directions, the one just above does not.
  ["5px off the second stop", { positions: POSITIONS, pivot: 305 }, 2, 0],
  ["10px off the second stop", { positions: POSITIONS, pivot: 310 }, 2, 1],
  ["no stops at all", { positions: [], pivot: 0 }, -1, -1],
];

describe("spec change navigation (T-224)", () => {
  for (const [label, stops, next, prev] of CASES) {
    it(`steps from a pivot ${label}`, () => {
      expect(stepIndex(stops, 1)).toBe(next);
      expect(stepIndex(stops, -1)).toBe(prev);
    });
  }

  it("counts the stop ↓ would land on", () => {
    // The identity the whole design rests on: the displayed number and the
    // arrow's target are one decision, so they cannot disagree on screen.
    for (const [, stops] of CASES) {
      const next = stepIndex(stops, 1);
      expect(currentIndex(stops)).toBe(
        next === -1 ? stops.positions.length : next,
      );
    }
    expect(currentIndex({ positions: POSITIONS, pivot: 0 })).toBe(0);
    expect(currentIndex({ positions: POSITIONS, pivot: 300 })).toBe(2);
    expect(currentIndex({ positions: POSITIONS, pivot: 1000 })).toBe(3);
    expect(currentIndex({ positions: [], pivot: 0 })).toBe(0);
  });
});

/** The `n`/`p` handler's verdict on an event dispatched at `target`. */
function verdictAt(target: Element, init: KeyboardEventInit = {}): boolean {
  let verdict: boolean | undefined;
  const listener = (event: Event) => {
    verdict = acceptsShortcut(event as KeyboardEvent);
  };
  document.addEventListener("keydown", listener);
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "n", bubbles: true, ...init }),
  );
  document.removeEventListener("keydown", listener);
  if (verdict === undefined) throw new Error("the event never reached us");
  return verdict;
}

function appended(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const el = host.firstElementChild;
  if (el === null) throw new Error("nothing to dispatch on");
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("acceptsShortcut (T-224)", () => {
  it("accepts a bare letter on the page", () => {
    expect(verdictAt(appended("<button>go</button>"))).toBe(true);
  });

  it("refuses the keys the reader is typing with", () => {
    expect(verdictAt(appended("<input />"))).toBe(false);
    expect(verdictAt(appended("<textarea></textarea>"))).toBe(false);
    expect(verdictAt(appended("<select></select>"))).toBe(false);
    const editable = appended('<div contenteditable="true">draft</div>');
    expect(verdictAt(editable)).toBe(false);
  });

  it("refuses keys inside a menu, a dialog or a listbox", () => {
    for (const role of ["menu", "dialog", "listbox"]) {
      const inner = appended(
        `<div role="${role}"><button>item</button></div>`,
      ).querySelector("button");
      if (inner === null) throw new Error("no inner button");
      expect(verdictAt(inner)).toBe(false);
    }
  });

  it("refuses a keystroke that is composing or modified", () => {
    const page = appended("<button>go</button>");
    expect(verdictAt(page, { isComposing: true })).toBe(false);
    expect(verdictAt(page, { ctrlKey: true })).toBe(false);
    expect(verdictAt(page, { metaKey: true })).toBe(false);
    expect(verdictAt(page, { altKey: true })).toBe(false);
  });
});
