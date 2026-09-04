import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  Agent,
  AgentMembership,
  AgentMemberships,
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
      manageable_projects: [ALPHA, BETA, GAMMA],
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

  it("edits only the projects I administer", async () => {
    renderPage({
      memberships: [membership(ALPHA, "writer"), membership(OUTSIDE, "reader")],
      manageable_projects: [ALPHA, BETA],
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
      manageable_projects: [ALPHA, BETA, GAMMA],
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
      manageable_projects: [ALPHA, BETA],
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
      manageable_projects: [ALPHA],
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const dialog = await openDialog();

    fireEvent.keyDown(dialog.getByRole("combobox", { name: "role in Alpha" }), {
      key: "R",
    });

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("alpha", BOT.id, "reader"),
    );
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate);
      expect(keys).toContain(JSON.stringify(["agent-memberships"]));
      expect(keys).toContain(JSON.stringify(["members", "alpha"]));
    });
  });

  it("removes a membership and refreshes both sides", async () => {
    const spy = vi.spyOn(api, "removeMember").mockResolvedValue(undefined);
    const client = renderPage({
      memberships: [membership(ALPHA, "admin")],
      manageable_projects: [ALPHA],
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
