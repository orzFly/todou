import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Label } from "@todou/shared";
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
