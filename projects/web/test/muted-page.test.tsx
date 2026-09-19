import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MuteList } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutesQuery } from "../src/api/mutes.ts";
import { api } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MutedPage } from "../src/pages/muted.tsx";
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
  vi.spyOn(api, "getMutes").mockResolvedValue(mutes);
  vi.spyOn(api, "getReferenceConfig").mockReturnValue(Promise.race([]));
  return { client, ...renderWithProviders(<MutedPage />, client) };
}

describe("muted page (T-380)", () => {
  it("renders a newer server mute mode without losing the unmute action", async () => {
    const mode = "future_mute_mode" as MuteList["issues"][number]["mode"];
    const mutes = {
      ...full,
      issues: full.issues.map((issue) => ({ ...issue, mode })),
    };
    mount(mutes);
    expect(
      await screen.findByText('unknown mute mode ("future_mute_mode")'),
    ).toBeTruthy();
    const row = screen.getByRole("link", { name: /noisy card/ }).closest("li");
    if (!row) throw new Error("Missing muted row");
    expect(within(row).getByRole("button", { name: "Unmute" })).toBeTruthy();
    expect(row.textContent).not.toContain("undefined");
  });

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

  it("shows a failure with raw detail and Retry fetches the list again", async () => {
    const get = vi.spyOn(api, "getMutes").mockRejectedValue(new Error("boom"));
    renderWithProviders(<MutedPage />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByTitle("boom").textContent).toBe(
      "Could not load the muted list: boom",
    );
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue({ issues: [], projects: [] });
    fireEvent.click(retry);
    await screen.findByText(/Nothing is muted/);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps the Inbox return link and draws skeletons while loading", async () => {
    vi.spyOn(api, "getMutes").mockReturnValue(Promise.race([]));
    const view = renderWithProviders(<MutedPage />);
    expect(
      (await screen.findByRole("link", { name: "Inbox" })).getAttribute("href"),
    ).toBe("/inbox");
    expect(
      view.container.querySelectorAll('[data-slot="skeleton"]'),
    ).toHaveLength(2);
    expect(screen.queryByText(/Nothing is muted/)).toBeNull();
  });

  it("uses the project's reference prefix, with a nonblocking #N fallback", async () => {
    const { client } = mount(full);
    const fallback = await screen.findByRole("link", {
      name: "Project #7 — noisy card",
    });
    expect(fallback.getAttribute("href")).toBe("/projects/p/issues/7");
    client.setQueryData(referenceConfigQuery("p").queryKey, {
      format: { prefix: "T", history: [] },
      autolinks: [],
    });
    await screen.findByRole("link", { name: "Project T-7 — noisy card" });
    expect(screen.queryByText(/Project #7/)).toBeNull();
  });

  it("renders both mute modes, section headings, and absolute mute times", async () => {
    mount({
      ...full,
      issues: [
        ...full.issues,
        {
          ...full.issues[0],
          number: 8,
          title: "temporary quiet",
          mode: "until_activity",
        },
      ],
    });
    await screen.findByRole("heading", { name: "Projects" });
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    expect(screen.getByText("Quiet until unmuted")).toBeTruthy();
    expect(screen.getByText("Quiet until new activity")).toBeTruthy();
    const project = screen.getByRole("link", { name: "Quiet Project" });
    expect(project.getAttribute("href")).toBe("/projects/q");
    for (const link of [
      project,
      screen.getByRole("link", { name: /noisy card/ }),
    ]) {
      const time = link.closest("li")?.querySelector("time");
      expect(time?.getAttribute("title")).toBe("2026-01-01T00:00:00Z");
      expect(time?.getAttribute("datetime")).toBe("2026-01-01T00:00:00Z");
    }
  });

  it.each(["project", "issue"] as const)(
    "removes an unmuted %s after the list refetch, leaving the other section",
    async (kind) => {
      const { client } = mount(full);
      const unmuteProject = vi
        .spyOn(api, "unmuteProject")
        .mockResolvedValue(undefined);
      const unmuteIssue = vi
        .spyOn(api, "unmuteIssue")
        .mockResolvedValue(undefined);
      const get = vi.mocked(api.getMutes);
      await screen.findByText(/noisy card/);
      const remaining =
        kind === "project"
          ? { projects: [], issues: full.issues }
          : { projects: full.projects, issues: [] };
      get.mockResolvedValue(remaining);
      const label = kind === "project" ? "Quiet Project" : /noisy card/;
      const row = screen.getByRole("link", { name: label }).closest("li");
      if (!row) throw new Error("Missing muted row");
      fireEvent.click(within(row).getByRole("button", { name: "Unmute" }));
      await waitFor(() =>
        expect(screen.queryByRole("link", { name: label })).toBeNull(),
      );
      expect(
        screen.queryByRole("heading", {
          name: kind === "project" ? "Projects" : "Issues",
        }),
      ).toBeNull();
      expect(
        screen.getByRole("heading", {
          name: kind === "project" ? "Issues" : "Projects",
        }),
      ).toBeTruthy();
      expect(client.getQueryData(mutesQuery.queryKey)).toEqual(remaining);
      expect(
        kind === "project" ? unmuteProject : unmuteIssue,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it("shows the empty state after unmuting the last row", async () => {
    mount({ projects: full.projects, issues: [] });
    vi.spyOn(api, "unmuteProject").mockResolvedValue(undefined);
    await screen.findByText("Quiet Project");
    vi.mocked(api.getMutes).mockResolvedValue({ issues: [], projects: [] });
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    await screen.findByText(/Nothing is muted/);
    expect(screen.queryByRole("button", { name: "Unmute" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Issues" })).toBeNull();
  });
});
