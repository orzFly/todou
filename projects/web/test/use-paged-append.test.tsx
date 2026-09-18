import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePagedAppend } from "../src/lib/use-paged-append.ts";

describe("usePagedAppend synchronous reentry guard", () => {
  it("blocks two append calls in the same tick before pending renders", async () => {
    const { result } = renderHook(() => usePagedAppend<string>("filter"));
    let resolve!: (page: string) => void;
    const request = new Promise<string>((done) => {
      resolve = done;
    });
    const load = vi.fn(() => request);

    // One act callback intentionally holds React's render commit until both
    // calls finish. Separate fireEvent clicks flush between calls and cannot
    // distinguish a synchronous ref guard from a stale pending-state guard.
    act(() => {
      const append = result.current.append;
      append(load);
      append(load);
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);

    await act(async () => resolve("second"));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.pages).toEqual(["second"]);
  });
});
