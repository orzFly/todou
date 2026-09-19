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
import { RevisionHistory } from "../src/components/shared/revision-history.tsx";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// The real diff renders in a shadow root happy-dom cannot lay out; the stub
// surfaces the one option this suite is about as an attribute instead. The
// filename comes with it so a diff belonging to the spec page cannot be
// mistaken for one belonging to an edit history.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    oldFile,
    newFile,
    options,
  }: {
    oldFile?: { name: string };
    newFile?: { name: string };
    options: { overflow?: string };
  }) => (
    <div
      data-testid="diff"
      data-file={newFile?.name ?? oldFile?.name ?? "unknown"}
      data-overflow={options.overflow ?? "unset"}
    />
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
    current_version_cursor: "c2",
    review_status: "unreviewed",
    unresolved_comments: 0,
    unresolved_carried_comments: 0,
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
  it("yields the display slot to fold outside the source views", async () => {
    // The slot never empties out — a slot that does is a slot that moves
    // things (T-190, T-192) — but what fills it on a rendered view is the
    // toggle that view can honour (T-222).
    mockSpec();
    const view = renderSpecView("?v=2");
    await view.findByRole("button", { name: /finish review/i });
    expect(view.queryByRole("button", { name: /^wrap/ })).toBeNull();
    expect(view.getByRole("button", { name: /^fold/ })).toBeTruthy();
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

const SPEC_KEY = "todou-spec-diff-wrap";
const HISTORY_KEY = "todou-edit-history-wrap";

const REVISION = {
  id: 3,
  actor: AUTHOR,
  created_at: "2026-08-12T10:00:00Z",
  body_before: "old text",
  body_after: "new text",
  agent_context: null,
};

/**
 * The real edit history, entered the way a reader does. Both surfaces label
 * their control "wrap long lines", so the two are never on screen together
 * here: each is mounted, driven and unmounted before the other appears.
 */
function renderEditHistory() {
  return renderWithProviders(
    <RevisionHistory
      label="comment"
      editedAt={REVISION.created_at}
      filename="comment.md"
      queryKey={["revisions", "demo", 1, "comment", 17]}
      fetchRevisions={() => Promise.resolve({ items: [REVISION] })}
    />,
  );
}

async function openEditHistoryDiff() {
  fireEvent.click(await screen.findByText("(edited)"));
  const list = await screen.findByRole("dialog", { name: "" });
  fireEvent.click(await within(list).findByRole("button", { name: /User/ }));
  return await screen.findByRole("dialog", { name: "Edit history — comment" });
}

async function expectHistoryMode(dialog: HTMLElement, wrap: boolean) {
  await waitFor(() => {
    const diff = within(dialog).getByTestId("diff");
    expect(diff.getAttribute("data-file")).toBe("comment.md");
    expect(diff.getAttribute("data-overflow")).toBe(wrap ? "wrap" : "scroll");
  });
  expect(
    within(dialog)
      .getByRole("button", { name: "wrap long lines" })
      .getAttribute("aria-pressed"),
  ).toBe(String(wrap));
}

async function expectSpecMode(
  view: ReturnType<typeof renderSpecView>,
  wrap: boolean,
) {
  const toggle = await view.findByRole("button", { name: /wrap/i });
  expect(toggle.getAttribute("aria-pressed")).toBe(String(wrap));
  await waitFor(() => {
    const diff = view.getByTestId("diff");
    expect(diff.getAttribute("data-file")).toBe("design.md");
    expect(diff.getAttribute("data-overflow")).toBe(wrap ? "wrap" : "scroll");
  });
  return toggle;
}

describe("edit history and the spec diff stay independent (T-425)", () => {
  it("S1: a spec diff switched off neither reaches nor is reached by edit history", async () => {
    localStorage.setItem(SPEC_KEY, "off");
    mockSpec();
    const spec = renderSpecView("?v=2&compare=1");
    await expectSpecMode(spec, false);
    spec.unmount();

    // Nothing is saved under the edit-history key, so it opens wrapping.
    // Reading the spec key instead would open it scrolling.
    const history = renderEditHistory();
    const dialog = await openEditHistoryDiff();
    await expectHistoryMode(dialog, true);
    const toggle = within(dialog).getByRole("button", {
      name: "wrap long lines",
    });
    fireEvent.click(toggle);
    await expectHistoryMode(dialog, false);
    fireEvent.click(toggle);
    await expectHistoryMode(dialog, true);
    history.unmount();

    expect(localStorage.getItem(HISTORY_KEY)).toBe("on");
    expect(localStorage.getItem(SPEC_KEY)).toBe("off");

    // …and the spec diff is where it was left, not where edit history went.
    await expectSpecMode(renderSpecView("?v=2&compare=1"), false);
  });

  it("S2: edit history switched off neither reaches nor is reached by the spec diff", async () => {
    localStorage.setItem(HISTORY_KEY, "off");
    mockSpec();
    const history = renderEditHistory();
    await expectHistoryMode(await openEditHistoryDiff(), false);
    history.unmount();

    const spec = renderSpecView("?v=2&compare=1");
    const toggle = await expectSpecMode(spec, true);
    fireEvent.click(toggle);
    await expectSpecMode(spec, false);
    fireEvent.click(toggle);
    await expectSpecMode(spec, true);
    spec.unmount();

    expect(localStorage.getItem(SPEC_KEY)).toBe("on");
    expect(localStorage.getItem(HISTORY_KEY)).toBe("off");

    renderEditHistory();
    await expectHistoryMode(await openEditHistoryDiff(), false);
  });
});
