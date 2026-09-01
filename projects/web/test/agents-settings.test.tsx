import { fireEvent, waitFor, within } from "@testing-library/react";
import type { Agent } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsQuery } from "../src/api/queries.ts";
import { AgentsSettingsPage } from "../src/pages/agents-settings.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

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
});
