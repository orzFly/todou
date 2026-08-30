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
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The real diff renders in a shadow root happy-dom cannot lay out; focus
// anchoring only needs the wrapper divs SpecDiff itself renders.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  CodeView: () => null,
}));

/**
 * happy-dom has neither — the component guards on ResizeObserver and the
 * suite drives the callback by hand.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    // The real one never fires past disconnect().
    if (this.disconnected) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

const AUTHOR = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

function mockSpec() {
  const bodies = (version: number) => [
    { path: "a.md", body: `a body v${version}\n` },
    { path: "b.md", body: `b body v${version}\n` },
  ];
  const info: SpecInfo = {
    current_version: 2,
    review_status: "unreviewed",
    unresolved_comments: 0,
    files: bodies(2).map((f) => ({ path: f.path, size: f.body.length })),
    versions: [1, 2].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> =>
      Promise.resolve({
        version: version ?? 2,
        files: bodies(version ?? 2).map((f) => ({ ...f, size: f.body.length })),
      }),
  );
  const comments: SpecComments = { current_version: 2, items: [] };
  vi.spyOn(api, "getSpecComments").mockResolvedValue(comments);
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
    validateSearch: (
      s: Record<string, unknown>,
    ): { file?: string; v?: number; compare?: number } => {
      const num = (v: unknown) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      };
      return {
        file: typeof s.file === "string" ? s.file : undefined,
        v: num(s.v),
        compare: num(s.compare),
      };
    },
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

/** The observer SpecDiff put on the diff container, not the header one. */
function diffObserver(scrolled: Element) {
  return FakeResizeObserver.instances.find((o) =>
    o.observed.includes(scrolled.parentElement as Element),
  );
}

describe("spec compare focus anchoring (T-188)", () => {
  it("re-anchors on container growth until the user scrolls", async () => {
    mockSpec();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const scrolls: Element[] = [];
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this);
    };
    const view = renderSpecView("?v=2&compare=1&file=b.md");
    await view.findByRole("button", { name: /finish review/i });

    // Mount scrolls the focused file's wrapper once.
    await waitFor(() => expect(scrolls.length).toBe(1));
    expect(scrolls[0].textContent).toContain("b.md");

    // Diffs above finish laying out → the container grows → re-anchor.
    const observer = diffObserver(scrolls[0]);
    expect(observer).toBeDefined();
    observer?.fire();
    expect(scrolls.length).toBe(2);
    expect(scrolls[1]).toBe(scrolls[0]);

    // First user input hands the viewport back for good.
    fireEvent.wheel(window);
    expect(observer?.disconnected).toBe(true);
    observer?.fire();
    expect(scrolls.length).toBe(2);
  });

  it("does not observe when no file is focused", async () => {
    mockSpec();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const scrolls: Element[] = [];
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this);
    };
    const view = renderSpecView("?v=2&compare=1");
    await view.findByRole("button", { name: /finish review/i });
    await waitFor(() => expect(view.getAllByTestId("diff").length).toBe(2));
    expect(scrolls.length).toBe(0);
  });
});
