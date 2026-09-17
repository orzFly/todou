import { afterEach, describe, expect, it } from "vitest";
import { selectedSourceRange } from "../src/lib/quote-selection.ts";

/**
 * A stamped body the way `rehypeSourceLines` leaves one, plus a sibling that
 * is not part of it — the "endpoint outside the container" case needs a real
 * node somewhere else in the document.
 */
function mountBody(): {
  container: HTMLElement;
  first: Text;
  second: Text;
  bare: Text;
  outside: Text;
} {
  const host = document.createElement("div");
  host.innerHTML = [
    '<div id="body">',
    '<p data-loc="1-1">first</p>',
    '<blockquote data-loc="3-5"><p data-loc="3-5">second</p></blockquote>',
    '<div id="bare">unstamped</div>',
    "</div>",
    // Stamped as well, so dropping the containment check would produce a
    // range rather than the null this asserts.
    '<p id="outside" data-loc="9-9">elsewhere</p>',
  ].join("");
  document.body.append(host);
  const container = host.querySelector("#body") as HTMLElement;
  const text = (selector: string) =>
    host.querySelector(selector)?.firstChild as Text;
  return {
    container,
    first: text("p[data-loc='1-1']"),
    second: text("blockquote p"),
    bare: text("#bare"),
    outside: text("#outside"),
  };
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection();
  if (selection === null) throw new Error("no selection support");
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("selectedSourceRange", () => {
  it("gives the block's own range for a selection inside one block", () => {
    const { container, second } = mountBody();
    select(second, 0, second, 6);
    expect(selectedSourceRange(container)).toEqual({ start: 3, end: 5 });
  });

  it("spans from the first block's start to the last block's end", () => {
    const { container, first, second } = mountBody();
    select(first, 0, second, 6);
    expect(selectedSourceRange(container)).toEqual({ start: 1, end: 5 });
  });

  it("gives up when an endpoint is outside the container", () => {
    const { container, first, outside } = mountBody();
    select(first, 0, outside, 5);
    expect(selectedSourceRange(container)).toBeNull();
  });

  it("gives up on a collapsed selection", () => {
    const { container, first } = mountBody();
    select(first, 2, first, 2);
    expect(selectedSourceRange(container)).toBeNull();
  });

  it("gives up when an endpoint has no stamped ancestor", () => {
    const { container, first, bare } = mountBody();
    select(first, 0, bare, 4);
    expect(selectedSourceRange(container)).toBeNull();
  });

  it("gives up when nothing is selected at all", () => {
    const { container } = mountBody();
    expect(selectedSourceRange(container)).toBeNull();
  });
});
