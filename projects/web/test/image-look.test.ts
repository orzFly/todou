import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_LOOK,
  IMAGE_LOOK_STORAGE_KEY,
  parseImageLook,
} from "../src/lib/image-look.ts";

// The store caches what it read at first use, so every case loads a fresh
// copy of the module, the way a page load would.
const freshStore = async () => {
  vi.resetModules();
  return await import("../src/lib/image-look.ts");
};

afterEach(() => localStorage.clear());

describe("parseImageLook", () => {
  it("defaults to the checkerboard and smooth scaling", () => {
    expect(parseImageLook(null)).toEqual({
      background: "checker",
      smoothing: "smooth",
    });
    expect(parseImageLook("{")).toEqual(DEFAULT_IMAGE_LOOK);
    expect(parseImageLook("[]")).toEqual(DEFAULT_IMAGE_LOOK);
  });

  it("keeps each valid field and defaults the others", () => {
    expect(
      parseImageLook('{"background":"black","smoothing":"blurry"}'),
    ).toEqual({ background: "black", smoothing: "smooth" });
  });
});

describe("store", () => {
  it("writes a choice through and reads it back on the next load", async () => {
    const first = await freshStore();
    first.setImageLook({ background: "black" });
    first.setImageLook({ smoothing: "pixelated" });
    expect(
      JSON.parse(localStorage.getItem(IMAGE_LOOK_STORAGE_KEY) ?? ""),
    ).toEqual({ background: "black", smoothing: "pixelated" });
    const second = await freshStore();
    second.setImageLook({});
    expect(
      parseImageLook(localStorage.getItem(IMAGE_LOOK_STORAGE_KEY)),
    ).toEqual({ background: "black", smoothing: "pixelated" });
  });

  it("still switches when storage refuses the write", async () => {
    const store = await freshStore();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    try {
      const { result } = renderHook(() => store.useImageLook());
      act(() => store.setImageLook({ background: "black" }));
      expect(result.current.background).toBe("black");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("useImageLook", () => {
  it("re-renders on a choice made here and on one made in another tab", async () => {
    const store = await freshStore();
    const { result } = renderHook(() => store.useImageLook());
    expect(result.current).toEqual(DEFAULT_IMAGE_LOOK);
    act(() => store.setImageLook({ smoothing: "pixelated" }));
    expect(result.current.smoothing).toBe("pixelated");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: IMAGE_LOOK_STORAGE_KEY,
          newValue: '{"background":"black","smoothing":"smooth"}',
        }),
      );
    });
    expect(result.current).toEqual({
      background: "black",
      smoothing: "smooth",
    });
  });
});
