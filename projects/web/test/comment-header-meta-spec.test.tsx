import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type {
  SpecCommentItem,
  SpecComments,
  SpecFiles,
  SpecInfo,
} from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import {
  expectHeaderMeta,
  expectSplitHeader,
  headerItems,
  headerRowOf,
} from "./header-meta.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The four spec-document places a comment draws its own header (T-435), each
 * reached through the real `SpecViewPage` so the props come down the chain
 * the product uses rather than from a hand-built call.
 *
 * Both pierre renderers consume `lineAnnotations`/`renderAnnotation` here.
 * spec-source-stack's mock draws `MultiFileDiff` as an empty div, so a suite
 * built on that one can never see the diff's own annotation header — the two
 * production paths into `DiffAnnotation` would look like one.
 */
vi.mock("@pierre/diffs/react", () => {
  const annotations = (
    testid: string,
    lineAnnotations?: Array<{ lineNumber: number; metadata: unknown }>,
    renderAnnotation?: (a: { metadata: unknown }) => ReactNode,
  ) => (
    <div data-testid={testid}>
      {(lineAnnotations ?? []).map((annotation, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: several annotations can share a line
          key={index}
          data-testid={`${testid}-annotation`}
          data-line={annotation.lineNumber}
        >
          {renderAnnotation?.(annotation)}
        </div>
      ))}
    </div>
  );
  return {
    MultiFileDiff: ({
      lineAnnotations,
      renderAnnotation,
    }: {
      lineAnnotations?: Array<{ lineNumber: number; metadata: unknown }>;
      renderAnnotation?: (a: { metadata: unknown }) => ReactNode;
    }) => annotations("diff-view", lineAnnotations, renderAnnotation),
    File: ({
      lineAnnotations,
      renderAnnotation,
    }: {
      lineAnnotations?: Array<{ lineNumber: number; metadata: unknown }>;
      renderAnnotation?: (a: { metadata: unknown }) => ReactNode;
    }) => annotations("file-view", lineAnnotations, renderAnnotation),
    CodeView: () => null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const CREATED = "2026-08-12T00:00:00Z";
const SLUG = "demo";
const NUMBER = 1;
const href = (id: number) => `/projects/${SLUG}/issues/${NUMBER}#comment-${id}`;

const AUTHOR = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const BODIES: Record<number, Record<string, string>> = {
  1: {
    "design.md": "alpha paragraph\n\nbeta paragraph\n\ngamma paragraph\n",
    "steady.md": "steady one\n\nsteady two\n",
  },
  2: {
    "design.md": "alpha paragraph\n\nrevised paragraph\n\ngamma paragraph\n",
    "steady.md": "steady one\n\nsteady two\n",
  },
};

function annotation(
  commentId: number,
  anchor: Partial<SpecCommentItem["anchor"]>,
  extra: Partial<SpecCommentItem> = {},
): SpecCommentItem {
  const lineStart = anchor.line_start ?? null;
  return {
    comment_id: commentId,
    author: AUTHOR,
    created_at: CREATED,
    body: `review note ${commentId}`,
    anchor: {
      path: "design.md",
      version: 2,
      line_start: lineStart,
      line_end: anchor.line_end ?? lineStart,
      col_start: null,
      col_end: null,
      quote: "",
      ...anchor,
    },
    resolved: null,
    outdated: false,
    current_line_start: lineStart,
    current_line_end: anchor.line_end ?? lineStart,
    ...extra,
  };
}

/** File-level: no line to sit on, so it lands in the File comments strip. */
const FILE_LEVEL = annotation(401, { line_start: null, line_end: null });
/** On a v2 line of design.md: the rendered chip and the diff's own header. */
const ON_DESIGN = annotation(402, { line_start: 3, line_end: 3 });
/** Anchored to v1 and stale, which is what leaves it without a place in v2. */
const OUTDATED = annotation(
  403,
  { version: 1, line_start: 3, line_end: 3 },
  { outdated: true, current_line_start: null, current_line_end: null },
);
/** On the file the two versions leave untouched — the unfold path. */
const ON_STEADY = annotation(404, {
  path: "steady.md",
  line_start: 1,
  line_end: 1,
});

function mockSpec(items: SpecComments["items"]) {
  const info: SpecInfo = {
    current_version: 2,
    current_version_cursor: "c2",
    review_status: "unreviewed",
    unresolved_comments: items.length,
    unresolved_carried_comments: 0,
    files: Object.entries(BODIES[2] ?? {}).map(([path, body]) => ({
      path,
      size: body.length,
    })),
    versions: [1, 2].map((number) => ({
      number,
      author: AUTHOR,
      message: `v${number}`,
      created_at: `2026-08-0${number}T00:00:00Z`,
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
    items,
  } satisfies SpecComments);
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
      initialEntries: [`/projects/${SLUG}/issues/${NUMBER}/spec${search}`],
    }),
    defaultPendingMs: 0,
  });
  return {
    ...render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

/** The page has settled once its toolbar is up. */
async function page(search: string) {
  const view = renderSpecView(search);
  await view.findByRole("button", { name: /finish review/i });
  return view;
}

describe("spec annotation headers carry the id and time (T-435)", () => {
  it("gives a file-level comment its id and creation time", async () => {
    mockSpec([FILE_LEVEL]);
    const view = await page("?v=2&view=rendered&file=design.md");
    const strip = (await view.findByText("File comments"))
      .parentElement as HTMLElement;
    expectHeaderMeta(strip, href(401), 401, CREATED);
    // The strip is still the resolve affordance it was.
    expect(strip.querySelector("button")?.textContent).toContain("Resolve");
  });

  it("gives a comment with no place left in this version the same pair", async () => {
    mockSpec([OUTDATED]);
    const view = await page("?v=2&view=rendered&file=design.md");
    const strip = (await view.findByText(/Comments without a place in v2/))
      .parentElement as HTMLElement;
    expectHeaderMeta(strip, href(403), 403, CREATED);
    expect(strip.textContent).toContain("outdated");
  });

  it("gives the rendered document's published bubble the same pair", async () => {
    mockSpec([ON_DESIGN]);
    const view = await page("?v=2&view=rendered&file=design.md");
    fireEvent.click(await view.findByLabelText("1 comment(s) on this block"));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-slot='popover-content']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expectHeaderMeta(popover, href(402), 402, CREATED);
    // The locate control and the version it points at are untouched, and
    // neither became the id's destination.
    expect(popover.textContent).toContain("v2");
    expect(
      popover.querySelector("button[title='Scroll to what this points at']"),
    ).not.toBeNull();
    expect(popover.querySelector("a[href*='/spec']")).toBeNull();

    // Radix's portal and happy-dom disagree about who owns a detached
    // content node, so an open popover throws out of `cleanup`.
    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='popover-content']"),
      ).toBeNull(),
    );
  });

  it("gives an inline annotation in the source diff the same pair", async () => {
    mockSpec([ON_DESIGN]);
    const view = await page("?v=2&compare=1&view=source");
    const card = await waitFor(() => {
      const els = view.container.querySelectorAll(
        "[data-testid='diff-view-annotation']",
      );
      expect(els.length).toBeGreaterThan(0);
      return els[0] as HTMLElement;
    });
    expectHeaderMeta(card, href(402), 402, CREATED);
    expect(card.textContent).toContain("review note 402");
  });

  it("gives an inline annotation in a single version's source the same pair", async () => {
    mockSpec([annotation(405, { version: 1, line_start: 1, line_end: 1 })]);
    // v1 has no earlier version to compare against, so the page reads one
    // version whole — the `File` path rather than the diff.
    const view = await page("?v=1&file=design.md");
    fireEvent.click(
      await view.findByTitle("Read this version's raw markdown source"),
    );
    const card = await waitFor(() => {
      const els = view.container.querySelectorAll(
        "[data-testid='file-view-annotation']",
      );
      expect(els.length).toBeGreaterThan(0);
      return els[0] as HTMLElement;
    });
    expectHeaderMeta(card, href(405), 405, CREATED);
  });

  it("gives an unchanged file's unfolded annotation the same pair", async () => {
    mockSpec([ON_STEADY]);
    const view = await page("?v=2&compare=1&view=source&file=steady.md");
    const card = await waitFor(() => {
      const block = view.container.querySelector(
        "[data-file-unchanged='steady.md']",
      );
      expect(block).not.toBeNull();
      const els = (block as HTMLElement).querySelectorAll(
        "[data-testid='file-view-annotation']",
      );
      expect(els.length).toBeGreaterThan(0);
      return els[0] as HTMLElement;
    });
    expectHeaderMeta(card, href(404), 404, CREATED);
  });

  it("keeps an unsubmitted draft out of the id and time entirely", async () => {
    // Straight to `AnnotatedMarkdown`, as spec-draft-edit does: a draft lives
    // in the reviewer's own session and never reaches the comments listing
    // the page above is built from.
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug={SLUG}
        issueNumber={NUMBER}
        body={"Alpha beta gamma.\n"}
        annotations={[
          {
            key: "d1",
            kind: "draft",
            draft: {
              id: "d1",
              anchor: {
                path: "design.md",
                version: 2,
                line_start: 1,
                line_end: 1,
                col_start: null,
                col_end: null,
              },
              quote: "Alpha beta gamma.",
              body: "needs a caveat",
            },
            start: 1,
            end: 1,
            colStart: null,
            colEnd: null,
          },
        ]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    fireEvent.click(await view.findByLabelText(/comment\(s\) on this block/));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-slot='popover-content']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(popover.textContent).toContain("needs a caveat");
    expect(popover.textContent).toContain("draft");
    // No id to link, so no link, no token and no time are invented for it.
    expect(popover.textContent).not.toContain("#comment-");
    expect(popover.querySelector("time")).toBeNull();
    expect(popover.querySelector("a[href*='#comment-']")).toBeNull();
    // Its own two controls are still there.
    expect(popover.textContent).toContain("Edit");
    expect(popover.textContent).toContain("Discard");

    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='popover-content']"),
      ).toBeNull(),
    );
  });
});

