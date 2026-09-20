import { render, screen } from "@testing-library/react";
import type { Label, Member } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { AssigneePicker } from "../src/components/issue/assignee-picker.tsx";
import { LabelPicker } from "../src/components/issue/label-picker.tsx";
import { PICKER_ROW } from "../src/components/issue/picker-row.ts";

/**
 * The Labels and Assignees menus have to draw rows of the same height
 * (T-458). A pixel reading cannot say that here — happy-dom loads no
 * stylesheet, and even in a browser the same fixture has measured two
 * different heights at one width (T-445). What is checkable is that both
 * rows still resolve to the one constant: tailwind-merge keeps the last
 * `py-*` it is handed, so a hardcoded padding added after `PICKER_ROW` in
 * either picker drops its token out of the rendered class attribute.
 */

const LABELS: Label[] = [{ id: 1, name: "area:web", color: "#3b82f6" }];

const MEMBERS: Member[] = [
  {
    user: {
      id: 1,
      login: "alice",
      display_name: "Alice Kim",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const classesOf = (element: Element) => element.className.split(/\s+/);

describe("the Labels and Assignees rows (T-458)", () => {
  it("both carry every token of the shared geometry", () => {
    const tokens = PICKER_ROW.split(" ");
    // A constant that had been emptied would make the two assertions below
    // pass against anything.
    expect(tokens.length).toBeGreaterThan(0);

    const labels = render(
      <LabelPicker
        allLabels={LABELS}
        selected={[]}
        onToggle={() => {}}
        trigger={<button type="button">Edit labels</button>}
        defaultOpen
      />,
    );
    const labelRow = screen.getByRole("option", { name: /area:.*web/ });
    expect(classesOf(labelRow)).toEqual(expect.arrayContaining(tokens));
    labels.unmount();

    render(
      <AssigneePicker
        members={MEMBERS}
        selectedIds={[]}
        onToggle={() => {}}
        trigger={<button type="button">Edit assignees</button>}
        defaultOpen
      />,
    );
    const assigneeRow = screen.getByRole("menuitem", { name: /Alice Kim/ });
    expect(classesOf(assigneeRow)).toEqual(expect.arrayContaining(tokens));
  });
});
