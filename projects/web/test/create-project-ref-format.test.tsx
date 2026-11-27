import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  type Project,
  type ProjectCreateInput,
  TodouError,
} from "@todou/shared";
import { toast } from "sonner";
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

describe("create-project refusals land under their fields (T-795)", () => {
  const errorUnder = (label: string) => {
    const control = screen.getByLabelText(label);
    const ids = control.getAttribute("aria-describedby")?.split(" ") ?? [];
    return ids
      .map((id) => document.getElementById(id))
      .find((el) => el?.getAttribute("data-slot") === "field-error")
      ?.textContent;
  };

  async function refuse(error: Error) {
    const toastError = vi.spyOn(toast, "error");
    const { create } = renderDialog();
    create.mockRejectedValueOnce(error);
    await fillRequiredFields();
    submit();
    return { toastError };
  }

  it("puts a taken slug under Slug, and focuses it", async () => {
    const { toastError } = await refuse(
      new TodouError(409, "conflict", 'slug "potato" is already taken'),
    );
    await waitFor(() =>
      expect(errorUnder("Slug")).toBe('slug "potato" is already taken'),
    );
    expect(screen.getByLabelText("Slug").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Slug"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("puts a rejected prefix under the reference format", async () => {
    const { toastError } = await refuse(
      new TodouError(422, "validation_failed", "✖ Invalid prefix", [
        { path: ["ref_prefix"], message: "Invalid prefix" },
      ]),
    );
    await waitFor(() =>
      expect(errorUnder("reference format prefix")).toBe("Invalid prefix"),
    );
    expect(errorUnder("Slug")).toBeUndefined();
    expect(document.activeElement).toBe(
      screen.getByLabelText("reference format prefix"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("puts anything else at the foot of the form", async () => {
    const { toastError } = await refuse(
      new TodouError(500, "internal", "the server fell over"),
    );
    // Right above the buttons, after every field.
    const message = await screen.findByText("the server fell over");
    expect(message.nextElementSibling?.getAttribute("data-slot")).toBe(
      "dialog-footer",
    );
    expect(
      within(message.nextElementSibling as HTMLElement).getByRole("button", {
        name: "Create",
      }),
    ).toBeTruthy();
    expect(errorUnder("Slug")).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("drops a field's refusal once that field is edited", async () => {
    await refuse(
      new TodouError(409, "conflict", 'slug "potato" is already taken'),
    );
    await waitFor(() => expect(errorUnder("Slug")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "potato-2" },
    });
    expect(errorUnder("Slug")).toBeUndefined();
    expect(screen.getByLabelText("Slug").hasAttribute("aria-invalid")).toBe(
      false,
    );
  });

  it("states the slug's and the prefix's characters before anything is typed", async () => {
    renderDialog();
    await screen.findByRole("dialog");
    expect(
      screen.getByText("Lowercase letters, digits and dashes."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Capital letters, digits and _, up to 20; empty uses #\./,
      ),
    ).toBeTruthy();
  });
});
