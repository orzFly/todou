import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Label } from "@todou/shared";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { LabelPicker } from "../src/components/issue/label-picker.tsx";

const LABELS: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  { id: 2, name: "area:cli", color: "#0ea5e9" },
  { id: 3, name: "kind:bug", color: "#ef4444" },
  { id: 4, name: "needs-brainstorm", color: "#8b5cf6" },
];

function open(
  props: Partial<Parameters<typeof LabelPicker>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <LabelPicker
      allLabels={LABELS}
      selected={[]}
      onToggle={() => {}}
      trigger={<button type="button">Edit labels</button>}
      defaultOpen
      {...props}
    />,
  );
}

const input = () => screen.getByLabelText("filter labels");
const list = () => within(screen.getByRole("listbox"));

// Reverse source and selection order independently so neither alphabetical
// sorting nor selected-array order can stand in for a stable partition.
const SNAPSHOT_LABELS = [...LABELS].reverse();

function LabelHarness({
  allLabels = SNAPSHOT_LABELS,
  onCreate,
}: {
  allLabels?: Label[];
  onCreate?: (name: string) => Promise<Label>;
}) {
  const [selected, setSelected] = useState<Label[]>([
    LABELS[1] as Label,
    LABELS[3] as Label,
  ]);
  return (
    <LabelPicker
      allLabels={allLabels}
      selected={selected.map((label) => ({ ...label }))}
      onToggle={(label) =>
        setSelected((current) =>
          current.some((item) => item.id === label.id)
            ? current.filter((item) => item.id !== label.id)
            : [...current, label],
        )
      }
      onCreate={onCreate}
      trigger={<button type="button">Edit labels</button>}
    />
  );
}

const labelNames = () =>
  list()
    .getAllByRole("option")
    .map((row) => row.querySelector("[title]")?.getAttribute("title"));
const labelRow = (name: string) =>
  list().getByTitle(name).closest('[role="option"]') as HTMLElement;
const openLabels = () =>
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));

