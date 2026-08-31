import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The real diff renders in a shadow root happy-dom cannot lay out; this
// suite only asks which presentation is on screen.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  CodeView: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

/**
 * Three versions across which every file fate occurs: `a.md` changes every
 * time, `b.md` never changes, `c.md` is removed in v3, `d.md` is added in v3.
 */
const BODIES: Record<number, Array<{ path: string; body: string }>> = {
  1: [
    { path: "a.md", body: "a one\n" },
    { path: "b.md", body: "b stable\n" },
  ],
  2: [
    { path: "a.md", body: "a two\n" },
    { path: "b.md", body: "b stable\n" },
    { path: "c.md", body: "c doomed\n" },
  ],
  3: [
    { path: "a.md", body: "a three\n" },
    { path: "b.md", body: "b stable\n" },
    { path: "d.md", body: "d newborn\n" },
  ],
};

function mockSpec() {
  const info: SpecInfo = {
    current_version: 3,
    review_status: "unreviewed",
    unresolved_comments: 0,
    files: BODIES[3]?.map((f) => ({ path: f.path, size: f.body.length })) ?? [],
    versions: [1, 2, 3].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const files = BODIES[version ?? 3] ?? [];
      return Promise.resolve({
        version: version ?? 3,
        files: files.map((f) => ({ ...f, size: f.body.length })),
      });
    },
  );
  const comments: SpecComments = { current_version: 3, items: [] };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
}

function renderSpecView(search: string) {
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
    component: SpecViewPage,
    validateSearch: parseSpecSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([issueRoute, specRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/demo/issues/1/spec${search}`],
    }),
    defaultPendingMs: 0,
  });
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

/** The whole toolbar has settled once Finish review is on screen. */
async function ready(view: ReturnType<typeof renderSpecView>) {
  await view.findByRole("button", { name: /finish review/i });
}

// Anchored, or the ↑↓ buttons' "pick a baseline" explanation matches too.
const baselineTrigger = () =>
  screen.getByRole("button", {
    name: /^(reading without a baseline|comparing against|no baseline)/i,
  });

/** The rail rows, in order, as plain paths. */
function railPaths(view: ReturnType<typeof renderSpecView>): string[] {
  return view
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.includes("file="))
    .map((href) =>
      decodeURIComponent(href.split("file=")[1]?.split("&")[0] ?? ""),
    );
}

describe("spec compare controls (T-192)", () => {
  it("opens on the previous version, rendered", async () => {
    mockSpec();
    const view = renderSpecView("?v=3");
    await ready(view);
    expect(baselineTrigger().textContent).toContain("vs v2");
    expect(
      view.getByRole("link", { name: "rendered" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      view.getByRole("link", { name: "source" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(
      view.getByRole("button", { name: /^wrap/ }).hasAttribute("disabled"),
    ).toBe(true);
    expect(view.queryAllByTestId("diff")).toHaveLength(0);
  });

  it("draws the source diff for a link that pins a baseline and nothing else", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=2");
    await ready(view);
    expect(
      view.getByRole("link", { name: "source" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      view.getByRole("link", { name: "rendered" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(
      view.getByRole("button", { name: /^wrap/ }).hasAttribute("disabled"),
    ).toBe(false);
    await waitFor(() =>
      expect(view.getAllByTestId("diff").length).toBeGreaterThan(0),
    );
  });

  it("offers the other presentation as a link that keeps the baseline", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=1&view=rendered");
    await ready(view);
    expect(baselineTrigger().textContent).toContain("vs v1");
    expect(
      view.getByRole("link", { name: "source" }).getAttribute("href"),
    ).toBe("/projects/demo/issues/1/spec?v=3&compare=1");
  });

  it("disables the presentation toggle while there is no baseline", async () => {
    mockSpec();
    const view = renderSpecView("?v=1");
    await ready(view);
    expect(baselineTrigger().textContent).toContain("no baseline");
    for (const label of ["rendered", "source"]) {
      const segment = view.getByRole("button", { name: label });
      expect(segment.hasAttribute("disabled")).toBe(true);
    }
    // ↑↓ keep their slots and explain themselves instead (T-190).
    const prev = view.getByRole("button", { name: /^previous / });
    expect(prev.hasAttribute("disabled")).toBe(true);
    expect(prev.getAttribute("aria-label")).toContain("first version");
  });

  it("takes the baseline off without putting the choice in the url", async () => {
    mockSpec();
    const view = renderSpecView("?v=3");
    await ready(view);
    fireEvent.pointerDown(baselineTrigger(), {
      button: 0,
      pointerType: "mouse",
    });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /no baseline/i }),
    );

    await waitFor(() =>
      expect(baselineTrigger().textContent).toContain("no baseline"),
    );
    expect(view.router.state.location.search).toEqual({ v: 3 });
    expect(
      view.getByRole("button", { name: "source" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("narrows the rail to the diffed files in source mode", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=2");
    await ready(view);
    // b.md is identical across v2 and v3, so it has no diff to scroll to.
    await waitFor(() =>
      expect(railPaths(view)).toEqual(["a.md", "c.md", "d.md"]),
    );
  });

  it("keeps every file plus the removed one in the rendered comparison", async () => {
    mockSpec();
    const view = renderSpecView("?v=3");
    await ready(view);
    await waitFor(() =>
      expect(railPaths(view)).toEqual(["a.md", "b.md", "d.md", "c.md"]),
    );
  });

  it("keeps the change navigation on a brand-new file", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&file=d.md");
    await ready(view);
    await view.findByText(/new in v3/);
    const prev = view.getByRole("button", { name: /^previous / });
    expect(prev.hasAttribute("disabled")).toBe(false);
    expect(prev.getAttribute("aria-label")).toBe("previous changed file");
  });

  it("navigates between file diffs in source mode", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=2");
    await ready(view);
    await waitFor(() => expect(view.getAllByTestId("diff")).toHaveLength(3));
    const next = view.getByRole("button", { name: /^next / });
    expect(next.getAttribute("aria-label")).toBe("next file diff");
    expect(next.hasAttribute("disabled")).toBe(false);
  });

  it("hands a removed file over to the source diff", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&file=c.md");
    await ready(view);
    await view.findByText(/was removed in v3/);
    expect(
      view
        .getByRole("link", { name: /open the source diff/i })
        .getAttribute("href"),
    ).toBe("/projects/demo/issues/1/spec?file=c.md&v=3&compare=2");
  });
});
