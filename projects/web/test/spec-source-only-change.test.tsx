import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: () => <div data-testid="file-view" />,
  CodeView: () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  for (const header of document.querySelectorAll("header")) header.remove();
});

const AUTHOR = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

// v2 renumbers the items below the first and re-pads the table. Every byte it
// moves is one the parser throws away, so the page is identical to v1's.
const BODIES: Record<number, Record<string, string>> = {
  1: {
    "plan.md":
      "# 计划\n\n1. 第一步\n2. 第二步\n3. 第三步\n\n| 键 | 值 |\n|---|---|\n| a | 1 |\n",
  },
  2: {
    "plan.md":
      "# 计划\n\n1. 第一步\n7. 第二步\n9. 第三步\n\n| 键   | 值 |\n| --- | -- |\n| a   | 1 |\n",
  },
};

function mockSpec(): void {
  const info: SpecInfo = {
    current_version: 2,
    current_version_cursor: "c2",
    review_status: "unreviewed",
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
    files: Object.entries(BODIES[2] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: [1, 2].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const v = version ?? 2;
      return Promise.resolve({
        version: v,
        files: Object.entries(BODIES[v] ?? {}).map(([path, body]) => ({
          path,
          body,
          size: body.length,
        })),
      });
    },
  );
  vi.spyOn(api, "getSpecComments").mockResolvedValue({
    current_version: 2,
    items: [],
  });
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
}

async function openSpec() {
  mockSpec();
  const header = document.createElement("header");
  header.getBoundingClientRect = () => ({ height: 57 }) as DOMRect;
  document.body.append(header);
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const specRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number/spec",
    component: SpecViewPage,
    validateSearch: parseSpecSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([specRoute])]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/projects/demo/issues/1/spec?v=2&file=plan.md"],
    }),
    defaultPendingMs: 0,
  });
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await view.findByRole("button", { name: /finish review/i });
  await waitFor(() =>
    expect(api.getSpecFiles).toHaveBeenCalledWith("demo", 1, 1),
  );
  return view;
}

describe("a file only the source changed in", () => {
  it("says so on the fold control instead of claiming nothing changed", async () => {
    const view = await openSpec();
    const fold = view.getByRole("button", { name: /^fold/ });
    expect(fold.hasAttribute("disabled")).toBe(true);
    expect(fold.getAttribute("aria-label")).toContain(
      "Only the source changed",
    );
  });

  it("stays a stop for ↑↓", async () => {
    const view = await openSpec();
    const next = view.getByRole("button", { name: /^next / });
    expect(next.hasAttribute("disabled")).toBe(false);
    expect(next.getAttribute("aria-label")).toBe("next changed file");
  });
});
