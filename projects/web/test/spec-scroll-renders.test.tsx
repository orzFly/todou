import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render } from "@testing-library/react";
import type { Me, SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import { specFilesQuery, specQuery } from "../src/api/spec.ts";
import { AppShell } from "../src/components/shell.tsx";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// T-601: the counter beside ↑↓ moves as the reader scrolls past changed
// blocks, and while the page held it, each step re-rendered the document and
// every annotation chip — each one a whole Radix popover. happy-dom has no
// layout, so where the reader stands is driven through `currentIndex`.

const counts = vi.hoisted(() => ({ annotated: 0, chips: 0, index: 0 }));

vi.mock("../src/lib/spec-change-nav.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/spec-change-nav.ts")>();
  return { ...actual, currentIndex: () => counts.index };
});

vi.mock(
  "../src/components/spec/annotated-markdown.tsx",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/components/spec/annotated-markdown.tsx")
      >();
    const Original = actual.AnnotatedMarkdown;
    return {
      ...actual,
      AnnotatedMarkdown: (props: Parameters<typeof Original>[0]) => {
        counts.annotated++;
        return <Original {...props} />;
      },
    };
  },
);

vi.mock("../src/components/ui/popover.tsx", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/components/ui/popover.tsx")>();
  const Original = actual.Popover;
  return {
    ...actual,
    Popover: (props: Parameters<typeof Original>[0]) => {
      // A chip's popover is the uncontrolled one; the page's own are not.
      if (props.open === undefined) counts.chips++;
      return <Original {...props} />;
    },
  };
});

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: () => <div data-testid="file-view" />,
  CodeView: () => null,
}));

const ME: Me = {
  id: 9,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const AUTHOR = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

const SPEC: SpecInfo = {
  current_version: 2,
  current_version_cursor: "c2",
  review_status: "unreviewed",
  unresolved_comments: 1,
  unresolved_carried_comments: 0,
  files: [{ path: "a.md", size: 40 }],
  versions: [1, 2].map((number) => ({
    number,
    author: AUTHOR,
    message: `v${number}`,
    created_at: "2026-01-01T00:00:00Z",
  })),
};
const V1: SpecFiles = {
  version: 1,
  files: [{ path: "a.md", body: "alpha\n\nbravo\n\ncharlie\n", size: 22 }],
};
const V2: SpecFiles = {
  version: 2,
  files: [
    {
      path: "a.md",
      body: "alpha edited\n\nbravo\n\ncharlie edited\n",
      size: 36,
    },
  ],
};
const COMMENTS: SpecComments = {
  current_version: 2,
  items: [
    {
      comment_id: 41,
      author: AUTHOR,
      body: "on bravo",
      created_at: "2026-01-01T00:00:00Z",
      anchor: {
        path: "a.md",
        version: 2,
        line_start: 3,
        line_end: 3,
        col_start: null,
        col_end: null,
        quote: "bravo",
      },
      outdated: false,
      current_line_start: 3,
      current_line_end: 3,
      resolved: null,
    },
  ],
} as unknown as SpecComments;

function renderSpec() {
  vi.spyOn(api, "getSpec").mockResolvedValue(SPEC);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    async (_slug, _number, version) => (version === 1 ? V1 : V2),
  );
  vi.spyOn(api, "getSpecComments").mockResolvedValue(COMMENTS);
  vi.spyOn(api, "getReferenceConfig").mockResolvedValue({
    format: { prefix: "T-", history: [] },
    autolinks: [],
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => (
      <AppShell me={ME}>
        <Outlet />
      </AppShell>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
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
      initialEntries: ["/projects/demo/issues/7/spec"],
    }),
    defaultPendingMs: 0,
  });
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, ME);
  client.setQueryData(projectQuery("demo").queryKey, {
    id: 1,
    slug: "demo",
    name: "Demo",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "writer",
  });
  client.setQueryData(specQuery("demo", 7).queryKey, SPEC);
  client.setQueryData(specFilesQuery("demo", 7, 1).queryKey, V1);
  client.setQueryData(specFilesQuery("demo", 7, 2).queryKey, V2);
  client.setQueryData(["spec", "demo", 7, "comments"], COMMENTS);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** One scroll event, then the frame the counter measures in. */
async function scrollTo(index: number) {
  counts.index = index;
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  counts.index = 0;
});

describe("scrolling the spec page (T-601)", () => {
  it("moves the change counter without re-rendering the document or its chips", async () => {
    const view = renderSpec();
    await view.findByText("bravo");
    await view.findByRole("button", { name: "1 comment(s) on this block" });
    const counter = () =>
      view.container.querySelector('[data-toolbar-slot="change-count"]')
        ?.textContent;
    await scrollTo(0);
    expect(counter()).toBe("0/2");

    const annotated = counts.annotated;
    const chips = counts.chips;
    await scrollTo(1);
    expect(counter()).toBe("1/2");
    await scrollTo(2);
    expect(counter()).toBe("2/2");
    expect(counts.annotated).toBe(annotated);
    expect(counts.chips).toBe(chips);
  });

  it("keeps the chips still when the page re-renders around them", async () => {
    const view = renderSpec();
    await view.findByText("bravo");
    await view.findByRole("button", { name: "1 comment(s) on this block" });
    await act(async () => {});
    const annotated = counts.annotated;
    const chips = counts.chips;
    // Opening the composer is page state that never reaches the document.
    fireEvent.click(view.getByRole("button", { name: "Comment file" }));
    await view.findByLabelText("Spec comment");
    expect(counts.annotated).toBeGreaterThan(annotated);
    expect(counts.chips).toBe(chips);
  });
});
