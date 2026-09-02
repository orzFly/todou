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
  File: () => <div data-testid="file-view" />,
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
    current_version_cursor: "c3",
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

/** The baseline picker's trigger; absent while comparing is off (T-200). */
const baselineTrigger = () =>
  screen.getByRole("button", { name: /pick another baseline$/i });

// Anchored on both ends: the baseline trigger's label also opens with
// "comparing against vN", and ↑↓ explain themselves with "Turn comparing on".
const TOGGLE_LABEL = /^turn comparing on$|turn comparing off$|^compare —/i;
const compareToggle = () => screen.getByRole("button", { name: TOGGLE_LABEL });

/** A presentation segment — a link while comparing, a button while off. */
const segment = (label: "rendered" | "source"): HTMLElement =>
  within(screen.getByRole("group", { name: "comparison view" })).getByText(
    label,
  );

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
    expect(baselineTrigger().getAttribute("aria-label")).toBe(
      "comparing against v2, pick another baseline",
    );
    expect(compareToggle().getAttribute("aria-pressed")).toBe("true");
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
    expect(baselineTrigger().getAttribute("aria-label")).toBe(
      "comparing against v1, pick another baseline",
    );
    expect(
      view.getByRole("link", { name: "source" }).getAttribute("href"),
    ).toBe("/projects/demo/issues/1/spec?v=3&compare=1");
  });

  it("lists every earlier version as its own link (T-200)", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=1&view=rendered");
    await ready(view);
    fireEvent.pointerDown(baselineTrigger(), {
      button: 0,
      pointerType: "mouse",
    });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const entries = screen.getAllByRole("menuitem");
    expect(entries.map((e) => e.getAttribute("href"))).toEqual([
      // The previous version, rendered, is the parameterless posture (T-192).
      "/projects/demo/issues/1/spec?v=3",
      "/projects/demo/issues/1/spec?v=3&compare=1&view=rendered",
    ]);
    // The previous version is called out; nothing offers to leave comparing.
    expect(
      within(entries[0] as HTMLElement).getByText("previous"),
    ).toBeTruthy();
    expect(screen.queryByText(/no baseline/i)).toBeNull();
  });

  it("disables the compare toggle at v1 but keeps the presentation usable", async () => {
    mockSpec();
    const view = renderSpecView("?v=1");
    await ready(view);
    expect(
      screen.queryByRole("button", { name: /pick another baseline/i }),
    ).toBeNull();
    expect(compareToggle().hasAttribute("disabled")).toBe(true);
    expect(compareToggle().getAttribute("aria-label")).toContain(
      "no earlier version",
    );
    // The presentation is orthogonal to comparing, so it stays live (T-200).
    for (const label of ["rendered", "source"] as const) {
      expect(segment(label).hasAttribute("disabled")).toBe(false);
    }
    // ↑↓ keep their slots and explain themselves instead (T-190).
    const prev = view.getByRole("button", { name: /^previous / });
    expect(prev.hasAttribute("disabled")).toBe(true);
    expect(prev.getAttribute("aria-label")).toContain("first version");
  });

  it("turns comparing off without putting the choice in the url", async () => {
    mockSpec();
    const view = renderSpecView("?v=3");
    await ready(view);
    fireEvent.click(compareToggle());

    await waitFor(() =>
      expect(compareToggle().getAttribute("aria-pressed")).toBe("false"),
    );
    expect(
      screen.queryByRole("button", { name: /pick another baseline/i }),
    ).toBeNull();
    expect(view.router.state.location.search).toEqual({ v: 3 });
    expect(segment("source").hasAttribute("disabled")).toBe(false);
  });

  it("comes back to the baseline it left, not to the previous version", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=1");
    await ready(view);
    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(compareToggle().getAttribute("aria-pressed")).toBe("false"),
    );
    expect(view.router.state.location.search).toEqual({ v: 3 });

    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(baselineTrigger().getAttribute("aria-label")).toBe(
        "comparing against v1, pick another baseline",
      ),
    );
    expect(view.router.state.location.search).toEqual({ v: 3, compare: 1 });
  });

  it("drops a remembered baseline that is no longer behind", async () => {
    mockSpec();
    const view = renderSpecView("?v=3");
    await ready(view);
    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(compareToggle().getAttribute("aria-pressed")).toBe("false"),
    );

    // Down to v2 while off — v2 was the remembered baseline, and a version
    // cannot be compared against itself.
    const versionTrigger = view.getByRole("button", {
      name: /switch version/i,
    });
    fireEvent.pointerDown(versionTrigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const toV2 = screen
      .getAllByRole("menuitem")
      .find(
        (e) => e.getAttribute("href") === "/projects/demo/issues/1/spec?v=2",
      );
    fireEvent.click(toV2 as HTMLElement);
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ v: 2 }),
    );

    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(baselineTrigger().getAttribute("aria-label")).toBe(
        "comparing against v1, pick another baseline",
      ),
    );
  });

  it("shows the whole source of one version with comparing off (T-200)", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&file=a.md");
    await ready(view);
    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(compareToggle().getAttribute("aria-pressed")).toBe("false"),
    );
    fireEvent.click(segment("source"));

    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
    // Neither half of the off position reaches the URL.
    expect(view.router.state.location.search).toEqual({ v: 3, file: "a.md" });
    // wrap works on any source view now; ↑↓ point back at the toggle.
    expect(
      view.getByRole("button", { name: /^wrap/ }).hasAttribute("disabled"),
    ).toBe(false);
    const next = view.getByRole("button", { name: /^next / });
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(next.getAttribute("aria-label")).toContain("Turn comparing on");
  });

  it("carries the presentation across the toggle in both directions", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=2");
    await ready(view);
    await waitFor(() =>
      expect(view.getAllByTestId("diff").length).toBeGreaterThan(0),
    );
    // source diff → off keeps source, so the whole file shows…
    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
    // …and back on lands straight on the diff again.
    fireEvent.click(compareToggle());
    await waitFor(() =>
      expect(view.getAllByTestId("diff").length).toBeGreaterThan(0),
    );
    expect(view.router.state.location.search).toEqual({ v: 3, compare: 2 });
  });

  it("lists every file of both versions in source mode", async () => {
    mockSpec();
    const view = renderSpecView("?v=3&compare=2");
    await ready(view);
    // b.md is identical across v2 and v3 and still gets a row: the stack
    // draws it as a foldable block, so the rail has somewhere to send it.
    await waitFor(() =>
      expect(railPaths(view)).toEqual(["a.md", "b.md", "c.md", "d.md"]),
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
