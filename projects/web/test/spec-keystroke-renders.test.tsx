import { EditorView } from "@codemirror/view";
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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import { specFilesQuery, specQuery } from "../src/api/spec.ts";
import { MarkdownViewWithPlugins } from "../src/components/shared/markdown-view.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { MARKDOWN_SYNTAX_PLUGINS } from "../src/lib/markdown-processor.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// T-599: react-markdown keeps no parse cache, so every render of the spec
// document re-parsed all of it. Typing a review comment re-rendered the page
// once per keystroke, which on a long spec cost a frame or more per key.
// Two independent guards, each holding on its own: the page must not
// re-render the document for a keystroke, and the markdown view must not
// re-parse when re-rendered with the same props.

const counts = vi.hoisted(() => ({ markdown: 0, annotated: 0 }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Original = actual.default;
  return {
    ...actual,
    default: (props: Parameters<typeof Original>[0]) => {
      counts.markdown++;
      return <Original {...props} />;
    },
  };
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

const SPEC: SpecInfo = {
  current_version: 1,
  current_version_cursor: "c1",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "a.md", size: 12 }],
  versions: [
    {
      number: 1,
      author: {
        id: 2,
        login: "bot-one",
        display_name: "Bot One",
        kind: "machine",
        avatar_url: null,
        owner: null,
      },
      message: "v1",
      created_at: "2026-01-01T00:00:00Z",
    },
  ],
};
const V1: SpecFiles = {
  version: 1,
  files: [{ path: "a.md", body: "version one\n", size: 12 }],
};
const COMMENTS: SpecComments = { current_version: 1, items: [] };

function renderSpec() {
  vi.spyOn(api, "getSpec").mockResolvedValue(SPEC);
  vi.spyOn(api, "getSpecFiles").mockResolvedValue(V1);
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
  client.setQueryData(["spec", "demo", 7, "comments"], COMMENTS);
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function editorOf(content: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error("content has no EditorView");
  return view;
}

function type(view: EditorView, text: string) {
  for (const char of text)
    act(() => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: char },
        userEvent: "input.type",
      });
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("typing on the spec page (T-599)", () => {
  it("leaves the document alone while a comment is typed", async () => {
    const view = renderSpec();
    await view.findByText("version one");
    fireEvent.click(await view.findByRole("button", { name: "Comment file" }));
    const composer = editorOf(
      (await view.findByLabelText("Spec comment")) as HTMLElement,
    );
    // Opening the composer may settle the page; only keystrokes are judged.
    await act(async () => {});
    const before = counts.annotated;
    type(composer, "a comment");
    expect(composer.state.doc.toString()).toBe("a comment");
    expect(counts.annotated).toBe(before);
  });

  it("leaves the document alone while a review summary is typed", async () => {
    const view = renderSpec();
    await view.findByText("version one");
    fireEvent.click(
      await view.findByRole("button", { name: /finish review/i }),
    );
    const summary = editorOf(
      (await view.findByLabelText("Review summary")) as HTMLElement,
    );
    await act(async () => {});
    const before = counts.annotated;
    type(summary, "a summary");
    expect(summary.state.doc.toString()).toBe("a summary");
    expect(counts.annotated).toBe(before);
  });
});

describe("MarkdownViewWithPlugins (T-599)", () => {
  it("does not re-parse when its host re-renders with the same props", async () => {
    let bump = () => {};
    function Host() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return (
        <div data-n={n}>
          <MarkdownViewWithPlugins remarkPlugins={MARKDOWN_SYNTAX_PLUGINS}>
            {"stable body"}
          </MarkdownViewWithPlugins>
        </div>
      );
    }
    const view = renderWithProviders(<Host />);
    await view.findByText("stable body");
    const before = counts.markdown;
    act(() => bump());
    act(() => bump());
    expect(counts.markdown).toBe(before);
  });
});
