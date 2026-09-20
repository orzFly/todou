import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Member, UserKind } from "@todou/shared";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AssigneePicker } from "../src/components/issue/assignee-picker.tsx";

function member(
  id: number,
  login: string,
  displayName: string,
  kind: UserKind,
  avatarUrl: string | null,
): Member {
  return {
    user: {
      id,
      login,
      display_name: displayName,
      kind,
      avatar_url: avatarUrl,
      owner: kind === "machine" ? { id: 1, login: "alice" } : null,
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
  };
}

// "Alice Kim" initials to AK and "Akira Sato" to AS: typing "ak" reaches one
// of them by display name and the other only by the initials fallback, which
// is what makes the typeahead case below able to fail.
const MEMBERS: Member[] = [
  member(1, "alice", "Alice Kim", "human", null),
  member(2, "akira", "Akira Sato", "human", "/avatars/2/v3.png"),
  member(3, "bot-one", "Bot One", "machine", null),
];

function open(props: Partial<Parameters<typeof AssigneePicker>[0]> = {}) {
  render(
    <AssigneePicker
      members={MEMBERS}
      selectedIds={[]}
      onToggle={() => {}}
      trigger={<button type="button">Edit assignees</button>}
      defaultOpen
      {...props}
    />,
  );
}

/** Every candidate row, in menu order. */
const rows = () => screen.getAllByRole("menuitem");
const rowFor = (name: RegExp) => screen.getByRole("menuitem", { name });

describe("AssigneePicker rows (T-353)", () => {
  it("draws an avatar on every row", () => {
    open();
    const found = rows().filter((r) => r.querySelector('[data-slot="avatar"]'));
    expect(found.length).toBe(MEMBERS.length);
  });

  it("falls back to the display name's initials without an avatar", () => {
    open();
    expect(within(rowFor(/Alice Kim/)).getByText("AK")).toBeTruthy();
    expect(within(rowFor(/Bot One/)).getByText("BO")).toBeTruthy();
  });

  it("badges machine users and leaves humans unbadged", () => {
    open();
    expect(
      rowFor(/Bot One/).querySelector('[aria-label="agent"]'),
    ).toBeTruthy();
    expect(
      rowFor(/Alice Kim/).querySelector('[aria-label="agent"]'),
    ).toBeNull();
  });

  it("hides the avatar from screen readers but keeps the badge labelled", () => {
    open();
    const row = rowFor(/Bot One/);
    expect(
      row.querySelector('[data-slot="avatar"]')?.getAttribute("aria-hidden"),
    ).toBe("true");
    const badge = row.querySelector('[aria-label="agent"]');
    expect(badge?.closest("[aria-hidden='true']")).toBeNull();
  });
});

describe("AssigneePicker selection (T-353)", () => {
  it("reports the toggled user and marks the selected rows", () => {
    const onToggle = vi.fn();
    open({ selectedIds: [2], onToggle });

    // The check sits alone in the row's trailing slot (T-458), so its presence
    // is the child count there — no dependence on the icon library's class
    // names.
    expect(rowFor(/Akira Sato/).lastElementChild?.childElementCount).toBe(1);
    expect(rowFor(/Alice Kim/).lastElementChild?.childElementCount).toBe(0);

    fireEvent.click(rowFor(/Alice Kim/));
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it("opens every row with the avatar, leaving no gutter on the left", () => {
    open({ selectedIds: [2] });
    // What the leading slot used to be: an empty span on every unpicked row.
    // Reading the avatar off the first child is what fails if one comes back.
    for (const row of rows()) {
      const lead = row.firstElementChild as HTMLElement;
      const avatar =
        lead.matches('[data-slot="avatar"]') ||
        lead.querySelector('[data-slot="avatar"]') !== null;
      expect(avatar).toBe(true);
    }
  });

  it("keeps the trailing slot on unpicked rows so the menu cannot resize", () => {
    open({ selectedIds: [2] });
    // A slot that only existed once picked would take the menu's width with
    // it; every row carries one, empty or not.
    for (const row of rows()) {
      expect(row.lastElementChild?.className).toContain("w-4");
    }
  });
});

describe("AssigneePicker typeahead (T-353)", () => {
  it("jumps by display name, not by the initials fallback", async () => {
    open();
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "a" });
    fireEvent.keyDown(menu, { key: "k" });
    // Radix moves the focus from a setTimeout, so reading it synchronously
    // would find the menu itself and pass whatever the rows say.
    await waitFor(() =>
      expect(document.activeElement).toBe(rowFor(/Akira Sato/)),
    );
  });
});

// Both partitions run backwards alphabetically and numerically. The selected
// IDs also run opposite to their source order, so neither sorting by name/ID
// nor iterating selectedIds can accidentally produce the expected rows.
const ORDER_MEMBERS: Member[] = [
  member(3, "charlie", "Charlie", "human", null),
  member(4, "delta", "Delta", "human", null),
  member(1, "alpha", "Alpha", "human", null),
  member(2, "bravo", "Bravo", "human", null),
];
const OPEN_ORDER: [number, string][] = [
  [4, "Delta"],
  [2, "Bravo"],
  [3, "Charlie"],
  [1, "Alpha"],
];

function StatefulPicker({
  members = ORDER_MEMBERS,
  freshSelectedIds = false,
}: {
  members?: Member[];
  freshSelectedIds?: boolean;
}) {
  const [selectedIds, setSelectedIds] = useState([2, 4]);
  return (
    <AssigneePicker
      members={members}
      selectedIds={freshSelectedIds ? [...selectedIds] : selectedIds}
      onToggle={(id) =>
        setSelectedIds((current) =>
          current.includes(id)
            ? current.filter((selectedId) => selectedId !== id)
            : [...current, id],
        )
      }
      trigger={<button type="button">Edit assignees</button>}
    />
  );
}

function openFromTrigger() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Edit assignees" }), {
    key: "Enter",
  });
}

