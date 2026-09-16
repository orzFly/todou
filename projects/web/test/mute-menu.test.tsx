import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { IssueMuteMode, MuteList } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutesQuery } from "../src/api/mutes.ts";
import { api } from "../src/api/queries.ts";
import { MuteMenu } from "../src/components/issue/mute-menu.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const list = (mode: IssueMuteMode | null, projectMuted = false): MuteList => ({
  issues:
    mode === null
      ? []
      : [
          {
            project: { slug: "p", name: "Project" },
            number: 7,
            title: "card",
            mode,
            muted_at: "2026-01-01T00:00:00Z",
          },
        ],
  projects: projectMuted
    ? [{ slug: "p", name: "Project", muted_at: "2026-01-01T00:00:00Z" }]
    : [],
});

/** Mount with the mutes cache pre-seeded — no fetch, no suspense hang. */
async function mount(mutes: MuteList) {
  const client = testQueryClient();
  client.setQueryData(mutesQuery.queryKey, mutes);
  renderWithProviders(<MuteMenu slug="p" issueNumber={7} />, client);
  const trigger = await screen.findByRole("button");
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  return trigger;
}

const entry = (name: RegExp) => screen.getByRole("menuitem", { name });

describe("MuteMenu (T-372)", () => {
  it("checks the stored setting, whichever of the three it is", async () => {
    await mount(list("forever"));
    expect(
      entry(/Quiet until unmuted/).querySelector("svg.ml-auto"),
    ).toBeTruthy();
    expect(
      entry(/Quiet until new activity/).querySelector("svg.ml-auto"),
    ).toBeNull();
  });

  it("checks quiet-until-new-activity when that is the setting", async () => {
    await mount(list("until_activity"));
    expect(
      entry(/Quiet until new activity/).querySelector("svg.ml-auto"),
    ).toBeTruthy();
    expect(
      entry(/Quiet until unmuted/).querySelector("svg.ml-auto"),
    ).toBeNull();
  });

  it("checks notify when nothing is set", async () => {
    await mount(list(null));
    expect(
      entry(/Notify on new activity/).querySelector("svg.ml-auto"),
    ).toBeTruthy();
  });
  it("picks until_activity when quiet-until-new-activity is chosen", async () => {
    const mute = vi
      .spyOn(api, "muteIssue")
      .mockResolvedValue(undefined as unknown as void);
    await mount(list(null));
    fireEvent.click(entry(/Quiet until new activity/));
    await waitFor(() =>
      expect(mute).toHaveBeenCalledWith("p", 7, { mode: "until_activity" }),
    );
  });

  it("picks forever when quiet-until-unmuted is chosen", async () => {
    const mute = vi
      .spyOn(api, "muteIssue")
      .mockResolvedValue(undefined as unknown as void);
    await mount(list(null));
    fireEvent.click(entry(/Quiet until unmuted/));
    await waitFor(() =>
      expect(mute).toHaveBeenCalledWith("p", 7, { mode: "forever" }),
    );
  });

  it("clears the row when notify is chosen", async () => {
    const unmute = vi
      .spyOn(api, "unmuteIssue")
      .mockResolvedValue(undefined as unknown as void);
    await mount(list("forever"));
    fireEvent.click(entry(/Notify on new activity/));
    await waitFor(() => expect(unmute).toHaveBeenCalledWith("p", 7));
  });

  it("explains when the whole project is muted", async () => {
    await mount(list("forever", true));
    expect(await screen.findByText(/whole project is muted/)).toBeTruthy();
  });
});
