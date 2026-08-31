import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The real diff renders in a shadow root happy-dom cannot lay out; the stub
// surfaces the one option this suite is about as an attribute instead.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({ options }: { options: { overflow?: string } }) => (
    <div data-testid="diff" data-overflow={options.overflow ?? "unset"} />
  ),
  CodeView: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const AUTHOR = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const V1 = "short line\n";
const V2 = `${"a very long line ".repeat(20)}\n`;

function mockSpec() {
  const info: SpecInfo = {
    current_version: 2,
    review_status: "unreviewed",
    unresolved_comments: 0,
    files: [{ path: "design.md", size: V2.length }],
    versions: [
      {
        number: 1,
        author: AUTHOR,
        message: "v1",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        number: 2,
        author: AUTHOR,
        message: "v2",
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> =>
      Promise.resolve({
        version: version ?? 2,
        files: [
          {
            path: "design.md",
            body: version === 1 ? V1 : V2,
            size: (version === 1 ? V1 : V2).length,
          },
        ],
      }),
  );
  const comments: SpecComments = { current_version: 2, items: [] };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
  // A real ReferenceConfig, not a cast: the annotated document resolves the
  // ref prefix as of the version's date, which reads `format.history`.
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
}

/** The spec page under a router mirroring the real route ids it reads from. */
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
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("spec diff wrap toggle (T-143)", () => {
  it("is disabled outside the source diff, not unmounted", async () => {
    // It holds the display slot in every state now, because a slot that
    // empties out is a slot that moves things (T-190, T-192).
    mockSpec();
    const view = renderSpecView("?v=2");
    await view.findByRole("button", { name: /finish review/i });
    const toggle = view.getByRole("button", { name: /^wrap/ });
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });

  it("defaults to on and wraps the diff", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&compare=1");
    const toggle = await view.findByRole("button", { name: /wrap/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => {
      expect(view.getByTestId("diff").getAttribute("data-overflow")).toBe(
        "wrap",
      );
    });
  });

  it("flips to horizontal scrolling and remembers the choice", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&compare=1");
    const toggle = await view.findByRole("button", { name: /wrap/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(view.getByTestId("diff").getAttribute("data-overflow")).toBe(
        "scroll",
      );
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("todou-spec-diff-wrap")).toBe("off");
  });

  it("opens off when storage says so", async () => {
    localStorage.setItem("todou-spec-diff-wrap", "off");
    mockSpec();
    const view = renderSpecView("?v=2&compare=1");
    const toggle = await view.findByRole("button", { name: /wrap/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => {
      expect(view.getByTestId("diff").getAttribute("data-overflow")).toBe(
        "scroll",
      );
    });
  });

  it("treats any other stored value as on", async () => {
    localStorage.setItem("todou-spec-diff-wrap", "on");
    mockSpec();
    const view = renderSpecView("?v=2&compare=1");
    const toggle = await view.findByRole("button", { name: /wrap/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
