import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Agent, TokenListItem } from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMembershipsQuery, agentsQuery, api } from "../src/api/queries.ts";
import {
  AgentSettings,
  AgentTokensSection,
} from "../src/pages/agent-settings.tsx";
import { AgentsSettingsPage } from "../src/pages/agents-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

afterEach(() => vi.restoreAllMocks());

function makeAgent(
  login: string,
  displayName: string,
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: login.length + login.charCodeAt(0),
    login,
    display_name: displayName,
    kind: "machine",
    avatar_url: null,
    owner: { id: 1, login: "user" },
    email: null,
    is_instance_admin: false,
    created_at: "2026-08-28T00:00:00Z",
    disabled_at: null,
    ...overrides,
  };
}

const PROBE = makeAgent("probe-bot", "Probe Bot 探针");
const HELPER = makeAgent("helper-bot", "helper-bot");
const RETIRED = makeAgent("retired-bot", "Retired Bot", {
  disabled_at: "2026-08-30T00:00:00Z",
});

const AUTOMATION = {
  id: 41,
  name: "automation",
  prefix: "td_ab12cd34",
  created_at: "2026-09-01T12:00:00Z",
  expires_at: null,
  scopes: [],
  revoked_at: null,
  last_used_at: "2026-09-16T08:30:00Z",
  holder: PROBE,
} satisfies TokenListItem;

function renderAgents(agents: Agent[], initialEntry = "/") {
  const client = testQueryClient();
  // Seeded, not fetched: useSuspenseQuery would otherwise suspend on a
  // boundary this bare render does not provide.
  client.setQueryData(agentsQuery.queryKey, agents);
  const { container } = renderWithProviders(<AgentsSettingsPage />, client, {
    initialEntry,
  });
  return within(container);
}

/** One agent's page, with its memberships and tokens settled and empty. */
function renderAgent(agents: Agent[], login: string) {
  const client = testQueryClient();
  client.setQueryData(agentsQuery.queryKey, agents);
  client.setQueryData(agentMembershipsQuery.queryKey, {
    memberships: [],
    manageable_projects: [],
  });
  vi.spyOn(api, "listAgentTokens").mockResolvedValue([]);
  const rendered = renderWithProviders(<AgentSettings login={login} />, client);
  return { view: within(rendered.container), router: rendered.router };
}

describe("agents settings page (T-205)", () => {
  it("shows only active agents by default, with both segment counts", async () => {
    const view = renderAgents([PROBE, HELPER, RETIRED]);

    expect(await view.findByText("Active 2")).toBeTruthy();
    expect(view.getByText("Deactivated 1")).toBeTruthy();
    expect(view.getByText("@probe-bot")).toBeTruthy();
    expect(view.getByText("@helper-bot")).toBeTruthy();
    expect(view.queryByText("@retired-bot")).toBeNull();
  });

  it("puts the display name first and the login beside it", async () => {
    const view = renderAgents([PROBE, RETIRED]);

    const name = await view.findByText("Probe Bot 探针");
    // Both halves of the identity share the first cell, as on Members.
    expect(name.closest("td")).toBe(view.getByText("@probe-bot").closest("td"));
    expect(view.queryByText("Handle")).toBeNull();
    // The duplicated display-name column and the State column are gone.
    expect(view.queryByText("Display name")).toBeNull();
    expect(view.queryByText("State")).toBeNull();
    expect(view.queryByText("active")).toBeNull();
    expect(view.queryByText("disabled")).toBeNull();
  });

  it("switches to the deactivated agents", async () => {
    const view = renderAgents([PROBE, RETIRED]);

    fireEvent.click(await view.findByText("Deactivated 1"));

    await waitFor(() => expect(view.queryByText("@probe-bot")).toBeNull());
    expect(view.getByText("@retired-bot")).toBeTruthy();
  });

  it("lands on the segment named by the URL", async () => {
    const view = renderAgents([PROBE, RETIRED], "/?state=deactivated");

    expect(await view.findByText("@retired-bot")).toBeTruthy();
    expect(view.queryByText("@probe-bot")).toBeNull();
  });

  it("explains what an empty Deactivated segment means", async () => {
    const view = renderAgents([PROBE, HELPER]);

    fireEvent.click(await view.findByText("Deactivated 0"));

    expect(await view.findByText(/No deactivated agents/)).toBeTruthy();
    expect(view.queryByText("@probe-bot")).toBeNull();
  });

  it("keeps the whole-page empty state, with no segment to choose from", async () => {
    const view = renderAgents([]);

    expect(await view.findByText(/No agents yet/)).toBeTruthy();
    expect(view.queryByText(/^Active /)).toBeNull();
    expect(view.queryByText(/^Deactivated /)).toBeNull();
  });

  // Each row is searched on its own and the two agents carry different
  // logins, so one row's anchor cannot stand in for the other's.
  it("links each row to that agent's settings page (T-704)", async () => {
    const view = renderAgents([PROBE, HELPER]);
    await view.findByText("@probe-bot");

    const linksIn = (login: string) =>
      new Set(
        [
          ...(
            view.getByText(`@${login}`).closest("tr") as HTMLElement
          ).querySelectorAll("a"),
        ].map((a) => a.getAttribute("href")),
      );

    expect(linksIn("probe-bot")).toEqual(
      new Set(["/settings/agents/probe-bot"]),
    );
    expect(linksIn("helper-bot")).toEqual(
      new Set(["/settings/agents/helper-bot"]),
    );
  });
});

