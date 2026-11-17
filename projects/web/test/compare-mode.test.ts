import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetCompareMode,
  setCompareMode,
  useCompareMode,
} from "../src/lib/compare-mode.ts";

beforeEach(() => resetCompareMode());
afterEach(() => vi.unstubAllGlobals());

describe("the comparison mode (T-722)", () => {
  it("starts side by side", () => {
    const { result } = renderHook(() => useCompareMode());
    expect(result.current).toBe("2up");
  });

  it("switches every comparison on the page together", () => {
    const one = renderHook(() => useCompareMode());
    const two = renderHook(() => useCompareMode());
    act(() => setCompareMode("swipe"));
    expect(one.result.current).toBe("swipe");
    expect(two.result.current).toBe("swipe");
  });

  it("is not written to localStorage", () => {
    // A stubbed global, not a spy: happy-dom's storage spies never fire.
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    act(() => setCompareMode("diff"));
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
