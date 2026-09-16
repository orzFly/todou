import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { MuteList } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutesQuery } from "../src/api/mutes.ts";
import { api } from "../src/api/queries.ts";
import { MutedSection } from "../src/pages/profile-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const full: MuteList = {
  issues: [
    {
      project: { slug: "p", name: "Project" },
      number: 7,
      title: "noisy card",
      mode: "forever",
      muted_at: "2026-01-01T00:00:00Z",
    },
  ],
  projects: [
    { slug: "q", name: "Quiet Project", muted_at: "2026-01-01T00:00:00Z" },
  ],
};

/** Mount with the mutes cache pre-seeded — no fetch, no suspense hang. */
function mount(mutes: MuteList) {
  const client = testQueryClient();
  client.setQueryData(mutesQuery.queryKey, mutes);
  renderWithProviders(<MutedSection />, client);
}

describe("profile settings Muted section (T-372)", () => {
  it("renders both lists and unmutes the project from its row", async () => {
    const unmuteProject = vi
      .spyOn(api, "unmuteProject")
      .mockResolvedValue(undefined);

    mount(full);
    expect(await screen.findByText("Quiet Project")).toBeTruthy();
    expect(await screen.findByText(/noisy card/)).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Unmute" })[0] as HTMLElement,
    );
    await waitFor(() => expect(unmuteProject).toHaveBeenCalledWith("q"));
  });

  it("unmutes the card from its row", async () => {
    const unmuteIssue = vi
      .spyOn(api, "unmuteIssue")
      .mockResolvedValue(undefined);

    mount(full);
    await screen.findByText(/noisy card/);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Unmute" })[1] as HTMLElement,
    );
    await waitFor(() => expect(unmuteIssue).toHaveBeenCalledWith("p", 7));
  });

  it("states it plainly when nothing is muted", async () => {
    mount({ issues: [], projects: [] });
    expect(await screen.findByText(/Nothing is muted/)).toBeTruthy();
  });
});
