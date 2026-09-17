import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  Agent,
  AgentMembership,
  AgentMemberships,
  ManageableProject,
  MemberRole,
  ProjectBrief,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMembershipsQuery, agentsQuery, api } from "../src/api/queries.ts";
import { AgentsSettingsPage } from "../src/pages/agents-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const BOT: Agent = {
  id: 42,
  login: "probe-bot",
  display_name: "Probe Bot",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "user" },
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-28T00:00:00Z",
  disabled_at: null,
};

const ALPHA: ProjectBrief = { id: 1, slug: "alpha", name: "Alpha" };
const BETA: ProjectBrief = { id: 2, slug: "beta", name: "Beta" };
const GAMMA: ProjectBrief = { id: 3, slug: "gamma", name: "Gamma" };
// A project the owner is not in — listed, but not editable from here.
const OUTSIDE: ProjectBrief = { id: 9, slug: "bobland", name: "Bobland" };

/**
 * A manageable entry carries the ceiling with it (T-340). Spelled at each
 * call site rather than defaulted, because a fixture that forgets it is the
 * rolling-release case — and the page is meant to go read-only there.
 */
const manageable = (
  project: ProjectBrief,
  my_role: MemberRole = "admin",
): ManageableProject => ({ ...project, my_role });

const membership = (
  project: ProjectBrief,
  role: MemberRole,
): AgentMembership => ({
  agent_id: BOT.id,
  project,
  role,
  created_at: "2026-08-28T00:00:00Z",
});

function renderPage(data: AgentMemberships | "error"): QueryClient {
  const client = testQueryClient();
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(agentsQuery.queryKey, [BOT]);
  if (data === "error") {
    vi.spyOn(api, "listAgentMemberships").mockRejectedValue(
      new Error("upstream is down"),
    );
  } else {
    client.setQueryData(agentMembershipsQuery.queryKey, data);
  }
  renderWithProviders(<AgentsSettingsPage />, client);
  return client;
}

async function openDialog() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage probe-bot's projects" }),
  );
  return within(await screen.findByRole("dialog"));
}

const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) =>
    JSON.stringify((call[0] as { queryKey?: unknown } | undefined)?.queryKey),
  );

