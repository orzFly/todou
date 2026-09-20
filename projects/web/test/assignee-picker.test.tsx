import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Member, UserKind } from "@todou/shared";
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
