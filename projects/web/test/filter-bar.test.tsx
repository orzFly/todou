import { fireEvent, render } from "@testing-library/react";
import type { IssueCounts } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import type { IssueSearch } from "../src/api/issues.ts";
import { FilterBar } from "../src/components/issue/filter-bar.tsx";

const counts: IssueCounts = { open: 5, closed: 3, by_status: {} };

function renderBar(search: IssueSearch) {
  const onChange = vi.fn();
  const utils = render(
    <FilterBar
      search={search}
      counts={counts}
      statuses={[]}
      labels={[]}
      members={[]}
      onChange={onChange}
    />,
  );
  return { onChange, ...utils };
}

describe("category segment in the toolbar (T-88)", () => {
  it("writes the category, keeping the open default out of the URL", () => {
    const { onChange, getByText } = renderBar({ category: "closed" });
    fireEvent.click(getByText("Open 5"));
    expect(onChange).toHaveBeenCalledWith({ category: undefined });
    fireEvent.click(getByText("All"));
    expect(onChange).toHaveBeenCalledWith({ category: "all" });
  });

  it("shows both counts", () => {
    const { getByText } = renderBar({});
    expect(getByText("Open 5")).toBeTruthy();
    expect(getByText("Closed 3")).toBeTruthy();
  });
});

describe("grouped toggle (T-88)", () => {
  it("defaults to pressed and writes the opt-out", () => {
    const { onChange, getByText } = renderBar({});
    const button = getByText("Grouped").closest("button");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    if (button) fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith({ group: "none" });
  });

  it("clears the param when re-enabled", () => {
    const { onChange, getByText } = renderBar({ group: "none" });
    const button = getByText("Grouped").closest("button");
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    if (button) fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith({ group: undefined });
  });

  it("only exists in the open view", () => {
    expect(renderBar({ category: "closed" }).queryByText("Grouped")).toBeNull();
    expect(renderBar({ category: "all" }).queryByText("Grouped")).toBeNull();
  });
});
