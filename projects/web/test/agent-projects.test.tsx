import type { QueryClient } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Agent,
  AgentMembership,
  AgentMemberships,
  ManageableProject,
  MemberRole,
  ProjectBrief,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMembershipsQuery, agentsQuery, api } from "../src/api/queries.ts";
import { AgentProjectsSection } from "../src/components/shared/agent-projects.tsx";
import { AgentsSettingsPage } from "../src/pages/agents-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

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
const OTHER_BOT: Agent = {
  ...BOT,
  id: 43,
  login: "other-bot",
  display_name: "Other Bot",
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
  ...args:
    | [project: ProjectBrief, role: MemberRole]
    | [agent: Agent, project: ProjectBrief, role: MemberRole]
): AgentMembership => {
  const [agent, project, role]: [Agent, ProjectBrief, MemberRole] =
    args.length === 2 ? [BOT, args[0], args[1]] : args;
  return {
    agent_id: agent.id,
    project,
    role,
    created_at: "2026-08-28T00:00:00Z",
  };
};

function renderPage(
  data: AgentMemberships | "error",
  agents: Agent[] = [BOT],
): QueryClient {
  const client = testQueryClient();
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(agentsQuery.queryKey, agents);
  if (data === "error") {
    vi.spyOn(api, "listAgentMemberships").mockRejectedValue(
      new Error("upstream is down"),
    );
  } else {
    client.setQueryData(agentMembershipsQuery.queryKey, data);
  }
  renderWithProviders(<ListAndAgentPage agents={agents} />, client);
  return client;
}

/**
 * The list beside one agent's Projects section, both live at once, the way
 * the two pages share one cache entry across a navigation. A row's link
 * would unmount the list, so the section is opened from a test-only button.
 */
function ListAndAgentPage({ agents }: { agents: Agent[] }) {
  const [open, setOpen] = useState<Agent | null>(null);
  return (
    <>
      <AgentsSettingsPage />
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => setOpen(agent)}>
          Open {agent.login}'s page
        </button>
      ))}
      {open !== null && <AgentProjectsSection agent={open} />}
    </>
  );
}

async function openAgentPage(login = "probe-bot") {
  fireEvent.click(
    await screen.findByRole("button", { name: `Open ${login}'s page` }),
  );
  return within(
    await screen.findByRole("region", { name: `Projects for ${login}` }),
  );
}

const invalidatedKeys = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((call) =>
    JSON.stringify((call[0] as { queryKey?: unknown } | undefined)?.queryKey),
  );

async function failWarmMemberships(
  client: QueryClient,
  status: number,
  message: string,
) {
  await waitFor(() =>
    expect(
      client.getQueryState(agentMembershipsQuery.queryKey)?.fetchStatus,
    ).toBe("idle"),
  );
  const memberships = vi
    .spyOn(api, "listAgentMemberships")
    .mockRejectedValue(Object.assign(new Error(message), { status }));
  await act(async () => {
    await client.refetchQueries({
      queryKey: agentMembershipsQuery.queryKey,
      exact: true,
    });
  });
  expect(memberships).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(client.getQueryState(agentMembershipsQuery.queryKey)?.status).toBe(
      "error",
    ),
  );
  return memberships;
}

function agentRow(login: string) {
  return within(screen.getByText(`@${login}`).closest("tr") as HTMLElement);
}

async function tableSurface() {
  const table = await screen.findByRole("table");
  return within(table.closest(".space-y-4") as HTMLElement);
}