/** Already dealt with: the branch where `resolved` replaces the button. */
const RESOLVED = annotation(
  406,
  { line_start: null, line_end: null },
  { resolved: { by: AUTHOR, at: "2026-08-13T00:00:00Z" } },
);
const RESOLVED_ON_DESIGN = annotation(
  407,
  { line_start: 3, line_end: 3 },
  { resolved: { by: AUTHOR, at: "2026-08-13T00:00:00Z" } },
);

/**
 * The narrow-screen split (T-445) across the four spec-document entry
 * points, both branches of the two that carry a control. Geometry belongs to
 * scripts/user-baseline-smoke.mjs; these grade which elements ask for it.
 */
describe("spec annotation headers split in two below sm (T-445)", () => {
  it("splits the file-comments strip and keeps its spacer", async () => {
    mockSpec([FILE_LEVEL]);
    const view = await page("?v=2&view=rendered&file=design.md");
    const strip = (await view.findByText("File comments"))
      .parentElement as HTMLElement;
    const row = headerRowOf(strip);
    expectSplitHeader(row, {
      identity: ["Alice", "v2"],
      actions: [row.querySelector("button")],
      spacer: true,
    });
  });

  it("splits it the same way once the annotation is resolved", async () => {
    mockSpec([RESOLVED]);
    const view = await page("?v=2&view=rendered&file=design.md");
    const strip = (await view.findByText("File comments"))
      .parentElement as HTMLElement;
    const row = headerRowOf(strip);
    // No button left, so the `resolved` mark is what holds the right-hand
    // column — the branch a fix applied only to the button would miss.
    expect(row.querySelector("button")).toBeNull();
    expectSplitHeader(row, {
      identity: ["Alice", "v2"],
      actions: [
        headerItems(row).find((child) => child.textContent === "resolved"),
      ],
      spacer: true,
    });
  });

  it("splits the strip for comments with no place left in this version", async () => {
    mockSpec([OUTDATED]);
    const view = await page("?v=2&view=rendered&file=design.md");
    const strip = (await view.findByText(/Comments without a place in v2/))
      .parentElement as HTMLElement;
    const row = headerRowOf(strip);
    expectSplitHeader(row, {
      identity: ["Alice", "v1", "outdated"],
      actions: [row.querySelector("button")],
      spacer: true,
    });
  });

  it("splits the rendered document's published bubble", async () => {
    mockSpec([ON_DESIGN]);
    const view = await page("?v=2&view=rendered&file=design.md");
    fireEvent.click(await view.findByLabelText("1 comment(s) on this block"));
    const popover = await waitFor(() => {
      const el = document.querySelector("[data-slot='popover-content']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const row = headerRowOf(popover);
    // Not the first button in the row: the locate control is one too, and it
    // belongs to the identity group rather than to the reader's actions.
    expectSplitHeader(row, {
      identity: ["Alice", "v2"],
      actions: [
        [...row.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Resolve"),
        ),
      ],
      spacer: true,
    });

    fireEvent.keyDown(popover, { key: "Escape" });
    await waitFor(() =>
      expect(
        document.querySelector("[data-slot='popover-content']"),
      ).toBeNull(),
    );
  });

  it("splits the diff's own inline annotation, which has no control at all", async () => {
    mockSpec([RESOLVED_ON_DESIGN]);
    const view = await page("?v=2&compare=1&view=source");
    const card = await waitFor(() => {
      const els = view.container.querySelectorAll(
        "[data-testid='diff-view-annotation']",
      );
      expect(els.length).toBeGreaterThan(0);
      return els[0] as HTMLElement;
    });
    // Here `resolved` is a mark beside the author rather than a control, so
    // it belongs to the first line and the second column collapses.
    expectSplitHeader(headerRowOf(card), {
      identity: ["Alice", "v2", "resolved"],
    });
  });

  it("splits a single version's source annotation the same way", async () => {
    mockSpec([annotation(405, { version: 1, line_start: 1, line_end: 1 })]);
    const view = await page("?v=1&file=design.md");
    fireEvent.click(
      await view.findByTitle("Read this version's raw markdown source"),
    );
    const card = await waitFor(() => {
      const els = view.container.querySelectorAll(
        "[data-testid='file-view-annotation']",
      );
      expect(els.length).toBeGreaterThan(0);
      return els[0] as HTMLElement;
    });
    expectSplitHeader(headerRowOf(card), { identity: ["Alice", "v1"] });
  });
});
