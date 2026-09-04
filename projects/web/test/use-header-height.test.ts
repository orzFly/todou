import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHeaderHeight } from "../src/lib/use-header-height.ts";

/**
 * happy-dom has no layout engine: `getBoundingClientRect()` answers 0 for
 * every element, whatever its styles say. So the height has to be stubbed
 * per element, and no test in this suite can assert what the real header
 * comes to at a given viewport — that stays a browser check (T-232).
 */
function headerOf(height: number): HTMLElement {
  const header = document.createElement("header");
  header.getBoundingClientRect = () => ({ height }) as DOMRect;
  document.body.append(header);
  return header;
}

afterEach(() => {
  for (const header of document.querySelectorAll("header")) header.remove();
});

describe("useHeaderHeight", () => {
  it("takes the height off the header rather than assuming one", () => {
    // The whole point of T-233: 56 is a fallback, not an answer. A header
    // that measures anything else has to come back as that.
    headerOf(97);
    expect(renderHook(() => useHeaderHeight()).result.current).toBe(97);
  });

  it("follows the header when it gains or loses a row", () => {
    const header = headerOf(97);
    const { result } = renderHook(() => useHeaderHeight());
    expect(result.current).toBe(97);

    header.getBoundingClientRect = () => ({ height: 57 }) as DOMRect;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toBe(57);
  });

  it("stands on the fallback until there is a header to measure", () => {
    expect(renderHook(() => useHeaderHeight()).result.current).toBe(56);
  });
});