describe("agent projects column (T-227)", () => {
  it("badges each project with its role and counts the overflow", async () => {
    renderPage({
      memberships: [
        membership(ALPHA, "admin"),
        membership(BETA, "writer"),
        membership(GAMMA, "reader"),
        membership(OUTSIDE, "writer"),
      ],
      manageable_projects: [ALPHA, BETA, GAMMA].map((p) => manageable(p)),
    });

    expect(await screen.findByTitle("Alpha · admin")).toBeTruthy();
    expect(screen.getByTitle("Beta · writer")).toBeTruthy();
    expect(screen.getByTitle("Gamma · reader")).toBeTruthy();
    // The fourth is behind the counter, not dropped.
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByTitle("Bobland · writer")).toBeNull();
  });

  it("says so when the agent is in no project", async () => {
    renderPage({ memberships: [], manageable_projects: [] });

    expect(await screen.findByText("No projects")).toBeTruthy();
  });

  it("degrades to a dash when the endpoint fails, without taking the page down", async () => {
    renderPage("error");

    const cell = await screen.findByTitle(/^Could not load projects: /);
    expect(cell.textContent).toBe("—");
    // The rest of the row is untouched.
    expect(screen.getByText("@probe-bot")).toBeTruthy();
  });

  it("collects the dialog's retry into the unified control (T-376)", async () => {
    // The column's dash stays as it is (its message lives on the title);
    // Column mount and the dialog body's error-retryOnMount both read this;
    // every call rejects until Retry, so the failure line is stable.
    const memberships = vi
      .spyOn(api, "listAgentMemberships")
      .mockRejectedValue(new Error("upstream is down"));
    const client = testQueryClient();
    client.setQueryData(agentsQuery.queryKey, [BOT]);
    renderWithProviders(<AgentsSettingsPage />, client);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Manage probe-bot's projects",
      }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("upstream is down")).toBeTruthy();
    memberships.mockResolvedValueOnce({
      memberships: [],
      manageable_projects: [],
    });
    fireEvent.click(dialog.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(memberships.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    // Recovered: the dialog's own empty-membership state.
    await dialog.findByText("Not a member of any project yet.");
    expect(dialog.queryByText("upstream is down")).toBeNull();
  });

  it("edits only the projects I administer", async () => {
    renderPage({
      memberships: [membership(ALPHA, "writer"), membership(OUTSIDE, "reader")],
      manageable_projects: [ALPHA, BETA].map((p) => manageable(p)),
    });
    const dialog = await openDialog();

    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }),
    ).toBeTruthy();
    expect(dialog.getByRole("button", { name: "remove Alpha" })).toBeTruthy();
    expect(
      dialog.queryByRole("combobox", { name: "role in Bobland" }),
    ).toBeNull();
    expect(dialog.queryByRole("button", { name: "remove Bobland" })).toBeNull();
    expect(dialog.getByText("read-only")).toBeTruthy();
  });

  it("offers only the projects I administer and have not joined", async () => {
    renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [ALPHA, BETA, GAMMA].map((p) => manageable(p)),
    });
    const dialog = await openDialog();

    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      {
        key: "ArrowDown",
      },
    );

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Beta",
      "Gamma",
    ]);
  });

  it("adds as writer on Add, never straight from the picker", async () => {
    const spy = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [ALPHA, BETA].map((p) => manageable(p)),
    });
    const dialog = await openDialog();

    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      {
        key: "B",
      },
    );
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("beta", BOT.id, "writer"),
    );
  });

  it("writes a role change and refreshes both sides of the membership", async () => {
    const spy = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    const client = renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [manageable(ALPHA)],
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await openDialog();

    // Typeahead lands on the first role starting with the letter, which is
    // reporter now that it sits above reader in the list.
    fireEvent.keyDown(dialog.getByRole("combobox", { name: "role in Alpha" }), {
      key: "R",
    });

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("alpha", BOT.id, "reporter"),
    );
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate);
      expect(keys).toContain(JSON.stringify(["agent-memberships"]));
      expect(keys).toContain(JSON.stringify(["members", "alpha"]));
    });
  });

  it("adds at my own role when that is below writer", async () => {
    const spy = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    renderPage({
      memberships: [],
      manageable_projects: [manageable(BETA, "reporter")],
    });
    const dialog = await openDialog();

    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      {
        key: "B",
      },
    );
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    // A reporter owner asking for writer would only find out at the 409.
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("beta", BOT.id, "reporter"),
    );
  });

  it("keeps the roles above my own out of an existing row", async () => {
    renderPage({
      memberships: [membership(ALPHA, "reader")],
      manageable_projects: [manageable(ALPHA, "reader")],
    });
    const dialog = await openDialog();

    // The clamp has to reach the joined row too: widening the manageable set
    // is what first shows a reader their own agent's row, and unclamped it
    // would still offer admin.
    fireEvent.keyDown(dialog.getByRole("combobox", { name: "role in Alpha" }), {
      key: "ArrowDown",
    });
    const disabled = Object.fromEntries(
      screen
        .getAllByRole("option")
        .map((o) => [o.textContent, o.getAttribute("aria-disabled")]),
    );
    expect(disabled).toMatchObject({
      admin: "true",
      writer: "true",
      reporter: "true",
      reader: null,
    });
  });

  it("goes read-only when the server never said what my role is", async () => {
    const spy = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    renderPage({
      memberships: [membership(ALPHA, "writer")],
      // A server from before `my_role`: nothing parses this at runtime, so
      // the missing field has to be caught by hand or the page computes a
      // ceiling from undefined.
      manageable_projects: [ALPHA, BETA] as never,
    });
    const dialog = await openDialog();

    expect(
      (
        dialog.getByRole("combobox", {
          name: "role in Alpha",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      {
        key: "B",
      },
    );
    expect(
      (dialog.getByRole("button", { name: "Add" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("removes a membership and refreshes both sides", async () => {
    const spy = vi.spyOn(api, "removeMember").mockResolvedValue(undefined);
    const client = renderPage({
      memberships: [membership(ALPHA, "admin")],
      manageable_projects: [manageable(ALPHA)],
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await openDialog();

    fireEvent.click(dialog.getByRole("button", { name: "remove Alpha" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("alpha", BOT.id));
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate);
      expect(keys).toContain(JSON.stringify(["agent-memberships"]));
      expect(keys).toContain(JSON.stringify(["members", "alpha"]));
    });
  });
});

describe("project icons in the agents table", () => {
  /** The chip for a project in the collapsed cell. */
  const chipFor = (name: string) =>
    screen.getAllByLabelText(new RegExp(`^${name} ·`)).at(0) as HTMLElement;

  it("draws no icon node on a 14px chip for a project with no icon", async () => {
    // Two fallback letters are a smudge at this size, and the chip already
    // carries the slug — so with no real image there is nothing to draw.
    renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [manageable(ALPHA)],
    });
    await screen.findByRole("button", { name: "Manage probe-bot's projects" });
    expect(chipFor("Alpha").querySelector('[data-slot="avatar"]')).toBeNull();
  });

  it("draws one on a chip for a project that has an icon", async () => {
    renderPage({
      memberships: [
        membership(
          { ...ALPHA, icon_url: "/api/projects/1/icon?v=a" },
          "writer",
        ),
      ],
      manageable_projects: [manageable(ALPHA)],
    });
    await screen.findByRole("button", { name: "Manage probe-bot's projects" });
    const icon = chipFor("Alpha").querySelector('[data-slot="avatar"]');
    expect(icon).not.toBeNull();
    // Square, so it never reads as one of the people elsewhere on this page.
    expect(icon?.getAttribute("data-shape")).toBe("square");
  });

  it("draws an icon on every dialog row, icon or not", async () => {
    // The 24px row has space for a fallback, so it is unconditional.
    renderPage({
      memberships: [membership(ALPHA, "writer"), membership(BETA, "reader")],
      manageable_projects: [manageable(ALPHA), manageable(BETA)],
    });
    await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(
      dialog.querySelectorAll('[data-slot="avatar"][data-shape="square"]'),
    ).toHaveLength(2);
  });
});