describe("LabelPicker snapshot ordering", () => {
  it("opens selected-first in source order, freezes both toggle directions, and refreshes on reopen", () => {
    render(<LabelHarness />);
    openLabels();
    const initial = ["needs-brainstorm", "area:cli", "kind:bug", "area:web"];
    expect(labelNames()).toEqual(initial);

    fireEvent.click(labelRow("area:web"));
    expect(labelRow("area:web").getAttribute("aria-selected")).toBe("true");
    expect(labelNames()).toEqual(initial);

    fireEvent.click(labelRow("area:web"));
    expect(labelRow("area:web").getAttribute("aria-selected")).toBe("false");
    expect(labelNames()).toEqual(initial);

    fireEvent.click(labelRow("needs-brainstorm"));
    expect(labelRow("needs-brainstorm").getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(labelNames()).toEqual(initial);

    fireEvent.click(labelRow("kind:bug"));
    expect(labelRow("kind:bug").getAttribute("aria-selected")).toBe("true");
    expect(labelNames()).toEqual(initial);

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    openLabels();
    expect(labelNames()).toEqual([
      "kind:bug",
      "area:cli",
      "needs-brainstorm",
      "area:web",
    ]);
  });

  it("keeps the snapshot for fresh selection and same-ID candidate objects while rendering new names", () => {
    const view = render(<LabelHarness />);
    openLabels();
    fireEvent.click(labelRow("needs-brainstorm"));
    fireEvent.click(labelRow("kind:bug"));

    // The harness supplies a new selected array even on a parent-only render.
    view.rerender(<LabelHarness />);
    expect(labelNames()).toEqual([
      "needs-brainstorm",
      "area:cli",
      "kind:bug",
      "area:web",
    ]);

    view.rerender(
      <LabelHarness
        allLabels={SNAPSHOT_LABELS.map((label) => ({
          ...label,
          name: label.id === 3 ? "kind:defect" : label.name,
        }))}
      />,
    );
    expect(labelNames()).toEqual([
      "needs-brainstorm",
      "area:cli",
      "kind:defect",
      "area:web",
    ]);
    expect(labelRow("kind:defect").getAttribute("aria-selected")).toBe("true");
  });

  it("resamples current selection when candidates are added, removed, or replaced", () => {
    const view = render(<LabelHarness />);
    openLabels();
    fireEvent.click(labelRow("needs-brainstorm"));
    fireEvent.click(labelRow("kind:bug"));

    const added: Label = { id: 9, name: "area:docs", color: "#f97316" };
    const refreshed = [added, ...SNAPSHOT_LABELS];
    view.rerender(<LabelHarness allLabels={refreshed} />);
    expect(labelNames()).toEqual([
      "kind:bug",
      "area:cli",
      "area:docs",
      "needs-brainstorm",
      "area:web",
    ]);

    fireEvent.click(labelRow("kind:bug"));
    fireEvent.click(labelRow("area:web"));
    view.rerender(
      <LabelHarness allLabels={refreshed.filter((label) => label.id !== 9)} />,
    );
    expect(labelNames()).toEqual([
      "area:cli",
      "area:web",
      "needs-brainstorm",
      "kind:bug",
    ]);

    fireEvent.click(labelRow("area:cli"));
    fireEvent.click(labelRow("needs-brainstorm"));
    view.rerender(
      <LabelHarness
        allLabels={SNAPSHOT_LABELS.map((label) =>
          label.id === 3 ? added : label,
        )}
      />,
    );
    expect(labelNames()).toEqual([
      "needs-brainstorm",
      "area:web",
      "area:docs",
      "area:cli",
    ]);
  });

  it("refreshes on a query change even when the matching candidate IDs are unchanged", () => {
    render(<LabelHarness />);
    openLabels();
    fireEvent.change(input(), { target: { value: "area:" } });
    expect(labelNames()).toEqual(["area:cli", "area:web"]);
    fireEvent.click(labelRow("area:cli"));
    fireEvent.click(labelRow("area:web"));
    expect(labelNames()).toEqual(["area:cli", "area:web"]);

    fireEvent.change(input(), { target: { value: "AREA:" } });
    expect(labelNames()).toEqual(["area:web", "area:cli"]);
  });

  it("samples fresh selection when returning to a previous query", () => {
    render(<LabelHarness />);
    openLabels();
    fireEvent.change(input(), { target: { value: "area:" } });
    expect(labelNames()).toEqual(["area:cli", "area:web"]);
    fireEvent.click(labelRow("area:cli"));
    fireEvent.click(labelRow("area:web"));
    expect(labelNames()).toEqual(["area:cli", "area:web"]);

    fireEvent.change(input(), { target: { value: "" } });
    expect(labelNames()).toEqual([
      "needs-brainstorm",
      "area:web",
      "kind:bug",
      "area:cli",
    ]);
    fireEvent.change(input(), { target: { value: "area:" } });
    expect(labelNames()).toEqual(["area:web", "area:cli"]);
  });

  it("refreshes after creation clears the query and the new candidate arrives", async () => {
    const created: Label = { id: 9, name: "area:docs", color: "#f97316" };
    const onCreate = vi.fn().mockResolvedValue(created);
    const view = render(<LabelHarness onCreate={onCreate} />);
    openLabels();
    fireEvent.click(labelRow("needs-brainstorm"));
    fireEvent.click(labelRow("kind:bug"));
    fireEvent.change(input(), { target: { value: "area:docs" } });
    fireEvent.click(list().getByText("Create “area:docs”"));
    expect(onCreate).toHaveBeenCalledWith("area:docs");
    await vi.waitFor(() => {
      expect((input() as HTMLInputElement).value).toBe("");
      expect(screen.getByLabelText("remove area:docs")).toBeTruthy();
    });
    expect(labelNames()).toEqual([
      "kind:bug",
      "area:cli",
      "needs-brainstorm",
      "area:web",
    ]);

    view.rerender(
      <LabelHarness
        allLabels={[...SNAPSHOT_LABELS, created]}
        onCreate={onCreate}
      />,
    );
    expect(labelNames()).toEqual([
      "kind:bug",
      "area:cli",
      "area:docs",
      "needs-brainstorm",
      "area:web",
    ]);
    expect(labelRow("area:docs").getAttribute("aria-selected")).toBe("true");
  });
});

describe("LabelPicker check slots", () => {
  it("starts each row with its label and keeps a trailing slot through both toggle directions", () => {
    render(<LabelHarness />);
    openLabels();
    const expectSlots = (selectedNames: string[]) => {
      for (const row of list().getAllByRole("option")) {
        const name = row.querySelector("[title]")?.getAttribute("title") ?? "";
        expect(
          row.firstElementChild?.contains(within(row).getByTitle(name)),
        ).toBe(true);
        // The name may shrink, but must not paint over the trailing check.
        expect(row.firstElementChild?.className.split(/\s+/)).toEqual(
          expect.arrayContaining(["min-w-0", "overflow-hidden"]),
        );
        expect(row.lastElementChild?.className).toContain("ml-auto");
        expect(row.lastElementChild?.className).toContain("w-4");
        expect(row.lastElementChild?.childElementCount).toBe(
          selectedNames.includes(name) ? 1 : 0,
        );
      }
    };
    expectSlots(["needs-brainstorm", "area:cli"]);
    fireEvent.click(labelRow("needs-brainstorm"));
    expectSlots(["area:cli"]);
    fireEvent.click(labelRow("kind:bug"));
    expectSlots(["area:cli", "kind:bug"]);
  });
});

describe("LabelPicker filtering", () => {
  it("filters case-insensitively and ignores padding", () => {
    open();
    fireEvent.change(input(), { target: { value: "  WEB " } });
    expect(list().getByTitle("area:web")).toBeTruthy();
    expect(list().queryByTitle("kind:bug")).toBeNull();
  });

  it("renders rows with the prefix outside the value badge", () => {
    open();
    const row = list().getByRole("option", { name: /area:.*web/ });
    expect(within(row).getByText("area:")).toBeTruthy();
    expect(within(row).getByTitle("area:web").textContent).toBe("web");
  });

  it("toggles an existing label on click", () => {
    const onToggle = vi.fn();
    open({ onToggle });
    fireEvent.click(list().getByTitle("kind:bug"));
    expect(onToggle).toHaveBeenCalledWith(LABELS[2]);
  });
});

describe("LabelPicker near-duplicate guard", () => {
  it("warns instead of offering a plain create row", () => {
    open({ onCreate: vi.fn() });
    fireEvent.change(input(), { target: { value: "Area: Web" } });
    expect(screen.getByText(/Similar label exists/)).toBeTruthy();
    expect(screen.getByText(/create “Area: Web” anyway/)).toBeTruthy();
    expect(list().queryByText(/^Create “/)).toBeNull();
  });

  it("'use it' applies the existing label", () => {
    const onToggle = vi.fn();
    open({ onToggle, onCreate: vi.fn() });
    fireEvent.change(input(), { target: { value: "Area: Web" } });
    fireEvent.click(screen.getByText("use it"));
    expect(onToggle).toHaveBeenCalledWith(LABELS[0]);
  });

  it("an exact name is not a near-duplicate", () => {
    open({ onCreate: vi.fn() });
    fireEvent.change(input(), { target: { value: "area:web" } });
    expect(screen.queryByText(/Similar label exists/)).toBeNull();
  });
});

describe("LabelPicker creation", () => {
  it("suggests existing prefixes before the raw create row", () => {
    open({ onCreate: vi.fn() });
    fireEvent.change(input(), { target: { value: "docs" } });
    const texts = list()
      .getAllByRole("option")
      .map((r) => r.textContent);
    expect(texts).toEqual([
      "Create “area:docs”",
      "Create “kind:docs”",
      "Create “docs”",
    ]);
  });

  it("creates with the canonicalized name, then applies the result", async () => {
    const created: Label = { id: 9, name: "area:docs", color: "#f97316" };
    const onCreate = vi.fn().mockResolvedValue(created);
    const onToggle = vi.fn();
    open({ onCreate, onToggle });
    fireEvent.change(input(), { target: { value: "  area:docs " } });
    fireEvent.click(list().getByText("Create “area:docs”"));
    expect(onCreate).toHaveBeenCalledWith("area:docs");
    await vi.waitFor(() => expect(onToggle).toHaveBeenCalledWith(created));
  });

  it("offers no create affordance at all without onCreate", () => {
    open();
    fireEvent.change(input(), { target: { value: "docs" } });
    expect(list().queryByText(/Create “/)).toBeNull();
    expect(list().getByText("No matching labels")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "Area: Web" } });
    expect(screen.getByText("use it")).toBeTruthy();
    expect(screen.queryByText(/anyway/)).toBeNull();
  });
});

describe("LabelPicker selected chips", () => {
  it("removes a selected label from its ✕", () => {
    const onToggle = vi.fn();
    open({ selected: [LABELS[0] as Label], onToggle });
    fireEvent.click(screen.getByLabelText("remove area:web"));
    expect(onToggle).toHaveBeenCalledWith(LABELS[0]);
  });
});
