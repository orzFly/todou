import {
  isInaccessible,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Agent,
  AgentMemberships,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentMembershipsQuery } from "../src/api/queries.ts";
import { referenceDirectoryQuery } from "../src/api/references.ts";
import {
  AgentProjectsSection,
  AgentProjectsSummary,
} from "../src/components/shared/agent-projects.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { expectVisible } from "./visibility.ts";

const agent: Agent = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
  disabled_at: null,
};
const project = { id: 1, slug: "atlas", name: "Atlas Lab" };
const directory: ReferenceDirectory = {
  entries: [
    { prefix: "XYZ", slug: project.slug, from: agent.created_at, to: null },
  ],
  contested: [],
};

function renderWith(
  ui: React.ReactElement,
  iconUrl: string | null = null,
): void {
  const client = testQueryClient();
  const data: AgentMemberships = {
    memberships: [
      {
        agent_id: agent.id,
        project: { ...project, icon_url: iconUrl },
        role: "writer",
        created_at: agent.created_at,
      },
    ],
    manageable_projects: [{ ...project, my_role: "admin" }],
  };
  client.setQueryData(agentMembershipsQuery.queryKey, data);
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  renderWithProviders(ui, client);
}

function loadImages(naturalWidth: number) {
  class SettledImage extends EventTarget {
    complete = true;
    naturalWidth = naturalWidth;
    crossOrigin: string | null = null;
    referrerPolicy = "";
    src = "";
  }
  vi.stubGlobal("Image", SettledImage);
}

async function section() {
  return within(
    await screen.findByRole("region", { name: "Projects for bot-one" }),
  );
}

function expectControls() {
  const view = within(
    screen.getByRole("region", { name: "Projects for bot-one" }),
  );
  const role = view.getByRole("combobox", { name: "role in Atlas Lab" });
  const remove = view.getByRole("button", { name: "remove Atlas Lab" });
  expectVisible(role);
  expectVisible(remove);
  expect(isInaccessible(role)).toBe(false);
  expect(isInaccessible(remove)).toBe(false);
  // These explicit labels, and the icon being their sibling, mean the exact
  // control names alone cannot detect removal of the membership icon's hide.
}

afterEach(() => vi.unstubAllGlobals());

describe("agents list project icon", () => {
  it("draws the REF fallback beside the name, hidden from accessibility", async () => {
    renderWith(<AgentProjectsSummary agent={agent} />);
    const fallback = await screen.findByText("XYZ", { exact: true });
    expectVisible(fallback);
    expect(isInaccessible(fallback)).toBe(true);
    const name = screen.getByText("Atlas Lab", { exact: true });
    expectVisible(name);
    expect(isInaccessible(name)).toBe(false);
  });

  it("falls back to the REF when the upload fails", async () => {
    loadImages(0);
    renderWith(
      <AgentProjectsSummary agent={agent} />,
      "/api/projects/1/icon?v=failed-badge",
    );
    const fallback = await screen.findByText("XYZ", { exact: true });
    expectVisible(fallback);
    expect(isInaccessible(fallback)).toBe(true);
  });

  it("draws the uploaded image while excluding that visible node", async () => {
    loadImages(20);
    const iconUrl = "/api/projects/1/icon?v=badge";
    renderWith(<AgentProjectsSummary agent={agent} />, iconUrl);
    const name = await screen.findByText("Atlas Lab", { exact: true });
    const cell = name.parentElement as HTMLElement;
    await waitFor(() => {
      const image = cell.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(isInaccessible(image as HTMLImageElement)).toBe(true);
    });
    expect(within(cell).queryByText("XYZ", { exact: true })).toBeNull();
  });
});

describe("agent page membership-row decoration", () => {
  it("shows the fallback prefix but excludes it while exposing named controls", async () => {
    renderWith(<AgentProjectsSection agent={agent} />);
    const view = await section();
    const fallback = view.getByText("XYZ", { exact: true });
    expectVisible(fallback);
    expect(isInaccessible(fallback)).toBe(true);
    const name = view.getByText("Atlas Lab", { exact: true });
    expectVisible(name);
    expect(isInaccessible(name)).toBe(false);
    expectControls();
  });

  it("draws an excluded uploaded image beside the exact role and remove controls", async () => {
    loadImages(20);
    const iconUrl = "/api/projects/1/icon?v=membership";
    renderWith(<AgentProjectsSection agent={agent} />, iconUrl);
    const view = await section();
    const element = screen.getByRole("region", {
      name: "Projects for bot-one",
    });
    await waitFor(() => {
      const image = element.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(isInaccessible(image as HTMLImageElement)).toBe(true);
    });
    expect(view.queryByText("XYZ", { exact: true })).toBeNull();
    expectControls();
  });
});
