import {
  fireEvent,
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
import { AgentProjectsCell } from "../src/components/shared/agent-projects-dialog.tsx";
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

function renderCell(iconUrl: string | null = null) {
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
  return renderWithProviders(<AgentProjectsCell agent={agent} />, client);
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

async function trigger() {
  return screen.findByRole("button", { name: "Manage bot-one's projects" });
}

async function openDialog() {
  fireEvent.click(await trigger());
  return within(
    await screen.findByRole("dialog", { name: "Projects for bot-one" }),
  );
}

function expectControls() {
  const dialog = within(
    screen.getByRole("dialog", { name: "Projects for bot-one" }),
  );
  const role = dialog.getByRole("combobox", { name: "role in Atlas Lab" });
  const remove = dialog.getByRole("button", { name: "remove Atlas Lab" });
  expectVisible(role);
  expectVisible(remove);
  expect(isInaccessible(role)).toBe(false);
  expect(isInaccessible(remove)).toBe(false);
  // These explicit labels, and the icon being their sibling, mean the exact
  // control names alone cannot detect removal of the membership icon's hide.
}

afterEach(() => vi.unstubAllGlobals());

describe("agent project badge decoration", () => {
  it("omits the icon when there is no upload and keeps the exact trigger name", async () => {
    renderCell();
    const button = await trigger();
    expectVisible(within(button).getByText("atlas", { exact: true }));
    expect(button.querySelector("img")).toBeNull();
    expect(within(button).queryByText("AL", { exact: true })).toBeNull();
    expect(isInaccessible(button)).toBe(false);
  });

  it("shows a failed upload's fallback but excludes it from accessibility", async () => {
    loadImages(0);
    renderCell("/api/projects/1/icon?v=failed-badge");
    const button = await trigger();
    // Badges pass no REF prefix, so an unavailable image falls back to initials.
    const fallback = await within(button).findByText("AL", { exact: true });
    expectVisible(fallback);
    expect(isInaccessible(fallback)).toBe(true);
    expect(isInaccessible(button)).toBe(false);
    expect(await trigger()).toBe(button);
    // The explicit trigger label survives even if the icon hide is removed.
  });

  it("draws the uploaded badge image while excluding that visible node", async () => {
    loadImages(20);
    const iconUrl = "/api/projects/1/icon?v=badge";
    renderCell(iconUrl);
    const button = await trigger();
    await waitFor(() => {
      const image = button.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(isInaccessible(image as HTMLImageElement)).toBe(true);
    });
    expect(within(button).queryByText("AL", { exact: true })).toBeNull();
    expect(isInaccessible(button)).toBe(false);
    expect(await trigger()).toBe(button);
  });
});

describe("agent project membership-row decoration", () => {
  it("shows the fallback prefix but excludes it while exposing named controls", async () => {
    renderCell();
    const dialog = await openDialog();
    const fallback = dialog.getByText("XYZ", { exact: true });
    expectVisible(fallback);
    expect(isInaccessible(fallback)).toBe(true);
    const name = dialog.getByText("Atlas Lab", { exact: true });
    expectVisible(name);
    expect(isInaccessible(name)).toBe(false);
    expectControls();
  });

  it("draws an excluded uploaded image beside the exact role and remove controls", async () => {
    loadImages(20);
    const iconUrl = "/api/projects/1/icon?v=membership";
    renderCell(iconUrl);
    const dialog = await openDialog();
    const dialogElement = screen.getByRole("dialog", {
      name: "Projects for bot-one",
    });
    await waitFor(() => {
      const image = dialogElement.querySelector("img");
      expect(image?.getAttribute("src")).toBe(iconUrl);
      expectVisible(image as HTMLImageElement);
      expect(isInaccessible(image as HTMLImageElement)).toBe(true);
    });
    expect(dialog.queryByText("XYZ", { exact: true })).toBeNull();
    expectControls();
  });
});