function expectPickerRows(
  expected: [number, string][],
  selectedIds: number[],
  members = ORDER_MEMBERS,
) {
  const found = rows();
  expect(
    found.map((row) => {
      // Resolve IDs through the visible, unique login; React keys are not DOM
      // attributes. Read the displayed name independently of the fixture.
      const login = within(row).getByText(/^@/).textContent?.slice(1);
      return [
        members.find((candidate) => candidate.user.login === login)?.user.id,
        row.children[1]?.textContent,
      ];
    }),
  ).toEqual(expected);
  expect(found.map((row) => row.lastElementChild?.childElementCount)).toEqual(
    expected.map(([id]) => (selectedIds.includes(id) ? 1 : 0)),
  );
}

function toggleWhileOpen() {
  expectPickerRows(OPEN_ORDER, [2, 4]);
  fireEvent.click(rowFor(/Alpha/));
  expectPickerRows(OPEN_ORDER, [2, 4, 1]);
  fireEvent.click(rowFor(/Delta/));
  expectPickerRows(OPEN_ORDER, [2, 1]);
}

describe("AssigneePicker ordering (T-479)", () => {
  it("opens selected-first in source order, keeps toggled rows still, and resamples on reopening", () => {
    render(<StatefulPicker />);
    expect(screen.queryByRole("menu")).toBeNull();
    openFromTrigger();
    toggleWhileOpen();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Edit assignees" })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    openFromTrigger();
    expectPickerRows(
      [
        [1, "Alpha"],
        [2, "Bravo"],
        [3, "Charlie"],
        [4, "Delta"],
      ],
      [2, 1],
    );
  });

  it("keeps the opening order when selectedIds gets a fresh identity after toggles", () => {
    const { rerender } = render(<StatefulPicker />);
    openFromTrigger();
    toggleWhileOpen();

    // Membership is still [2, 1]; a new snapshot would move Alpha to the top.
    rerender(<StatefulPicker freshSelectedIds />);
    expectPickerRows(OPEN_ORDER, [2, 1]);
  });

  it("keeps the opening order with fresh candidate arrays and objects but renders refreshed metadata", () => {
    const { rerender } = render(<StatefulPicker />);
    openFromTrigger();
    toggleWhileOpen();

    rerender(<StatefulPicker members={[...ORDER_MEMBERS]} />);
    expectPickerRows(OPEN_ORDER, [2, 1]);

    const refreshed = ORDER_MEMBERS.map((candidate) => ({
      ...candidate,
      user: {
        ...candidate.user,
        ...(candidate.user.id === 4
          ? { display_name: "Delta Updated", login: "delta-updated" }
          : {}),
      },
    }));
    rerender(<StatefulPicker members={refreshed} />);
    expectPickerRows(
      [
        [4, "Delta Updated"],
        [2, "Bravo"],
        [3, "Charlie"],
        [1, "Alpha"],
      ],
      [2, 1],
      refreshed,
    );
    expect(
      within(rowFor(/Delta Updated/)).getByText("@delta-updated"),
    ).toBeTruthy();
    expect(screen.queryByText("Delta", { exact: true })).toBeNull();
    expect(screen.queryByText("@delta", { exact: true })).toBeNull();
  });

  it("resamples the current selection when a candidate is added while open", () => {
    const { rerender } = render(<StatefulPicker />);
    openFromTrigger();
    toggleWhileOpen();

    const expanded = [
      member(5, "echo", "Echo", "human", null),
      ...ORDER_MEMBERS,
    ];
    rerender(<StatefulPicker members={expanded} />);
    expectPickerRows(
      [
        [1, "Alpha"],
        [2, "Bravo"],
        [5, "Echo"],
        [3, "Charlie"],
        [4, "Delta"],
      ],
      [2, 1],
      expanded,
    );
  });

  it("resamples current selection on removal and same-length candidate replacement", () => {
    const { rerender } = render(<StatefulPicker />);
    openFromTrigger();
    toggleWhileOpen();

    const reduced = ORDER_MEMBERS.filter(
      (candidate) => candidate.user.id !== 2,
    );
    rerender(<StatefulPicker members={reduced} />);
    expectPickerRows(
      [
        [1, "Alpha"],
        [3, "Charlie"],
        [4, "Delta"],
      ],
      [2, 1],
      reduced,
    );
    expect(screen.queryByRole("menuitem", { name: /Bravo/ })).toBeNull();

    fireEvent.click(rowFor(/Alpha/));
    expectPickerRows(
      [
        [1, "Alpha"],
        [3, "Charlie"],
        [4, "Delta"],
      ],
      [2],
      reduced,
    );
    fireEvent.click(rowFor(/Delta/));
    expectPickerRows(
      [
        [1, "Alpha"],
        [3, "Charlie"],
        [4, "Delta"],
      ],
      [2, 4],
      reduced,
    );

    // The length stays at three, but changed IDs must sample the selection
    // again: Delta moves ahead of Alpha only at this candidate refresh.
    const replaced = reduced.map((candidate) =>
      candidate.user.id === 3
        ? member(5, "echo", "Echo", "human", null)
        : candidate,
    );
    rerender(<StatefulPicker members={replaced} />);
    expectPickerRows(
      [
        [4, "Delta"],
        [5, "Echo"],
        [1, "Alpha"],
      ],
      [2, 4],
      replaced,
    );
    expect(screen.queryByRole("menuitem", { name: /Charlie/ })).toBeNull();
  });
});