describe("one agent's page (T-704)", () => {
  // Owning an agent is enough to read its public page (T-410); the row on
  // the list now leads here, so this heading is what keeps that link (T-391).
  it("links the agent's name to its public page", async () => {
    const { view } = renderAgent([PROBE, HELPER], "helper-bot");

    const heading = await view.findByRole("heading", { level: 1 });
    expect(heading.querySelector("a")?.getAttribute("href")).toBe(
      "/users/helper-bot",
    );
    expect(view.getByText("@helper-bot")).toBeTruthy();
  });

  it("lays out projects, tokens and Disable for an active agent", async () => {
    const disable = vi.spyOn(api, "disableAgent").mockResolvedValue(undefined);
    const { view } = renderAgent([PROBE], "probe-bot");

    expect(
      await view.findByRole("region", { name: "Projects for probe-bot" }),
    ).toBeTruthy();
    expect(
      view.getByRole("region", { name: "Tokens for probe-bot" }),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Enable" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(disable).toHaveBeenCalledExactlyOnceWith(PROBE.id),
    );
  });

  it("offers Enable instead of tokens and Disable for a disabled agent", async () => {
    const enable = vi.spyOn(api, "enableAgent").mockResolvedValue(RETIRED);
    const { view } = renderAgent([PROBE, RETIRED], "retired-bot");

    fireEvent.click(await view.findByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(enable).toHaveBeenCalledExactlyOnceWith(RETIRED.id),
    );
    expect(
      view.getByRole("region", { name: "Projects for retired-bot" }),
    ).toBeTruthy();
    expect(view.queryByRole("region", { name: /^Tokens/ })).toBeNull();
    expect(view.queryByRole("button", { name: "Disable" })).toBeNull();
    // Back goes to the segment this agent is listed under.
    expect(
      view.getByRole("link", { name: "Agents" }).getAttribute("href"),
    ).toBe("/settings/agents?state=deactivated");
  });

  it("says so when the login names none of my agents", async () => {
    const { view } = renderAgent([PROBE], "someone-else");

    expect(
      await view.findByText("You have no agent called @someone-else."),
    ).toBeTruthy();
  });

  it("follows a rename to the new address", async () => {
    vi.spyOn(api, "updateAgent").mockResolvedValue({
      ...PROBE,
      login: "probe-two",
    });
    const { view, router } = renderAgent([PROBE], "probe-bot");

    fireEvent.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Edit probe-bot" }),
    );
    fireEvent.change(dialog.getByRole("textbox", { name: "Login" }), {
      target: { value: "probe-two" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/agents/probe-two"),
    );
  });
});

describe("agent forms with a legal 64-character login", () => {
  const longAgent = makeAgent("a".repeat(64), "Long Login Bot");

  it("keeps the complete edit title and saves only the changed field", async () => {
    const update = vi
      .spyOn(api, "updateAgent")
      .mockResolvedValue({ ...longAgent, display_name: "Renamed Bot" });
    const { view } = renderAgent([longAgent], longAgent.login);
    fireEvent.click(await view.findByRole("button", { name: "Edit" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: `Edit ${longAgent.login}` }),
    );
    expect(
      (dialog.getByRole("textbox", { name: "Login" }) as HTMLInputElement)
        .value,
    ).toBe(longAgent.login);
    const save = dialog.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.getByRole("textbox", { name: "Display name" }), {
      target: { value: "Renamed Bot" },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(update).toHaveBeenCalledExactlyOnceWith(longAgent.id, {
        display_name: "Renamed Bot",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("issues with the selected expiration without changing the agent target", async () => {
    const now = Date.parse("2026-09-18T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(api, "listAgentTokens").mockResolvedValue([]);
    const issue = vi.spyOn(api, "issueAgentToken").mockResolvedValue({
      id: 73,
      name: "ci",
      prefix: "fake_ci",
      token: "todou_at_fake_ci",
      expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: [],
    });
    renderWithProviders(
      <AgentTokensSection agent={longAgent} />,
      testQueryClient(),
    );
    const dialog = within(
      await screen.findByRole("region", {
        name: `Tokens for ${longAgent.login}`,
      }),
    );
    fireEvent.change(dialog.getByRole("textbox", { name: "Token name" }), {
      target: { value: "ci" },
    });
    fireEvent.keyDown(
      dialog.getByRole("combobox", { name: "Token expiration" }),
      { key: "ArrowDown" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "30 days" }));
    fireEvent.click(dialog.getByRole("button", { name: "Issue" }));
    await waitFor(() =>
      expect(issue).toHaveBeenCalledExactlyOnceWith(longAgent.id, {
        name: "ci",
        expires_at: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
  });
});

describe("agent tokens section · load failure (T-376)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers Retry and shows the empty state after a cold failure", async () => {
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockRejectedValueOnce(new Error("token store unreachable"))
      .mockResolvedValueOnce([]);
    const client = testQueryClient();
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    const failure = await within(dialog).findByRole("status");
    expect(failure.textContent).toContain("token store unreachable");

    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("No active tokens.")).toBeTruthy();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id]]);
  });
});

describe("agent tokens section · refresh failure", () => {
  it("keeps a warm token list visible and offers a section-local retry", async () => {
    const token = AUTOMATION;
    const queryKey = ["agent-tokens", PROBE.id] as const;
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([token]);
    const client = testQueryClient();
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);

    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(
      await within(dialog).findByRole("cell", { name: token.name }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("cell", { name: `${token.prefix}…` }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"),
    );

    list.mockRejectedValueOnce(
      Object.assign(new Error("token refresh unavailable"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() =>
      expect(within(dialog).queryByRole("status")?.textContent).toContain(
        "token refresh unavailable",
      ),
    );

    expectVisible(within(dialog).getByRole("cell", { name: token.name }));
    expectVisible(
      within(dialog).getByRole("cell", { name: `${token.prefix}…` }),
    );
    const refreshFailure = within(dialog).getByRole("status");
    expect(refreshFailure.textContent).toContain("Couldn't refresh");
    expect(
      within(refreshFailure).getByRole("button", { name: "Retry" }),
    ).toBeTruthy();
  });

  it("keeps an empty successful list and its notice after a warm 500", async () => {
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        Object.assign(new Error("empty list refresh failed"), { status: 500 }),
      );
    const client = testQueryClient();
    const queryKey = ["agent-tokens", PROBE.id] as const;
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(await within(dialog).findByText("No active tokens.")).toBeTruthy();

    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    const notice = await within(dialog).findByRole("status");
    expect(notice.textContent).toContain("Couldn't refresh");
    expect(notice.textContent).toContain("empty list refresh failed");
    expect(within(dialog).getByText("No active tokens.")).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id]]);
  });

  it("does not expose a concrete cached token after a warm 403", async () => {
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([AUTOMATION])
      .mockRejectedValueOnce(
        Object.assign(new Error("tokens forbidden"), { status: 403 }),
      );
    const client = testQueryClient();
    const queryKey = ["agent-tokens", PROBE.id] as const;
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(
      await within(dialog).findByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();

    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("cell", { name: AUTOMATION.name }),
      ).toBeNull(),
    );
    expect(
      within(dialog).queryByRole("cell", { name: `${AUTOMATION.prefix}…` }),
    ).toBeNull();
    expect(within(dialog).queryByText("No active tokens.")).toBeNull();
    expect(within(dialog).queryByText(/showing saved data/)).toBeNull();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id]]);
  });

  it("retains the concrete token without a local notice after a warm 401", async () => {
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([AUTOMATION])
      .mockRejectedValueOnce(
        Object.assign(new Error("session expired"), { status: 401 }),
      );
    const client = testQueryClient();
    const queryKey = ["agent-tokens", PROBE.id] as const;
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(
      await within(dialog).findByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();

    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    expect(
      within(dialog).getByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("cell", { name: `${AUTOMATION.prefix}…` }),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id]]);
  });

  it("disables warm Retry but retains the row until the scoped read succeeds", async () => {
    const updated = {
      ...AUTOMATION,
      id: 42,
      name: "replacement",
      prefix: "td_ef56ab78",
    };
    let resolveRetry: (tokens: TokenListItem[]) => void = () => undefined;
    const pendingRetry = new Promise<TokenListItem[]>((resolve) => {
      resolveRetry = resolve;
    });
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([AUTOMATION])
      .mockRejectedValueOnce(
        Object.assign(new Error("token refresh unavailable"), { status: 500 }),
      )
      .mockImplementationOnce(() => pendingRetry);
    const client = testQueryClient();
    const queryKey = ["agent-tokens", PROBE.id] as const;
    renderWithProviders(<AgentTokensSection agent={PROBE} />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(
      await within(dialog).findByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();
    await act(async () => {
      await client.refetchQueries({ queryKey, exact: true });
    });
    const notice = await within(dialog).findByRole("status");
    expect(notice.textContent).toContain("token refresh unavailable");
    const retry = within(notice).getByRole("button", { name: "Retry" });

    fireEvent.click(retry);
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
    expect(
      within(dialog).getByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("cell", { name: `${AUTOMATION.prefix}…` }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("status").textContent).toContain(
      "token refresh unavailable",
    );
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id], [PROBE.id]]);

    await act(async () => {
      resolveRetry([updated]);
    });
    expect(
      await within(dialog).findByRole("cell", { name: updated.name }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("cell", { name: `${updated.prefix}…` }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("cell", { name: AUTOMATION.name }),
    ).toBeNull();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id], [PROBE.id]]);
  });
});

