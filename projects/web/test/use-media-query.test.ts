import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MD_UP, useMediaQuery } from "../src/lib/use-media-query.ts";

/** happy-dom's viewport, which is what its `matchMedia` answers from. */
const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

const setWidth = (width: number) => happyDom.happyDOM.setViewport({ width });

afterEach(() => setWidth(1024));

describe("useMediaQuery", () => {
  it("answers from the viewport it is first rendered at", () => {
    setWidth(1280);
    expect(renderHook(() => useMediaQuery(MD_UP)).result.current).toBe(true);

    setWidth(390);
    expect(renderHook(() => useMediaQuery(MD_UP)).result.current).toBe(false);
  });

  it("follows the viewport across the breakpoint after mounting", () => {
    // Mounted narrow on purpose: happy-dom seeds a `change` listener's
    // remembered state to `false` whatever the query answers at the time, so
    // a listener registered while the query already matches misses the step
    // back down. Starting below the breakpoint puts its bookkeeping in sync
    // and both directions come through.
    setWidth(390);
    const { result } = renderHook(() => useMediaQuery(MD_UP));
    expect(result.current).toBe(false);

    act(() => setWidth(900));
    expect(result.current).toBe(true);

    act(() => setWidth(390));
    expect(result.current).toBe(false);
  });

  it("reads the wide branch where matchMedia is missing", () => {
    setWidth(390);
    vi.stubGlobal("matchMedia", undefined);
    try {
      expect(renderHook(() => useMediaQuery(MD_UP)).result.current).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
