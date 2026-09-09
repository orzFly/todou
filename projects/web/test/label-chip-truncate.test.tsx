import type { Label } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { LabelChips } from "../src/components/issue/label-chip.tsx";
import { renderWithProviders } from "./render.tsx";

const labels: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  {
    id: 2,
    name: "area:CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP",
    color: "#0ea5e9",
  },
  { id: 3, name: "needs-brainstorm", color: "#a855f7" },
];

const chipOf = (view: ReturnType<typeof renderWithProviders>, label: Label) =>
  view.getByTitle(label.name);

/* Truncation is CSS, and happy-dom has neither a layout engine nor Tailwind,
   so these assert the structure the ellipsis needs; the real-browser pass
   covers whether one appears. */
describe("LabelChips truncate (T-305)", () => {
  it("renders chips unchanged when truncate is not passed", async () => {
    const view = renderWithProviders(<LabelChips labels={labels} />);
    await view.findByTitle("area:web");

    for (const label of labels) {
      const chip = chipOf(view, label);
      expect(chip.className).not.toContain("min-w-0");
      expect(chip.querySelector(".truncate")).toBeNull();
    }
    const group = view.container.querySelector(
      "span.inline-flex.items-center.gap-1",
    );
    expect(group).not.toBeNull();
    expect(group?.className).not.toContain("min-w-0");
  });

  it("gives every chip and its group a shrinkable box and a block text child", async () => {
    const view = renderWithProviders(<LabelChips labels={labels} truncate />);
    await view.findByTitle("area:web");

    for (const label of labels) {
      const chip = chipOf(view, label);
      expect(chip.className).toContain("min-w-0");
      expect(chip.querySelector(".truncate")).not.toBeNull();
    }

    const group = view.container.querySelector(
      "span.inline-flex.items-center.gap-1",
    );
    expect(group).not.toBeNull();
    expect(group?.className).toContain("min-w-0");
    // labels[2] is unprefixed, so it takes the other render path — the one a
    // truncate prop is easy to forget.
    expect(group?.contains(chipOf(view, labels[2]))).toBe(false);
  });

  it("keeps the full name reachable in both modes", async () => {
    for (const truncate of [false, true]) {
      const view = renderWithProviders(
        <LabelChips labels={labels} truncate={truncate} />,
      );
      await view.findByTitle("area:web");
      for (const label of labels) {
        expect(chipOf(view, label).textContent).toContain(
          label.name.split(":").at(-1),
        );
      }
      expect(view.container.textContent).toContain("area:");
      view.unmount();
    }
  });
});
