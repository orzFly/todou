import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Issue, ReferenceConfig } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueMoreActions } from "../src/components/issue/more-actions-menu.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const SLUG = "p";

const prefixedConfig: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const issue = {
  id: 16,
  number: 16,
  title: "the card the menu acts on",
  body: "",
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-28T00:00:00Z",
  updated_at: "2026-08-28T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
} satisfies Issue;

/** The suite is offline by default, so both queries here degrade on a 404. */
async function mount() {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery(SLUG).queryKey, prefixedConfig);
  renderWithProviders(<IssueMoreActions slug={SLUG} issue={issue} />, client);
  return await screen.findByRole("button", { name: "More actions" });
}

async function openMenu() {
  const trigger = await mount();
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return trigger;
}

const entry = (name: RegExp) => screen.getByRole("menuitem", { name });

describe("IssueMoreActions", () => {
  it("keeps both entries behind the one trigger", async () => {
    await mount();
    expect(screen.queryByText(/Move to another project/)).toBeNull();
    expect(screen.queryByText(/Move to trash/)).toBeNull();

    await openMenu();
    expect(entry(/Move to another project/)).toBeTruthy();
    expect(entry(/Move to trash/)).toBeTruthy();
  });

  it("names the heading and the icon-only trigger apart", async () => {
    const trigger = await mount();
    // The trigger carries no visible text, so aria-label is its only name.
    expect(trigger.getAttribute("aria-label")).toBe("More actions");
    expect(screen.getByRole("heading", { name: "More actions" })).toBeTruthy();
  });

  it("orders the entries and marks the destructive one", async () => {
    await openMenu();
    const entries = screen.getAllByRole("menuitem");
    expect(entries.map((e) => e.textContent)).toEqual([
      "Move to another project…",
      "Move to trash…",
    ]);
    expect(entries[0]?.dataset.variant).toBe("default");
    expect(entries[1]?.dataset.variant).toBe("destructive");
  });

  it("opens the move dialog from the first entry", async () => {
    await openMenu();
    fireEvent.click(entry(/Move to another project/));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Move to another project")).toBeTruthy();
  });

  it("opens the trash confirmation, still naming the card", async () => {
    await openMenu();
    fireEvent.click(entry(/Move to trash/));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Move this issue to the trash?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/T-16 the card the menu acts on/),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Move to trash" }),
    ).toBeTruthy();
  });

  it("returns focus to the trigger when a dialog closes", async () => {
    const trigger = await openMenu();
    fireEvent.click(entry(/Move to trash/));
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });

    // Compare the element itself: `document.activeElement?.something` passes
    // vacuously while focus is nowhere, which is the failure being guarded.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
