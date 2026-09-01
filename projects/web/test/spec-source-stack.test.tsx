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
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

// The real diff renders in a shadow root happy-dom cannot lay out; this
// suite only asks which entry the stack drew for which file. `File` does
// render its annotations, which is the one thing about an unfolded block
// that is not visible from the outside.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: ({
    lineAnnotations,
    renderAnnotation,
  }: {
    lineAnnotations?: Array<{ lineNumber: number; metadata: unknown }>;
    renderAnnotation?: (a: { metadata: unknown }) => ReactNode;
  }) => (
    <div data-testid="file-view">
      {(lineAnnotations ?? []).map((annotation, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: several annotations can share a line
          key={index}
          data-testid="file-annotation"
          data-line={annotation.lineNumber}
        >
          {renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  ),
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
 * Five versions carrying every class the source stack has to draw:
 * v1→v2 renames one file untouched and one with an edit, removes a file and
 * adds an empty one; v2→v3 changes a single file; v3→v4 removes the empty
 * one; v5 repeats v4 byte for byte.
 */
const V2: Record<string, string> = {
  "also-keep.md": "steady\n",
  "drifted.md": "alpha\nbeta\ngamma\nomega\n",
  "empty.md": "",
  "keep.md": "keep one\n",
  "new-name.md": "moved body\nline two\n",
};
const V3: Record<string, string> = { ...V2, "keep.md": "keep two\n" };
const V4: Record<string, string> = Object.fromEntries(
  Object.entries(V3).filter(([path]) => path !== "empty.md"),
);

const BODIES: Record<number, Record<string, string>> = {
  1: {
    "also-keep.md": "steady\n",
    "doomed.md": "doomed\n",
    "drift.md": "alpha\nbeta\ngamma\ndelta\n",
    "keep.md": "keep one\n",
    "old-name.md": "moved body\nline two\n",
  },
  2: V2,
  3: V3,
  4: V4,
  5: V4,
};

const comment = (
  path: string,
  version: number,
  line: number,
  body: string,
) => ({
  comment_id: version * 100 + line,
  author: AUTHOR,
  created_at: "2026-01-06T00:00:00Z",
  body,
  anchor: {
    path,
    version,
    line_start: line,
    line_end: line,
    col_start: null,
    col_end: null,
    quote: "",
  },
  resolved: null,
  outdated: false,
  current_line_start: line,
  current_line_end: line,
});

function mockSpec(items: SpecComments["items"] = []) {
  const info: SpecInfo = {
    current_version: 5,
    review_status: "unreviewed",
    unresolved_comments: 0,
    files: Object.entries(BODIES[5] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: [1, 2, 3, 4, 5].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-01-0${number}T00:00:00Z`,
    })),
  };
  vi.spyOn(api, "getSpec").mockResolvedValue(info);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _number, version): Promise<SpecFiles> => {
      const v = version ?? 5;
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
  const comments: SpecComments = { current_version: 5, items };
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

/** The stack has rendered once the first entry box is on screen. */
async function stack(search: string) {
  const view = renderSpecView(search);
  await view.findByRole("button", { name: /finish review/i });
  await waitFor(() =>
    expect(
      view.container.querySelectorAll("[data-file-diff],[data-file-unchanged]")
        .length,
    ).toBeGreaterThan(0),
  );
  return view;
}

const marks = (view: { container: HTMLElement }, attribute: string) =>
  [...view.container.querySelectorAll(`[${attribute}]`)].map((el) =>
    el.getAttribute(attribute),
  );

describe("source stack draws every file (T-203)", () => {
  it("gives an untouched file a foldable block that loads its source", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    expect(marks(view, "data-file-unchanged")).toEqual([
      "also-keep.md",
      "keep.md",
    ]);
    expect(view.getAllByText(/unchanged since v1/)).toHaveLength(2);
    expect(view.queryAllByTestId("file-view")).toHaveLength(0);

    fireEvent.click(view.getAllByRole("button", { name: /show file/ })[0]!);
    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
  });

  it("unfolds the file a link points at", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1&file=keep.md");
    await waitFor(() =>
      expect(view.getAllByTestId("file-view")).toHaveLength(1),
    );
  });

  it("carries an unfolded file's comments from both versions", async () => {
    mockSpec([
      comment("keep.md", 1, 1, "was this line always here?"),
      comment("keep.md", 2, 1, "yes, since v1"),
      comment("also-keep.md", 2, 1, "belongs to the other block"),
    ]);
    const view = await stack("?v=2&compare=1&file=keep.md");
    const block = view.container.querySelector(
      '[data-file-unchanged="keep.md"]',
    ) as HTMLElement;
    await waitFor(() =>
      expect(
        block.querySelectorAll('[data-testid="file-annotation"]'),
      ).toHaveLength(2),
    );
    expect(block.textContent).toContain("was this line always here?");
    expect(block.textContent).toContain("yes, since v1");
    expect(block.textContent).not.toContain("belongs to the other block");
  });

  it("keeps ↑↓ on the differing files only", async () => {
    mockSpec();
    // v2→v3 touches keep.md and nothing else; four blocks sit around it.
    const view = await stack("?v=3&compare=2");
    expect(marks(view, "data-file-diff")).toEqual(["keep.md"]);
    expect(marks(view, "data-file-unchanged")).toHaveLength(4);
    const next = view.getByRole("button", { name: /^next / });
    expect(next.hasAttribute("disabled")).toBe(true);
    expect(next.getAttribute("aria-label")).toContain("Only one file differs");
  });

  it("states an empty file's arrival and departure instead of dropping it", async () => {
    mockSpec();
    const added = await stack("?v=2&compare=1");
    expect(added.getByText(/Empty file — added in v2\./)).toBeTruthy();
    expect(added.queryByText(/are identical/)).toBeNull();
    added.unmount();

    const removed = await stack("?v=4&compare=3");
    expect(removed.getByText(/Empty file — removed in v4\./)).toBeTruthy();
    expect(removed.queryByText(/are identical/)).toBeNull();
  });

  it("still says two identical versions are identical, blocks and all", async () => {
    mockSpec();
    const view = await stack("?v=5&compare=4");
    expect(view.getByText("v4 and v5 are identical.")).toBeTruthy();
    expect(marks(view, "data-file-diff")).toHaveLength(0);
    expect(marks(view, "data-file-unchanged")).toHaveLength(4);
  });
});

describe("rename detection on the spec page (T-203)", () => {
  it("draws a pure rename as one entry and drops the old rail row", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    expect(marks(view, "data-file-diff")).toEqual([
      "doomed.md",
      "drifted.md",
      "empty.md",
      "new-name.md",
    ]);
    expect(view.getByText(/renamed from old-name\.md/)).toBeTruthy();
    const rail = view
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("file="));
    expect(rail.some((href) => href.includes("new-name.md"))).toBe(true);
    expect(rail.some((href) => href.includes("old-name.md"))).toBe(false);
  });

  it("keeps a renamed file's edits as a diff under both paths", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=1");
    const entry = view.container.querySelector(
      '[data-file-diff="drifted.md"]',
    ) as HTMLElement;
    expect(entry.textContent).toContain("drift.md");
    expect(entry.textContent).toContain("drifted.md");
    expect(entry.querySelector('[data-testid="diff"]')).toBeTruthy();
  });

  it("reads a renamed file against its old path in the rendered view", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=drifted.md&compare=1&view=rendered");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/renamed from drift\.md/);
    // The baseline followed the old path, so the edit washes up as a change
    // rather than the whole file reading as new.
    await waitFor(() =>
      expect(
        view.container.querySelectorAll(".spec-changed, .spec-ins-block")
          .length,
      ).toBeGreaterThan(0),
    );
  });
});

describe("the paths out of a removed file (T-203)", () => {
  it("opens the source diff when compare has fallen behind the version", async () => {
    mockSpec();
    const view = await stack("?v=2&compare=2&file=doomed.md");
    expect(view.queryByText(/was removed in v2/)).toBeNull();
    expect(marks(view, "data-file-diff")).toContain("doomed.md");
  });

  it("still hands a removed file to the notice in the rendered view", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=doomed.md");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/was removed in v2/);
    expect(
      view
        .getByRole("link", { name: /open the source diff/i })
        .getAttribute("href"),
    ).toBe("/projects/demo/issues/1/spec?file=doomed.md&v=2&compare=1");
  });

  it("drops the orphaned file when comparing is switched off there", async () => {
    mockSpec();
    const view = renderSpecView("?v=2&file=doomed.md");
    await view.findByRole("button", { name: /finish review/i });
    await view.findByText(/was removed in v2/);
    fireEvent.click(
      screen.getByRole("button", { name: /turn comparing off$/i }),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ v: 2 }),
    );
    expect(view.queryByText(/File not found/)).toBeNull();
  });
});
