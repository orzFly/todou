import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusHeading } from "../src/components/issue/status-pill.tsx";

describe("StatusHeading", () => {
  const status = { name: "Todo", color: "#123456" };
  const select = {
    checked: false,
    indeterminate: true,
    disabled: false,
    onChange: () => {},
    label: "select every issue in Todo",
  };

  it("draws what it drew before T-732 when nothing is selectable", () => {
    const { container } = render(<StatusHeading status={status} />);
    expect(container.innerHTML).toBe(
      '<span class="size-2.5 shrink-0 rounded-full" style="background-color: #123456;" aria-hidden="true"></span><span class="min-w-0 truncate font-medium">Todo</span>',
    );
  });

  it("puts the column's select-all box in the dot's cell", () => {
    const { getByRole } = render(
      <StatusHeading status={status} select={select} />,
    );
    const box = getByRole("checkbox", { name: "select every issue in Todo" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    const dot = box
      .closest('[data-slot="select-slot"]')
      ?.querySelector('[style*="background-color"]');
    expect(dot?.closest("[aria-hidden]")).not.toBeNull();
  });

  it("shows the box while the caller says the pointer is on the row", () => {
    const slot = (props: Partial<typeof select> & { revealed?: boolean }) =>
      render(
        <StatusHeading status={status} select={{ ...select, ...props }} />,
      ).container.querySelector('[data-slot="select-slot"]');
    expect(slot({ revealed: true })?.hasAttribute("data-revealed")).toBe(true);
    expect(slot({ revealed: false })?.hasAttribute("data-revealed")).toBe(
      false,
    );
    // A disabled slot never trades its icon away.
    expect(
      slot({ revealed: true, disabled: true })?.hasAttribute("data-revealed"),
    ).toBe(false);
  });
});
