import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusHeading } from "../src/components/issue/status-pill.tsx";
import { Checkbox, SelectSlot } from "../src/components/ui/checkbox.tsx";

describe("Checkbox (T-731)", () => {
  it("is still a native checkbox, with the caller's class on the input", () => {
    const { container } = render(
      <Checkbox aria-label="pick" className="mt-0.5" />,
    );
    const input = container.querySelector("input");
    expect(input?.type).toBe("checkbox");
    expect(input?.className).toContain("mt-0.5");
  });

  it("writes indeterminate to the DOM property", () => {
    const { container, rerender } = render(
      <Checkbox aria-label="pick" indeterminate />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
    rerender(<Checkbox aria-label="pick" indeterminate={false} />);
    expect(input.indeterminate).toBe(false);
  });
});

describe("SelectSlot (T-732)", () => {
  it("holds the icon, hidden from assistive tech, beside the checkbox", () => {
    const { container, getByLabelText } = render(
      <SelectSlot
        aria-label="select a.txt"
        hoverGroup="att"
        icon={<svg data-testid="icon" />}
      />,
    );
    expect(getByLabelText("select a.txt").tagName).toBe("INPUT");
    const icon = container.querySelector("[data-testid=icon]");
    expect(icon?.closest("[aria-hidden]")).not.toBeNull();
  });
});

describe("StatusHeading", () => {
  const status = { name: "Todo", color: "#123456" };

  it("draws what it drew before T-732 when nothing is selectable", () => {
    const { container } = render(<StatusHeading status={status} />);
    expect(container.innerHTML).toBe(
      '<span class="size-2.5 shrink-0 rounded-full" style="background-color: #123456;" aria-hidden="true"></span><span class="min-w-0 truncate font-medium">Todo</span>',
    );
  });

  it("puts the column's select-all box in the dot's cell", () => {
    const { getByLabelText } = render(
      <StatusHeading
        status={status}
        select={{
          checked: false,
          indeterminate: true,
          disabled: false,
          onChange: () => {},
          label: "select every issue in Todo",
        }}
      />,
    );
    const box = getByLabelText("select every issue in Todo");
    expect((box as HTMLInputElement).indeterminate).toBe(true);
  });
});
