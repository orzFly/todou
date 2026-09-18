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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Me, SpecComments, SpecFiles, SpecInfo } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import { specFilesQuery, specQuery } from "../src/api/spec.ts";
import { AppShell } from "../src/components/shell.tsx";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { hasUnsavedWork } from "../src/lib/unsaved-guard.ts";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { testQueryClient } from "./render.tsx";

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
  current_version: 3,
  current_version_cursor: "c3",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [
    { path: "a.md", size: 13 },
    { path: "b.md", size: 13 },
  ],
  versions: [1, 2, 3].map((number) => ({
    number,
    author: AUTHOR,
    message: `v${number}`,
    created_at: `2026-01-0${number}T00:00:00Z`,
  })),
};

const V1: SpecFiles = {
  version: 1,
  files: [
    { path: "a.md", body: "version one\n", size: 12 },
    { path: "b.md", body: "other one\n", size: 10 },
  ],
};
const V2: SpecFiles = {
  version: 2,
  files: [
    { path: "a.md", body: "version two\n", size: 12 },
    { path: "b.md", body: "other two\n", size: 10 },
  ],
};
const COMMENTS: SpecComments = { current_version: 3, items: [] };

function held<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function editorFromElement(content: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error("content has no EditorView");
  return view;
}

function setEditorValue(view: EditorView, value: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    userEvent: "input.type",
  });
}

