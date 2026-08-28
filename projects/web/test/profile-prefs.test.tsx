import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Me, MePrefs } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, meQuery } from "../src/api/queries.ts";
import { ProfileSettingsPage } from "../src/pages/profile-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-28T00:00:00Z",
};

const DEFAULT_PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
};

function renderSettings(prefs: Partial<MePrefs> = {}) {
  const client = testQueryClient();
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(prefsQuery.queryKey, {
    ...DEFAULT_PREFS,
    ...prefs,
  } satisfies MePrefs);
  const { container } = renderWithProviders(<ProfileSettingsPage />, client);
  return within(container);
}

describe("profile display preferences (T-157)", () => {
  it("shows every surface's own placement", async () => {
    const view = renderSettings({ ref_placement_list: "after" });
    const value = async (name: string) =>
      (await view.findByRole("combobox", { name })).textContent;

    expect(await value("Issue lists & Inbox")).toContain("After title");
    expect(await value("Board cards")).toContain("On its own line");
    expect(await value("Issue page title")).toContain("Before title");
    expect(await value("Issue references")).toContain("Before title");
  });

  it("patches only the surface that changed", async () => {
    const spy = vi.spyOn(api, "patchMyPrefs").mockResolvedValue({
      ...DEFAULT_PREFS,
      ref_placement_board: "after",
    });
    const view = renderSettings();
    // Typeahead on the closed trigger, the same path a keyboard user takes:
    // "A" is the board's "After title, in the meta row".
    fireEvent.keyDown(
      await view.findByRole("combobox", { name: "Board cards" }),
      {
        key: "A",
      },
    );

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ ref_placement_board: "after" }),
    );
  });

  it("offers a third placement on the board alone", async () => {
    // A render apiece: only one listbox may be open at a time, and the
    // suite's auto-cleanup runs between tests, not inside one.
    const options = async (name: string) => {
      const view = renderSettings();
      fireEvent.keyDown(await view.findByRole("combobox", { name }), {
        key: "ArrowDown",
      });
      const labels = screen.getAllByRole("option").map((o) => o.textContent);
      cleanup();
      return labels;
    };

    expect(await options("Board cards")).toEqual([
      "Before title",
      "After title, in the meta row",
      "On its own line",
    ]);
    expect(await options("Issue page title")).toEqual([
      "Before title",
      "After title",
    ]);
  });

  it("patches a flat surface with its own key too", async () => {
    const spy = vi.spyOn(api, "patchMyPrefs").mockResolvedValue({
      ...DEFAULT_PREFS,
      ref_placement_detail: "after",
    });
    const view = renderSettings();
    fireEvent.keyDown(
      await view.findByRole("combobox", { name: "Issue page title" }),
      { key: "A" },
    );

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ ref_placement_detail: "after" }),
    );
  });

  it("still carries the weak-unread toggle", async () => {
    const view = renderSettings();
    expect(
      (await view.findByRole("switch", { name: "Weak unread hints" })).dataset
        .state,
    ).toBe("checked");
  });
});
