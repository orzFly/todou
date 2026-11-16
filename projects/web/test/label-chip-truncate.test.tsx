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
   covers whether one appears. Since T-715 it is not opt-in: a chip that can
   give ground everywhere is one less way to draw a label. */
describe("LabelChips truncation (T-305)", () => {
  it("gives every chip and its group a shrinkable box and a clipped text child", async () => {
    const view = renderWithProviders(<LabelChips labels={labels} />);
    await view.findByTitle("area:web");

    for (const label of labels) {
      const chip = chipOf(view, label);
      expect(chip.className).toContain("min-w-0");
      const text = chip.firstElementChild as HTMLElement;
      // clip, not hidden: hidden moves the baseline in running text
      expect(text.className).toContain("overflow-clip");
      expect(text.className).toContain("text-ellipsis");
    }

    const group = chipOf(view, labels[0] as Label).parentElement;
    expect(group?.className).toContain("min-w-0");
    // labels[2] is unprefixed, so it takes the other path through LabelChips.
    const plain = chipOf(view, labels[2] as Label).parentElement;
    expect(plain).not.toBe(group);
    expect(plain?.className).toContain("min-w-0");
  });

  it("keeps the full name reachable", async () => {
    const view = renderWithProviders(<LabelChips labels={labels} />);
    await view.findByTitle("area:web");
    for (const label of labels) {
      expect(chipOf(view, label).textContent).toBe(
        label.name.split(":").at(-1),
      );
    }
    expect(view.container.textContent).toContain("area:");
  });
});