function renderColdSpec() {
  const coldV2 = held<SpecFiles>();
  vi.spyOn(api, "getSpec").mockResolvedValue(SPEC);
  vi.spyOn(api, "getSpecFiles").mockImplementation(
    (_slug, _issueNumber, version) => {
      if (version === 2) return coldV2.promise;
      if (version === 1) return Promise.resolve(V1);
      return Promise.resolve({ ...V2, version: version ?? 3 });
    },
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
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>issue detail</div>,
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
      initialEntries: ["/projects/demo/issues/7/spec?v=1&file=a.md"],
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

  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, coldV2 };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("spec review drafts across navigation", () => {
  it("restores summary after closing Finish review (T-438)", async () => {
    const view = renderColdSpec();
    fireEvent.click(
      await view.findByRole("button", { name: /finish review/i }),
    );
    const firstEditor = editorFromElement(
      (await view.findByLabelText("Review summary")) as HTMLElement,
    );
    act(() => setEditorValue(firstEditor, "summary survives close"));

    fireEvent.click(view.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(view.queryByLabelText("Review summary")).toBeNull(),
    );
    expect(hasUnsavedWork()).toBe(true);

    fireEvent.click(view.getByRole("button", { name: /finish review/i }));
    const reopened = editorFromElement(
      (await view.findByLabelText("Review summary")) as HTMLElement,
    );
    expect(reopened.state.doc.toString()).toBe("summary survives close");
    expect(reopened).not.toBe(firstEditor);
  });

  it("keeps full composer and summary text through a cold version load", async () => {
    const view = renderColdSpec();
    await view.findByRole("button", { name: /finish review/i });
    fireEvent.click(view.getByRole("button", { name: "Comment file" }));
    const firstComposer = editorFromElement(
      (await view.findByLabelText("Spec comment")) as HTMLElement,
    );
    act(() => setEditorValue(firstComposer, "composer marker in full"));

    fireEvent.click(view.getByRole("button", { name: /finish review/i }));
    const firstSummary = editorFromElement(
      (await view.findByLabelText("Review summary")) as HTMLElement,
    );
    act(() => setEditorValue(firstSummary, "summary marker in full"));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    const versionTrigger = view.getByRole("button", {
      name: /switch version/i,
    });
    fireEvent.pointerDown(versionTrigger, { button: 0, pointerType: "mouse" });
    const toV2 = (await screen.findAllByRole("menuitem")).find((item) =>
      item.getAttribute("href")?.includes("v=2"),
    );
    fireEvent.click(toV2 as HTMLElement);

    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ v: 2 }),
    );
    expect(hasUnsavedWork()).toBe(true);
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();

    await act(async () => {
      view.coldV2.release(V2);
    });
    await waitFor(() =>
      expect(view.container.querySelector("main")?.textContent).toContain(
        "version onetwo",
      ),
    );

    const restoredComposer = editorFromElement(
      (await view.findByLabelText("Spec comment")) as HTMLElement,
    );
    expect(restoredComposer.state.doc.toString()).toBe(
      "composer marker in full",
    );
    expect(view.container.querySelector("main")?.textContent).toContain(
      "a.mdfile comment · v1",
    );

    fireEvent.click(view.getByRole("button", { name: /finish review/i }));
    const restoredSummary = editorFromElement(
      (await view.findByLabelText("Review summary")) as HTMLElement,
    );
    expect(restoredSummary.state.doc.toString()).toBe("summary marker in full");
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    act(() => setEditorValue(restoredComposer, "composer marker in full!"));
    fireEvent.click(view.getByRole("button", { name: "Stage comment" }));
    const stored = JSON.parse(
      localStorage.getItem("todou-spec-review:demo:7") ?? "[]",
    );
    expect(stored).toMatchObject([
      {
        anchor: { path: "a.md", version: 1 },
        body: "composer marker in full!",
      },
    ]);
  });

  it("keeps a warm file navigation in the same editor and blocks a real exit", async () => {
    const view = renderColdSpec();
    await view.findByRole("button", { name: /finish review/i });
    fireEvent.click(view.getByRole("button", { name: "Comment file" }));
    const composer = editorFromElement(
      (await view.findByLabelText("Spec comment")) as HTMLElement,
    );
    act(() => setEditorValue(composer, "file navigation marker"));

    const otherFile = view
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.includes("file=b.md"));
    expect(otherFile).toBeDefined();
    fireEvent.click(otherFile as HTMLElement);
    await waitFor(() =>
      expect(view.router.state.location.search).toMatchObject({ file: "b.md" }),
    );
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
    expect(
      editorFromElement(screen.getByLabelText("Spec comment") as HTMLElement),
    ).toBe(composer);
    expect(composer.state.doc.toString()).toBe("file navigation marker");
    expect(view.container.querySelector("main")?.textContent).toContain(
      "a.mdfile comment · v1",
    );

    void view.router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug: "demo", number: "7" },
    });
    expect(await screen.findByText("Leave with unsaved changes?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(view.router.state.location.pathname).toBe(
      "/projects/demo/issues/7/spec",
    );
    expect(composer.state.doc.toString()).toBe("file navigation marker");
  });

  it("keeps a pending staged review occupied after leaving and reentering", async () => {
    const response = held<{
      version: number;
      verdict: "comment";
      event_id: number;
      summary_comment_id: null;
      comment_ids: number[];
    }>();
    const submit = vi
      .spyOn(api, "submitSpecReview")
      .mockReturnValue(response.promise);
    const view = renderColdSpec();
    fireEvent.click(await view.findByRole("button", { name: "Comment file" }));
    act(() =>
      setEditorValue(
        editorFromElement(screen.getByLabelText("Spec comment") as HTMLElement),
        "duplicate probe",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stage comment" }));
    fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Submit" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Comment only" }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    void view.router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug: "demo", number: "7" },
    });
    await screen.findByText("Leave with unsaved changes?");
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await screen.findByText("issue detail");
    await view.router.navigate({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: "7" },
      search: { v: 1, file: "a.md" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /finish review/i }),
    );

    const pending = await screen.findByRole("button", {
      name: "Submitting…",
    });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.release({
        version: 1,
        verdict: "comment",
        event_id: 9,
        summary_comment_id: null,
        comment_ids: [1],
      });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Submit" }), {
      button: 0,
      pointerType: "mouse",
    });
    expect(
      (
        await screen.findByRole("menuitem", {
          name: "Comment only",
        })
      ).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});
