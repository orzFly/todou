import { fireEvent, waitFor, within } from "@testing-library/react";
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

function renderSettings(refBeforeTitle: boolean) {
  const client = testQueryClient();
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(prefsQuery.queryKey, {
    show_weak_unread: true,
    ref_before_title: refBeforeTitle,
  } satisfies MePrefs);
  const { container } = renderWithProviders(<ProfileSettingsPage />, client);
  return within(container);
}

describe("profile display preferences (T-153)", () => {
  // One render per case: the label reaches its switch by id, and a second
  // copy in the same document would steal the association.
  it("shows the toggle on while the ref leads", async () => {
    const view = renderSettings(true);
    expect(
      (await view.findByRole("switch", { name: "Number before title" })).dataset
        .state,
    ).toBe("checked");
  });

  it("shows the toggle off while the ref trails", async () => {
    const view = renderSettings(false);
    expect(
      (await view.findByRole("switch", { name: "Number before title" })).dataset
        .state,
    ).toBe("unchecked");
  });

  it("patches only its own key when toggled", async () => {
    const spy = vi.spyOn(api, "patchMyPrefs").mockResolvedValue({
      show_weak_unread: true,
      ref_before_title: false,
    });
    const view = renderSettings(true);
    fireEvent.click(
      await view.findByRole("switch", { name: "Number before title" }),
    );
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ ref_before_title: false }),
    );
  });
});
