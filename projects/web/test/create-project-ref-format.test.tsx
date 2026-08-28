import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, ProjectCreateInput } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { ProjectsPage } from "../src/pages/projects.tsx";
import { testQueryClient } from "./render.tsx";

const created: Project = {
  id: 7,
  slug: "potato",
  name: "Potato",
  description: "",
  created_at: "2026-08-28T00:00:00.000Z",
};

/** Same shim as projects-order.test.tsx: ProjectsPage reads /authed/projects search. */
function renderDialog() {
  const calls: ProjectCreateInput[] = [];
  const create = vi
    .spyOn(api, "createProject")
    .mockImplementation(async (input) => {
      calls.push(input);
      return created;
    });
  const client = testQueryClient();
  client.setQueryData(["projects"], []);
  vi.spyOn(api, "listProjects").mockResolvedValue([]);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects",
    component: ProjectsPage,
    validateSearch: (search): { new?: boolean } =>
      search.new === true || search.new === 1 || search.new === "1"
        ? { new: true }
        : {},
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectsRoute, projectRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects?new=1"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, calls, create };
}

const prefixInput = () =>
  screen.getByLabelText("reference format prefix") as HTMLInputElement;
const preview = () => screen.getByTestId("ref-format-preview").textContent;

async function fillRequiredFields() {
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Potato" },
  });
}

const submit = () =>
  fireEvent.click(
    [...screen.getAllByRole("button")].find(
      (b) => b.textContent === "Create",
    ) as HTMLButtonElement,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("create-project reference format (T-148)", () => {
  it("uppercases the prefix as typed and previews the spelling live", async () => {
    renderDialog();
    await fillRequiredFields();
    expect(preview()).toBe("#1");

    fireEvent.change(prefixInput(), { target: { value: "t" } });
    expect(prefixInput().value).toBe("T");
    expect(preview()).toBe("T-1");
  });

  it("sends the prefix with the creation request", async () => {
    const { calls } = renderDialog();
    await fillRequiredFields();
    fireEvent.change(prefixInput(), { target: { value: "TODOU" } });
    submit();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ slug: "potato", ref_prefix: "TODOU" });
  });

  // Omitted, not null: an empty field must leave the project on the built-in
  // `#N` form without claiming anything in the cross-project prefix directory.
  it("omits the field entirely when the prefix is left empty", async () => {
    const { calls } = renderDialog();
    await fillRequiredFields();
    submit();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].ref_prefix).toBeUndefined();
  });
});