describe("agent projects column (T-227)", () => {
  it("keeps a legal long login in the title and requires Add to grant a project", async () => {
    const longAgent = { ...BOT, login: "a".repeat(64) };
    const setMember = vi.spyOn(api, "setMember").mockResolvedValue(undefined);
    renderPage(
      {
        memberships: [
          membership(longAgent, ALPHA, "writer"),
          membership(longAgent, OUTSIDE, "reader"),
        ],
        manageable_projects: [manageable(ALPHA), manageable(BETA)],
      },
      [longAgent],
    );
    const dialog = await openAgentPage(longAgent.login);
    expect(dialog.getByText("read-only")).toBeTruthy();
    expect(
      dialog.queryByRole("combobox", { name: "role in Bobland" }),
    ).toBeNull();
    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Project to add" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
    expect(setMember).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(setMember).toHaveBeenCalledExactlyOnceWith(
        BETA.slug,
        longAgent.id,
        "writer",
      ),
    );
  });

  it("draws an icon per project with its role, and counts past four", async () => {
    const DELTA: ProjectBrief = { id: 4, slug: "delta", name: "Delta" };
    renderPage({
      memberships: [
        membership(ALPHA, "admin"),
        membership(BETA, "writer"),
        membership(GAMMA, "reader"),
        membership(OUTSIDE, "writer"),
        membership(DELTA, "reporter"),
      ],
      manageable_projects: [ALPHA, BETA, GAMMA].map((p) => manageable(p)),
    });

    expect(await screen.findByTitle("Alpha · admin")).toBeTruthy();
    expect(screen.getByTitle("Beta · writer")).toBeTruthy();
    expect(screen.getByTitle("Gamma · reader")).toBeTruthy();
    expect(screen.getByTitle("Bobland · writer")).toBeTruthy();
    // The fifth is in the count, not drawn.
    expect(screen.queryByTitle("Delta · reporter")).toBeNull();
    expect(agentRow("probe-bot").getByText("5 projects")).toBeTruthy();
  });

  it("names the project when there is only one", async () => {
    renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [manageable(ALPHA)],
    });

    expect(await screen.findByTitle("Alpha · writer")).toBeTruthy();
    expect(agentRow("probe-bot").getByText("Alpha")).toBeTruthy();
  });

  it("says so when the agent is in no project", async () => {
    renderPage({ memberships: [], manageable_projects: [] });

    expect(await screen.findByText("Not in any project")).toBeTruthy();
  });

  // T-704: the empty row was plain grey text the user could not tell was
  // clickable. Every row — the empty one included — is a link to the
  // agent's page, so the gesture and the browser's link affordances agree.
  it("links every row to the agent's page, the empty one included", async () => {
    renderPage(
      {
        memberships: [membership(OTHER_BOT, ALPHA, "writer")],
        manageable_projects: [manageable(ALPHA)],
      },
      [BOT, OTHER_BOT],
    );
    await screen.findByText("Not in any project");

    const hrefsIn = (login: string) =>
      [
        ...(
          screen.getByText(`@${login}`).closest("tr") as HTMLElement
        ).querySelectorAll("a"),
      ].map((a) => a.getAttribute("href"));

    expect(hrefsIn("probe-bot")).toEqual(
      Array(3).fill("/settings/agents/probe-bot"),
    );
    expect(hrefsIn("other-bot")).toEqual(
      Array(3).fill("/settings/agents/other-bot"),
    );
    // One stop per row for keyboard and screen-reader users.
    const focusable = (login: string) =>
      [
        ...(
          screen.getByText(`@${login}`).closest("tr") as HTMLElement
        ).querySelectorAll("a"),
      ].filter((a) => a.tabIndex >= 0 || !a.hasAttribute("aria-hidden"));
    expect(focusable("probe-bot")).toHaveLength(1);
  });

  it("degrades to a dash when the endpoint fails, without taking the page down", async () => {
    renderPage("error");

    const cell = await screen.findByTitle(/^Could not load projects: /);
    expect(cell.textContent).toBe("—");
    // The rest of the row is untouched.
    expect(screen.getByText("@probe-bot")).toBeTruthy();
  });

  it("keeps each agent's project badges after a warm-cache transient refetch failure", async () => {
    const client = renderPage(
      {
        memberships: [
          membership(BOT, ALPHA, "admin"),
          membership(OTHER_BOT, ALPHA, "admin"),
        ],
        manageable_projects: [manageable(ALPHA)],
      },
      [BOT, OTHER_BOT],
    );
    const table = await screen.findByRole("table");
    const tableSurface = within(table.closest(".space-y-4") as HTMLElement);
    const probeRow = within(
      screen.getByText("@probe-bot").closest("tr") as HTMLElement,
    );
    const otherRow = within(
      screen.getByText("@other-bot").closest("tr") as HTMLElement,
    );
    expect(probeRow.getByTitle("Alpha · admin")).toBeTruthy();
    expect(otherRow.getByTitle("Alpha · admin")).toBeTruthy();
    await waitFor(() =>
      expect(
        client.getQueryState(agentMembershipsQuery.queryKey)?.fetchStatus,
      ).toBe("idle"),
    );

    const memberships = vi.spyOn(api, "listAgentMemberships").mockRejectedValue(
      Object.assign(new Error("memberships temporarily unavailable"), {
        status: 500,
      }),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: agentMembershipsQuery.queryKey,
        exact: true,
      });
    });
    expect(memberships).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(client.getQueryState(agentMembershipsQuery.queryKey)?.status).toBe(
        "error",
      ),
    );

    // Both rows have an identical badge: a badge in the other row cannot
    // accidentally satisfy the assertion for probe-bot.
    expectVisible(probeRow.getByTitle("Alpha · admin"));
    expectVisible(otherRow.getByTitle("Alpha · admin"));
    const notice = await tableSurface.findByRole("status");
    expect(notice.textContent).toMatch(/Couldn't refresh.*projects/i);
    expect(notice.textContent).toContain("memberships temporarily unavailable");
    expect(tableSurface.getAllByRole("status")).toHaveLength(1);
    expect(tableSurface.getAllByRole("button", { name: "Retry" })).toHaveLength(
      1,
    );
  });

  it("keeps the agent page's own project and role after a warm-cache transient refetch failure", async () => {
    const client = renderPage(
      {
        memberships: [
          membership(BOT, ALPHA, "writer"),
          membership(OTHER_BOT, ALPHA, "admin"),
        ],
        manageable_projects: [manageable(ALPHA)],
      },
      [BOT, OTHER_BOT],
    );
    const dialog = await openAgentPage();
    expect(dialog.getByText("Alpha")).toBeTruthy();
    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }).textContent,
    ).toContain("writer");
    await waitFor(() =>
      expect(
        client.getQueryState(agentMembershipsQuery.queryKey)?.fetchStatus,
      ).toBe("idle"),
    );

    const memberships = vi.spyOn(api, "listAgentMemberships").mockRejectedValue(
      Object.assign(new Error("memberships temporarily unavailable"), {
        status: 500,
      }),
    );
    await act(async () => {
      await client.refetchQueries({
        queryKey: agentMembershipsQuery.queryKey,
        exact: true,
      });
    });
    expect(memberships).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(client.getQueryState(agentMembershipsQuery.queryKey)?.status).toBe(
        "error",
      ),
    );

    // A badge in the table or another agent's row does not count as the
    // open dialog's membership surviving this failure.
    expectVisible(dialog.getByText("Alpha"));
    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }).textContent,
    ).toContain("writer");
    const notice = await dialog.findByRole("status");
    expect(notice.textContent).toContain("memberships temporarily unavailable");
    expect(dialog.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("retries the shared query from the agent page once and updates both rows and the page", async () => {
    const client = renderPage(
      {
        memberships: [
          membership(BOT, ALPHA, "writer"),
          membership(OTHER_BOT, BETA, "admin"),
        ],
        manageable_projects: [manageable(ALPHA), manageable(BETA)],
      },
      [BOT, OTHER_BOT],
    );
    const table = await tableSurface();
    const dialog = await openAgentPage();
    const probeRow = agentRow("probe-bot");
    const otherRow = agentRow("other-bot");
    expect(probeRow.getByTitle("Alpha · writer")).toBeTruthy();
    expect(otherRow.getByTitle("Beta · admin")).toBeTruthy();
    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }).textContent,
    ).toContain("writer");

    const memberships = await failWarmMemberships(
      client,
      500,
      "memberships temporarily unavailable",
    );
    expect(dialog.getAllByRole("status")).toHaveLength(1);
    expect(dialog.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    memberships.mockResolvedValue({
      memberships: [
        membership(BOT, ALPHA, "admin"),
        membership(OTHER_BOT, BETA, "reader"),
      ],
      manageable_projects: [manageable(ALPHA), manageable(BETA)],
    });

    const beforeRetry = memberships.mock.calls.length;
    fireEvent.click(dialog.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(memberships.mock.calls.length - beforeRetry).toBe(1),
    );
    await waitFor(() =>
      expect(probeRow.getByTitle("Alpha · admin")).toBeTruthy(),
    );
    expect(otherRow.getByTitle("Beta · reader")).toBeTruthy();
    expect(probeRow.queryByTitle("Alpha · writer")).toBeNull();
    expect(otherRow.queryByTitle("Beta · admin")).toBeNull();
    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }).textContent,
    ).toContain("admin");
    expect(dialog.queryByRole("status")).toBeNull();
    expect(table.queryByRole("status")).toBeNull();
    expect(memberships.mock.calls.length - beforeRetry).toBe(1);
  });

  it("disables both retry controls during one pending refetch without hiding saved memberships", async () => {
    const client = renderPage(
      {
        memberships: [
          membership(BOT, ALPHA, "writer"),
          membership(OTHER_BOT, BETA, "reader"),
        ],
        manageable_projects: [manageable(ALPHA), manageable(BETA)],
      },
      [BOT, OTHER_BOT],
    );
    const table = await tableSurface();
    const dialog = await openAgentPage();
    const probeRow = agentRow("probe-bot");
    const otherRow = agentRow("other-bot");
    const memberships = await failWarmMemberships(
      client,
      500,
      "temporary outage",
    );
    let finishRetry!: (data: AgentMemberships) => void;
    memberships.mockImplementationOnce(
      () =>
        new Promise<AgentMemberships>((resolve) => {
          finishRetry = resolve;
        }),
    );

    const beforeRetry = memberships.mock.calls.length;
    fireEvent.click(dialog.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(memberships.mock.calls.length - beforeRetry).toBe(1),
    );
    await waitFor(() => {
      expect(
        (
          table.getByRole("button", {
            name: "Retry",
            hidden: true,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (dialog.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    expect(probeRow.getByTitle("Alpha · writer")).toBeTruthy();
    expect(otherRow.getByTitle("Beta · reader")).toBeTruthy();
    expect(
      dialog.getByRole("combobox", { name: "role in Alpha" }).textContent,
    ).toContain("writer");
    expect(table.getAllByRole("status", { hidden: true })).toHaveLength(1);
    expect(dialog.getAllByRole("status")).toHaveLength(1);
    await act(async () => {
      finishRetry({
        memberships: [
          membership(BOT, ALPHA, "writer"),
          membership(OTHER_BOT, BETA, "reader"),
        ],
        manageable_projects: [manageable(ALPHA), manageable(BETA)],
      });
    });
    await waitFor(() => expect(dialog.queryByRole("status")).toBeNull());
    expect(table.queryByRole("status")).toBeNull();
    expect(memberships.mock.calls.length - beforeRetry).toBe(1);
  });

  it.each([403, 404])(
    "removes both rows' badges and the open dialog's rows on a %i refusal",
    async (status) => {
      const client = renderPage(
        {
          memberships: [
            membership(BOT, ALPHA, "writer"),
            membership(OTHER_BOT, BETA, "admin"),
          ],
          manageable_projects: [manageable(ALPHA), manageable(BETA)],
        },
        [BOT, OTHER_BOT],
      );
      const table = await tableSurface();
      const dialog = await openAgentPage();
      const probeRow = agentRow("probe-bot");
      const otherRow = agentRow("other-bot");
      expect(probeRow.getByTitle("Alpha · writer")).toBeTruthy();
      expect(otherRow.getByTitle("Beta · admin")).toBeTruthy();
      expect(
        dialog.getByRole("combobox", { name: "role in Alpha" }),
      ).toBeTruthy();

      await failWarmMemberships(
        client,
        status,
        `membership access refused (${status})`,
      );
      await waitFor(() => {
        expect(probeRow.queryByTitle("Alpha · writer")).toBeNull();
        expect(otherRow.queryByTitle("Beta · admin")).toBeNull();
        expect(
          dialog.queryByRole("combobox", { name: "role in Alpha" }),
        ).toBeNull();
      });
      expect(probeRow.getByTitle(/^Could not load projects:/)).toBeTruthy();
      expect(otherRow.getByTitle(/^Could not load projects:/)).toBeTruthy();
      expect(dialog.queryByText("Alpha")).toBeNull();
      expect(
        dialog.getByText(`membership access refused (${status})`),
      ).toBeTruthy();
      expect(dialog.queryByText("Not a member of any project yet.")).toBeNull();
      expect(table.queryByRole("status")).toBeNull();
    },
  );

  it("keeps Not in any project and a single table notice after an empty success followed by a 500", async () => {
    const client = renderPage({ memberships: [], manageable_projects: [] }, [
      BOT,
      OTHER_BOT,
    ]);
    const table = await tableSurface();
    const probeRow = agentRow("probe-bot");
    const otherRow = agentRow("other-bot");
    expect(probeRow.getByText("Not in any project")).toBeTruthy();
    expect(otherRow.getByText("Not in any project")).toBeTruthy();

    await failWarmMemberships(
      client,
      500,
      "empty catalog temporarily unavailable",
    );
    expect(probeRow.getByText("Not in any project")).toBeTruthy();
    expect(otherRow.getByText("Not in any project")).toBeTruthy();
    const notice = await table.findByRole("status");
    expect(notice.textContent).toContain(
      "empty catalog temporarily unavailable",
    );
    expect(table.getAllByRole("status")).toHaveLength(1);
    expect(table.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("has no memberships notice after switching to an empty agent segment", async () => {
    const client = renderPage({
      memberships: [membership(ALPHA, "writer")],
      manageable_projects: [manageable(ALPHA)],
    });
    const table = await tableSurface();
    await failWarmMemberships(
      client,
      500,
      "memberships temporarily unavailable",
    );
    expect(await table.findByRole("status")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deactivated 0" }));
    expect(await screen.findByText(/No deactivated agents/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("collects the section's retry into the unified control (T-376)", async () => {
    // The column's dash stays as it is (its message lives on the title);
    // Column mount and the section body's error-retryOnMount both read this;
    // every call rejects until Retry, so the failure line is stable.
    const memberships = vi
      .spyOn(api, "listAgentMemberships")
      .mockRejectedValue(new Error("upstream is down"));
    const client = testQueryClient();
    client.setQueryData(agentsQuery.queryKey, [BOT]);
    renderWithProviders(<ListAndAgentPage agents={[BOT]} />, client);

    const dialog = await openAgentPage();
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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

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
    const dialog = await openAgentPage();

    fireEvent.click(dialog.getByRole("button", { name: "remove Alpha" }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith("alpha", BOT.id));
    await waitFor(() => {
      const keys = invalidatedKeys(invalidate);
      expect(keys).toContain(JSON.stringify(["agent-memberships"]));
      expect(keys).toContain(JSON.stringify(["members", "alpha"]));
    });
  });
});

describe("project icons on the agents list and the agent's page", () => {
  it("draws a square icon for every project in the list, uploaded or not", async () => {
    // The fallback is what the project switcher and every other project list
    // draw, so a project without an upload is still recognisably itself.
    renderPage({
      memberships: [
        membership(
          { ...ALPHA, icon_url: "/api/projects/1/icon?v=a" },
          "writer",
        ),
        membership(BETA, "reader"),
      ],
      manageable_projects: [manageable(ALPHA), manageable(BETA)],
    });
    for (const title of ["Alpha · writer", "Beta · reader"]) {
      const icon = await screen.findByTitle(title);
      expect(icon.getAttribute("data-slot")).toBe("avatar");
      // Square, so it never reads as one of the people elsewhere on this page.
      expect(icon.getAttribute("data-shape")).toBe("square");
    }
    expect(screen.getByTitle("Beta · reader").textContent).not.toBe("");
  });

  it("draws an icon on every row of the agent's Projects section", async () => {
    renderPage({
      memberships: [membership(ALPHA, "writer"), membership(BETA, "reader")],
      manageable_projects: [manageable(ALPHA), manageable(BETA)],
    });
    await openAgentPage();
    const section = screen.getByRole("region", {
      name: "Projects for probe-bot",
    });
    expect(
      section.querySelectorAll('[data-slot="avatar"][data-shape="square"]'),
    ).toHaveLength(2);
  });
});
