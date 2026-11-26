import { useSelection } from "@orz/ui/hooks/use-selection";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const render = (keys: number[]) =>
  renderHook(({ keys }) => useSelection(keys), {
    initialProps: { keys },
  });

describe("useSelection (T-699)", () => {
  it("toggles keys and reports them in list order", () => {
    const view = render([1, 2, 3, 4]);
    act(() => view.result.current.toggle(3));
    act(() => view.result.current.toggle(1));
    expect(view.result.current.selected).toEqual([1, 3]);
    expect(view.result.current.state).toBe("some");
    act(() => view.result.current.toggle(3));
    expect(view.result.current.selected).toEqual([1]);
  });

  it("extends from the last toggled key to the shift-clicked one", () => {
    const view = render([1, 2, 3, 4, 5]);
    act(() => view.result.current.toggle(4));
    act(() => view.result.current.toggle(2, { extend: true }));
    expect(view.result.current.selected).toEqual([2, 3, 4]);
    // The range takes the clicked key's new state, so a shift-click on a
    // selected key clears the span back to the anchor.
    act(() => view.result.current.toggle(3, { extend: true }));
    expect(view.result.current.selected).toEqual([4]);
  });

  it("extends from nothing as a plain toggle", () => {
    const view = render([1, 2, 3]);
    act(() => view.result.current.toggle(3, { extend: true }));
    expect(view.result.current.selected).toEqual([3]);
  });

  it("selects all from a partial selection, and none from all", () => {
    const view = render([1, 2, 3]);
    act(() => view.result.current.toggle(2));
    act(() => view.result.current.toggleAll());
    expect(view.result.current.state).toBe("all");
    act(() => view.result.current.toggleAll());
    expect(view.result.current.state).toBe("none");
  });

  it("drops a key that leaves the list, and the next change forgets it", () => {
    const view = render([1, 2, 3]);
    act(() => view.result.current.toggleAll());
    view.rerender({ keys: [1, 3] });
    expect(view.result.current.selected).toEqual([1, 3]);
    expect(view.result.current.state).toBe("all");
    act(() => view.result.current.toggle(1));
    view.rerender({ keys: [1, 2, 3] });
    expect(view.result.current.selected).toEqual([3]);
  });
});
