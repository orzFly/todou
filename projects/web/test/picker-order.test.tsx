import { act, renderHook } from "@testing-library/react";
import type { DependencyList } from "react";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePickerOrder } from "../src/components/issue/picker-row.ts";

const memoCache = vi.hoisted(() => ({ generation: 0 }));

vi.mock(import("react"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Keep real hook slots and state. Changing this extra dependency forces
    // memo factories to run again without remounting or changing picker inputs.
    useMemo<T>(factory: () => T, deps: DependencyList) {
      return actual.useMemo(factory, [...deps, memoCache.generation]);
    },
  };
});

// Neither source order nor selected-ID order is the expected partition order.
const ITEMS = [
  { id: 3, name: "Charlie" },
  { id: 4, name: "Delta" },
  { id: 1, name: "Alpha" },
  { id: 2, name: "Bravo" },
];
const idOf = (item: (typeof ITEMS)[number]) => item.id;

beforeEach(() => {
  memoCache.generation = 0;
});

describe("usePickerOrder snapshot lifetime (T-479)", () => {
  it("keeps the full order after selecting an unselected item and discarding memo caches", () => {
    const { result, rerender } = renderHook(() => {
      const [selectedIds, setSelectedIds] = useState([2, 4]);
      const probe = useMemo(() => ({}), []);
      const ordered = usePickerOrder(ITEMS, selectedIds, idOf, true);
      return { selectedIds, setSelectedIds, probe, ordered };
    });
    const openingProbe = result.current.probe;
    const openingOrder = [
      { id: 4, name: "Delta" },
      { id: 2, name: "Bravo" },
      { id: 3, name: "Charlie" },
      { id: 1, name: "Alpha" },
    ];
    expect(result.current.ordered).toEqual(openingOrder);

    act(() => result.current.setSelectedIds([2, 4, 1]));
    expect(result.current.selectedIds).toEqual([2, 4, 1]);
    expect(result.current.ordered).toEqual(openingOrder);
    expect(result.current.probe).toBe(openingProbe);

    memoCache.generation += 1;
    rerender();
    // Prove the cache was invalidated while the selected state survived.
    // Restoring the old useMemo selection snapshot makes the final assertion
    // fail with [Delta, Alpha, Bravo, Charlie] instead of the opening order.
    expect(result.current.probe).not.toBe(openingProbe);
    expect(result.current.selectedIds).toEqual([2, 4, 1]);
    expect(result.current.ordered).toEqual(openingOrder);
  });

  it("resamples selection when only the candidate ID sequence changes", () => {
    const { result, rerender } = renderHook(
      ({ items, selectedIds }) =>
        usePickerOrder(items, selectedIds, idOf, true),
      { initialProps: { items: ITEMS, selectedIds: [2, 4] } },
    );
    rerender({ items: ITEMS, selectedIds: [2, 1] });
    expect(result.current.map(idOf)).toEqual([4, 2, 3, 1]);

    rerender({ items: [...ITEMS].reverse(), selectedIds: [2, 1] });
    expect(result.current.map(idOf)).toEqual([2, 1, 4, 3]);
  });
});