describe("agent tokens section · identity and one-time secret", () => {
  it("does not carry a token or latched refresh failure to a different agent id", async () => {
    const helperToken = {
      ...AUTOMATION,
      id: 54,
      name: "helper-only",
      prefix: "td_hel98765",
    };
    let resolveHelper: (tokens: TokenListItem[]) => void = () => undefined;
    const pendingHelper = new Promise<TokenListItem[]>((resolve) => {
      resolveHelper = resolve;
    });
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([AUTOMATION])
      .mockRejectedValueOnce(
        Object.assign(new Error("probe refresh failed"), { status: 500 }),
      )
      .mockImplementationOnce(() => pendingHelper);
    const client = testQueryClient();
    client.setQueryData(agentsQuery.queryKey, [PROBE, HELPER]);
    client.setQueryData(agentMembershipsQuery.queryKey, {
      memberships: [],
      manageable_projects: [],
    });
    // The page itself, so the key that separates two agents' sections is
    // the page's own and not one this test supplies.
    function SwitchableDialog() {
      const [agent, setAgent] = useState(PROBE);
      return (
        <>
          <button type="button" onClick={() => setAgent(HELPER)}>
            Switch agent
          </button>
          <AgentSettings login={agent.login} />
        </>
      );
    }
    renderWithProviders(<SwitchableDialog />, client);
    const probeDialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(
      await within(probeDialog).findByRole("cell", { name: AUTOMATION.name }),
    ).toBeTruthy();
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["agent-tokens", PROBE.id],
        exact: true,
      });
    });
    expect(
      (await within(probeDialog).findByRole("status")).textContent,
    ).toContain("probe refresh failed");

    fireEvent.click(
      screen.getByRole("button", { name: "Switch agent", hidden: true }),
    );
    const helperDialog = await screen.findByRole("region", {
      name: `Tokens for ${HELPER.login}`,
    });
    expect(
      within(helperDialog).queryByRole("cell", { name: AUTOMATION.name }),
    ).toBeNull();
    expect(
      within(helperDialog).queryByRole("cell", {
        name: `${AUTOMATION.prefix}…`,
      }),
    ).toBeNull();
    expect(within(helperDialog).queryByText("probe refresh failed")).toBeNull();
    expect(within(helperDialog).queryByRole("status")).toBeNull();
    await waitFor(() =>
      expect(
        client.getQueryState(["agent-tokens", HELPER.id])?.fetchStatus,
      ).toBe("fetching"),
    );
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id], [HELPER.id]]);

    await act(async () => {
      resolveHelper([helperToken]);
    });
    expect(
      await within(helperDialog).findByRole("cell", { name: helperToken.name }),
    ).toBeTruthy();
    expect(
      within(helperDialog).getByRole("cell", {
        name: `${helperToken.prefix}…`,
      }),
    ).toBeTruthy();
    expect(
      within(helperDialog).queryByRole("cell", { name: AUTOMATION.name }),
    ).toBeNull();
    expect(within(helperDialog).queryByRole("status")).toBeNull();
    expect(list.mock.calls).toEqual([[PROBE.id], [PROBE.id], [HELPER.id]]);
  });

  it("does not carry one agent's new plaintext onto another agent's page", async () => {
    vi.spyOn(api, "listAgentTokens").mockResolvedValue([]);
    vi.spyOn(api, "issueAgentToken").mockResolvedValueOnce({
      id: 74,
      name: "cli",
      token: "todou_at_probe_only_secret",
      prefix: "td_probe_only",
      expires_at: null,
      scopes: [],
    });
    const client = testQueryClient();
    client.setQueryData(agentsQuery.queryKey, [PROBE, HELPER]);
    client.setQueryData(agentMembershipsQuery.queryKey, {
      memberships: [],
      manageable_projects: [],
    });
    function Switchable() {
      const [login, setLogin] = useState(PROBE.login);
      return (
        <>
          <button type="button" onClick={() => setLogin(HELPER.login)}>
            Switch agent
          </button>
          <AgentSettings login={login} />
        </>
      );
    }
    renderWithProviders(<Switchable />, client);
    const probe = within(
      await screen.findByRole("region", { name: `Tokens for ${PROBE.login}` }),
    );
    fireEvent.change(probe.getByRole("textbox", { name: "Token name" }), {
      target: { value: "cli" },
    });
    fireEvent.click(probe.getByRole("button", { name: "Issue" }));
    expect((await probe.findByTestId("token-plaintext")).textContent).toBe(
      "todou_at_probe_only_secret",
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch agent" }));
    const helper = within(
      await screen.findByRole("region", { name: `Tokens for ${HELPER.login}` }),
    );
    expect(helper.queryByTestId("token-plaintext")).toBeNull();
    expect(helper.getByRole("textbox", { name: "Token name" })).toHaveProperty(
      "value",
      "",
    );
  });

  it("forgets an issued token's plaintext on leaving while keeping the listed prefix", async () => {
    const listed = {
      ...AUTOMATION,
      id: 73,
      name: "cli",
      prefix: "td_one_time",
    };
    vi.spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([])
      .mockResolvedValue([listed]);
    vi.spyOn(api, "issueAgentToken").mockResolvedValueOnce({
      id: 73,
      name: "cli",
      token: "todou_at_one_time_secret",
      prefix: "td_one_time",
      expires_at: null,
      scopes: [],
    });
    const client = testQueryClient();
    function LeaveAndReturn() {
      const [here, setHere] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setHere((h) => !h)}>
            {here ? "Leave" : "Return"}
          </button>
          {here && <AgentTokensSection agent={PROBE} />}
        </>
      );
    }
    renderWithProviders(<LeaveAndReturn />, client);
    const dialog = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(await within(dialog).findByText("No active tokens.")).toBeTruthy();
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Token name" }),
      { target: { value: "cli" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Issue" }));
    expect(
      (await within(dialog).findByTestId("token-plaintext")).textContent,
    ).toBe("todou_at_one_time_secret");
    expect(
      await within(dialog).findByRole("cell", { name: "cli" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    const reopened = await screen.findByRole("region", {
      name: `Tokens for ${PROBE.login}`,
    });
    expect(within(reopened).queryByTestId("token-plaintext")).toBeNull();
    expect(within(reopened).queryByText("todou_at_one_time_secret")).toBeNull();
    expect(within(reopened).getByRole("cell", { name: "cli" })).toBeTruthy();
    expect(
      within(reopened).getByRole("cell", { name: `${listed.prefix}…` }),
    ).toBeTruthy();
  });
});
