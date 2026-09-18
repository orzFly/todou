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
import { agentsQuery, api } from "../src/api/queries.ts";
import {
  AgentsSettingsPage,
  AgentTokensDialog,
} from "../src/pages/agents-settings.tsx";
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
  revoked_at: null,
  last_used_at: "2026-09-16T08:30:00Z",
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

describe("agents settings page (T-205)", () => {
  it("shows only active agents by default, with both segment counts", async () => {
    const view = renderAgents([PROBE, HELPER, RETIRED]);

    expect(await view.findByText("Active 2")).toBeTruthy();
    expect(view.getByText("Deactivated 1")).toBeTruthy();
    expect(view.getByText("@probe-bot")).toBeTruthy();
    expect(view.getByText("@helper-bot")).toBeTruthy();
    expect(view.queryByText("@retired-bot")).toBeNull();
  });

  it("puts the display name first and the login in a Handle column", async () => {
    const view = renderAgents([PROBE, RETIRED]);

    expect(await view.findByText("Handle")).toBeTruthy();
    // Both halves of the identity are on the row, each in its own column.
    expect(view.getByText("Probe Bot 探针")).toBeTruthy();
    expect(view.getByText("@probe-bot")).toBeTruthy();
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
    // A deactivated row offers Enable instead of Tokens/Disable.
    expect(view.getByText("Enable")).toBeTruthy();
    expect(view.queryByText("Disable")).toBeNull();
    expect(view.getByText("Edit")).toBeTruthy();
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

  // Owning an agent is enough to read its page (T-410), which is what let
  // this row be linked at all. Each row is searched on its own and the two
  // agents carry different logins, so one row's anchor cannot stand in for
  // the other's; dropping the link leaves an empty list here.
  it("links each agent's chip to that agent's own page (T-391)", async () => {
    const view = renderAgents([PROBE, HELPER]);
    await view.findByText("Handle");

    const userLinksIn = (login: string) =>
      [
        ...(
          view.getByText(`@${login}`).closest("tr") as HTMLElement
        ).querySelectorAll('a[href^="/users/"]'),
      ].map((a) => a.getAttribute("href"));

    expect(userLinksIn("probe-bot")).toEqual(["/users/probe-bot"]);
    expect(userLinksIn("helper-bot")).toEqual(["/users/helper-bot"]);
  });
});

describe("agent tokens dialog · load failure (T-376)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers Retry and shows the empty state after a cold failure", async () => {
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockRejectedValueOnce(new Error("token store unreachable"))
      .mockResolvedValueOnce([]);
    const client = testQueryClient();
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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

describe("agent tokens dialog · refresh failure", () => {
  it("keeps a warm token list visible and offers a dialog-local retry", async () => {
    const token = AUTOMATION;
    const queryKey = ["agent-tokens", PROBE.id] as const;
    const list = vi
      .spyOn(api, "listAgentTokens")
      .mockResolvedValueOnce([token]);
    const client = testQueryClient();
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);

    fireEvent.click(await screen.findByRole("button", { name: /Tokens/ }));
    const dialog = await screen.findByRole("dialog", {
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
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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

describe("agent tokens dialog · identity and one-time secret", () => {
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
    function SwitchableDialog() {
      const [agent, setAgent] = useState(PROBE);
      return (
        <>
          <button type="button" onClick={() => setAgent(HELPER)}>
            Switch agent
          </button>
          <AgentTokensDialog agent={agent} />
        </>
      );
    }
    renderWithProviders(<SwitchableDialog />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const probeDialog = await screen.findByRole("dialog", {
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
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const helperDialog = await screen.findByRole("dialog", {
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

  it("forgets an issued token's plaintext on close while keeping the listed prefix", async () => {
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
    });
    const client = testQueryClient();
    renderWithProviders(<AgentTokensDialog agent={PROBE} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "Tokens" }));
    const dialog = await screen.findByRole("dialog", {
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

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    const reopened = await screen.findByRole("dialog", {
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
