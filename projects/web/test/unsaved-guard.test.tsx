import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Issue, Me, QuestionsComponent } from "@todou/shared";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  projectsQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import {
  type StagedFiles,
  useStagedFiles,
} from "../src/components/issue/staged-files.tsx";
import { MarkdownEditor } from "../src/components/shared/markdown-editor.tsx";
import { AppShell } from "../src/components/shell.tsx";
import { useCommentComposer } from "../src/components/timeline/composer.tsx";
import { QuestionsCard } from "../src/components/timeline/questions-card.tsx";
import {
  hasUnsavedWork,
  registerDirtySource,
  useDirtySource,
} from "../src/lib/unsaved-guard.ts";
import { Sidebar, TitleBlock } from "../src/pages/issue-detail.tsx";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
import {
  renderOnTheAppRouter as renderOnTheAppRouterShared,
  restoreAppRouterPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { cmSetValue } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

describe("the unsaved-work registry", () => {
  it("reports nothing while no surface is registered", () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it("follows a registered predicate and forgets it on unregister", () => {
    const unregister = registerDirtySource(() => true);
    expect(hasUnsavedWork()).toBe(true);
    unregister();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("is dirty when any one of several registrants is", () => {
    const clear = registerDirtySource(() => false);
    const dirty = registerDirtySource(() => true);
    expect(hasUnsavedWork()).toBe(true);
    clear();
    dirty();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("stops asking a component once it unmounts", () => {
    let asked = 0;
    const hook = renderHook(() =>
      useDirtySource(() => {
        asked++;
        return true;
      }),
    );
    expect(hasUnsavedWork()).toBe(true);
    expect(asked).toBe(1);

    hook.unmount();
    hasUnsavedWork();
    expect(asked).toBe(1);
  });

  it("asks today's predicate after a re-render, not the first one", () => {
    const hook = renderHook(
      ({ dirty }: { dirty: boolean }) => useDirtySource(() => dirty),
      { initialProps: { dirty: false } },
    );
    expect(hasUnsavedWork()).toBe(false);
    hook.rerender({ dirty: true });
    expect(hasUnsavedWork()).toBe(true);
  });
});

/**
 * The shim tree `shell-stays-during-navigation.test.tsx` established: a
 * pathless "authed" route between the root and `/projects/$slug`, because
 * a page reading its params strictly would otherwise be a route table the app
 * does not have.
 *
 * Its memory history is the only way the in-app half of the guard can be
 * driven. The app's own router carries a browser history, and a click that
 * ends in that router's resolve path sets `window.location`. `beforeunload`
 * is the opposite case and needs the real router — see the last test in this
 * file.
 */
function renderGuardTree({ editor }: { editor?: boolean } = {}) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => (
      <AppShell me={me}>
        <Outlet />
      </AppShell>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    component: () => (
      <>
        <Link
          to="/projects/$slug/issues/$number"
          params={{ slug: "alpha", number: "12" }}
        >
          open the card
        </Link>
        {editor === true && <MarkdownEditor ariaLabel="Draft" />}
      </>
    ),
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>the card</div>,
  });
  const testRouter = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([listRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects/alpha"] }),
  });
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

/** RouterProvider mounts its match asynchronously; the editor arrives after. */
async function typeIntoEditor(view: { container: HTMLElement }, text: string) {
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-slot="markdown-editor"]'),
    ).not.toBeNull(),
  );
  cmSetValue(view.container, text);
}

const link = () => screen.findByText("open the card");

/**
 * The app's own router, for the one thing a shim cannot reach: it is built on
 * the browser history, and only that implementation installs a `beforeunload`
 * listener (`@tanstack/history`, `onBeforeUnload`). The fixture lives in
 * `test/app-router.tsx`, shared with the T-330 suite, which needs the same
 * listener for the same reason.
 *
 * Both queries are seeded because the listener only answers while the shell is
 * on screen, and the shell is what `AuthedLayout` stops drawing the moment
 * `/api/me` fails — the suite's offline `fetch` 404s it, so an unseeded mount
 * replaces the whole tree, guard and history block included, one flush after
 * it appeared (T-323). `/` redirects to `/projects`, whose page suspends on
 * `projectsQuery`, and an unseeded throw there reaches the root boundary,
 * which costs the shell the same way.
 */
function renderOnTheAppRouterClean() {
  const client = testQueryClient();
  client.setQueryData(meQuery.queryKey, me);
  client.setQueryData(projectsQuery.queryKey, []);
  const mounted = renderOnTheAppRouterShared(client);
  return {
    ...mounted,
    // Restores the page after testing-library's own unmount has taken the
    // guard down, so nothing refuses the URL `replace` the restore needs.
    unmount: () => {
      mounted.unmount();
      restoreAppRouterPage();
    },
  };
}

afterAll(teardownAppRouter);

/**
 * A promise the test releases by hand: what the guard is asked about is a
 * write that is still in flight, so it has to stay in flight across the read.
 */
function held<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const CARD: Issue = {
  id: 11,
  number: 7,
  title: "Fix the potato",
  body: "the first draft",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
};

function renderTitleBlock() {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <TitleBlock slug="p" issue={CARD} />
    </QueryClientProvider>,
  );
}

/** The sidebar's own sections reach for router context, so the shim carries it. */
function renderSidebar() {
  const client = testQueryClient();
  // `useCanCreateLabels` suspends on the project, and a suspending query
  // without a seed renders the shell's spinner, not the sidebar.
  client.setQueryData(projectQuery("p").queryKey, {
    id: 1,
    slug: "p",
    name: "p",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "writer",
  });
  return renderWithProviders(
    <Sidebar
      slug="p"
      issue={CARD}
      statuses={[CARD.status]}
      allLabels={[{ id: 10, name: "bug", color: "#ff0000" }]}
      members={[]}
      canDelete={false}
      trashed={false}
    />,
    client,
  );
}

describe("the surfaces a form loses along with its text", () => {
  /**
   * Each of these is a predicate the guard has to be told about separately —
   * a title, a picked option, a staged attachment, an unsent comment — none
   * of which is a markdown document, so nothing else would report them.
   */
  it("counts a title with an empty description box", async () => {
    mountNewIssue();
    expect(hasUnsavedWork()).toBe(false);

    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Dig up the potatoes" },
    });

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
  });

  it("counts a picked option, with no Other text typed", async () => {
    mountQuestionsCard();
    await screen.findByText("awaiting answer");
    expect(hasUnsavedWork()).toBe(false);

    fireEvent.click(optionButton("New entity"));

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
  });

  it("counts a decline on its own", async () => {
    mountQuestionsCard();
    await screen.findByText("awaiting answer");
    expect(hasUnsavedWork()).toBe(false);

    fireEvent.click(optionButton("Decline to answer"));

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
  });

  it("counts a staged attachment that was never uploaded", async () => {
    const tray = mountStagedFiles();
    expect(hasUnsavedWork()).toBe(false);

    act(() => {
      tray.stage([new File(["bytes"], "shot.png", { type: "image/png" })]);
    });

    expect(hasUnsavedWork()).toBe(true);

    act(() => {
      tray.remove(tray.staged[0]?.key ?? 0);
    });
    expect(hasUnsavedWork()).toBe(false);
  });

  it("counts a comment whose send failed", async () => {
    vi.spyOn(api, "createComment").mockRejectedValue(new Error("offline"));
    const composer = renderHook(() => useCommentComposer("p", 7, me), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={testQueryClient()}>
          {children}
        </QueryClientProvider>
      ),
    });
    expect(hasUnsavedWork()).toBe(false);

    act(() =>
      composer.result.current.send("a comment that will fail", {
        slug: "p",
        issueNumber: 7,
      }),
    );

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
  });

  /**
   * A rename and a label toggle have no editor and no source of their own, so
   * without these the guard asks nothing about a write that has not landed
   * (T-321). Both are held open across the assertion: what is being asked is
   * whether the page knows about the write while it is still in flight.
   */
  it("counts a title rename that has not landed", async () => {
    const write = held<Issue>();
    vi.spyOn(api, "updateIssue").mockReturnValue(write.promise);
    renderTitleBlock();
    expect(hasUnsavedWork()).toBe(false);

    fireEvent.click(await screen.findByLabelText("edit title"));
    fireEvent.click(screen.getByLabelText("save title"));

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
    act(() => write.release(CARD));
    await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  });

  it("counts a label change that has not landed", async () => {
    const write = held<Issue>();
    vi.spyOn(api, "updateIssue").mockReturnValue(write.promise);
    renderSidebar();
    expect(hasUnsavedWork()).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Edit labels" }));
    fireEvent.click(await screen.findByRole("option", { name: /bug/ }));

    await waitFor(() => expect(hasUnsavedWork()).toBe(true));
    act(() => write.release(CARD));
    await waitFor(() => expect(hasUnsavedWork()).toBe(false));
  });
});

/**
 * The page's own sidebar fields need queries seeded; the assertions here are
 * about the guard, so the shortest seeding that mounts the form is the point.
 */
function mountNewIssue() {
  const client = testQueryClient();
  client.setQueryData(projectQuery("p").queryKey, {
    id: 1,
    slug: "p",
    name: "p",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "admin",
  });
  client.setQueryData(statusesQuery("p").queryKey, []);
  client.setQueryData(labelsQuery("p").queryKey, []);
  client.setQueryData(membersQuery("p").queryKey, []);
  client.setQueryData(meQuery.queryKey, me);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  // The page reads its params from `/authed/projects/$slug/issues/new`, so the
  // pathless layout has to be in the shim's route ids.
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => <Outlet />,
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
    component: NewIssuePage,
  });
  const testRouter = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([newIssueRoute])]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/projects/p/issues/new"],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

function mountQuestionsCard() {
  const client = testQueryClient();
  // Answer state resolves to "nothing answered yet", which is what puts the
  // form rather than the answered summary on screen.
  client.setQueryData(["questions", "p", 19], { items: [] });
  return render(
    <QueryClientProvider client={client}>
      <QuestionsCard
        slug="p"
        issueNumber={19}
        commentId={42}
        component={questionComponent}
      />
    </QueryClientProvider>,
  );
}

function mountStagedFiles() {
  let latest: StagedFiles | null = null;
  function Harness() {
    latest = useStagedFiles();
    return null;
  }
  render(
    <QueryClientProvider client={testQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return {
    get staged() {
      if (latest === null) throw new Error("harness did not mount");
      return latest.staged;
    },
    stage: (files: File[]) => latest?.stage(files),
    remove: (key: number) => latest?.remove(key),
  };
}

const questionComponent: QuestionsComponent = {
  type: "questions",
  questions: [
    {
      key: "schema",
      header: "Data model",
      question: "Where does the payload live?",
      multiple: false,
      options: [{ label: "New entity" }, { label: "Inline" }],
    },
  ],
};

const optionButton = (label: string) =>
  screen.getByText(label).closest("button") as HTMLButtonElement;

afterEach(() => {
  // Testing-library's own cleanup has run by now (globals-registered first),
  // so no guard is mounted to refuse the URL `replace`.
  restoreAppRouterPage();
});

describe("leaving a page with unsaved work", () => {
  it("follows a link straight through when nothing is unsaved", async () => {
    renderGuardTree();
    fireEvent.click(await link());

    expect(await screen.findByText("the card")).toBeTruthy();
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
  });

  it("stops at the confirmation when an editor holds a draft", async () => {
    const view = renderGuardTree({ editor: true });
    await typeIntoEditor(view, "half a thought");

    fireEvent.click(await link());

    expect(await screen.findByText("Leave with unsaved changes?")).toBeTruthy();
    // Still on the list, draft intact: the navigation was refused, not merely
    // delayed.
    expect(screen.queryByText("the card")).toBeNull();
    expect(view.container.querySelector(".cm-content")?.textContent).toBe(
      "half a thought",
    );
  });

  /**
   * The two answers, driven by keyboard rather than by click. Radix's dialog
   * moves focus into the content on open and takes it back out on close — the
   * second move needs a real focus to return to and is what silences every
   * later render of the tree in this environment.
   *
   * `useBlocker` resolves the promise its `proceed` / `reset` answer in the
   * same tick they are called, so each assertion has to be read in that tick.
   * After an `await` the resolver is already back to `idle` and "the dialog is
   * still up" is indistinguishable from "the dialog was never removed".
   */
  it("goes back to the draft when the confirmation is dismissed", async () => {
    const view = renderGuardTree({ editor: true });
    await typeIntoEditor(view, "half a thought");
    fireEvent.click(await link());
    await screen.findByText("Leave with unsaved changes?");

    fireEvent.keyDown(await screen.findByText("Keep editing"), {
      key: "Escape",
      code: "Escape",
    });
    // The resolver's answer is a React state update, and this assertion has to
    // be read in the same tick it happens: after an `await`, the resolver is
    // back to `idle` and the assertion passes either way.
    await act(async () => {});

    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
    expect(screen.queryByText("the card")).toBeNull();
    expect(view.container.querySelector(".cm-content")?.textContent).toBe(
      "half a thought",
    );
  });

  it("arrives on 'Discard and leave'", async () => {
    window.history.back = () => {
      throw new Error("reset must not roll the history back");
    };
    const view = renderGuardTree({ editor: true });
    await typeIntoEditor(view, "half a thought");
    fireEvent.click(await link());
    await screen.findByText("Leave with unsaved changes?");

    fireEvent.click(await screen.findByText("Discard and leave"));

    expect(await screen.findByText("the card")).toBeTruthy();
  });

  it("lets a modified click through, which is the browser's to open", async () => {
    // The destination has to be a real anchor with an `href`: that is what
    // makes middle-click, Ctrl-click and the status-bar preview work at all,
    // and a modified click never becomes a history push to block.
    const view = renderGuardTree({ editor: true });
    const anchor = (await link()).closest("a[href]");
    expect(anchor).not.toBeNull();
    await typeIntoEditor(view, "half a thought");

    fireEvent.click(anchor as Element, { ctrlKey: true });

    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
    expect(screen.queryByText("the card")).toBeNull();
    expect(view.container.querySelector(".cm-content")?.textContent).toBe(
      "half a thought",
    );
  });

  /**
   * The browser's own prompt: the history `preventDefault`s the event while a
   * registered source is dirty, and leaves it alone while none is. Only a
   * browser-history implementation has that listener at all
   * (`@tanstack/history`, `onBeforeUnload` — `createMemoryHistory` reads no
   * `enableBeforeUnload`), so this one runs on the app's own router rather
   * than on the shim.
   *
   * A registered source stands in for the draft boxes: it is the same
   * registry they join, and what the listener consults is the registry, not a
   * condition it was handed at mount.
   *
   * The dirty half is asserted first, and only after the shell has been seen
   * on screen. `onBeforeUnload` leaves the event alone when the history holds
   * no blocker at all, so "not prevented" is equally what a guard that never
   * mounted looks like; the clean half only means something once the listener
   * has been watched to fire.
   */
  it("arms the browser's prompt while dirty, and not while clean", async () => {
    const mounted = renderOnTheAppRouterClean();
    // The guard rides inside the shell, so the header standing there is the
    // block being registered.
    await waitFor(() =>
      expect(mounted.container.querySelector("header")).not.toBeNull(),
    );

    const dirty = registerDirtySource(() => true);
    const armed = new Event("beforeunload", { cancelable: true });
    await act(async () => {
      window.dispatchEvent(armed);
    });
    expect(armed.defaultPrevented).toBe(true);

    dirty();
    const clean = new Event("beforeunload", { cancelable: true });
    await act(async () => {
      window.dispatchEvent(clean);
    });
    expect(clean.defaultPrevented).toBe(false);

    mounted.unmount();
  });
});

describe("the sidebar's assignees reach their own pages (T-391)", () => {
  const person = (id: number, login: string, name: string) => ({
    id,
    login,
    display_name: name,
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  });

  it("links every assignee listed under the heading", async () => {
    const client = testQueryClient();
    client.setQueryData(projectQuery("p").queryKey, {
      id: 1,
      slug: "p",
      name: "p",
      description: "",
      created_at: "2026-01-01T00:00:00Z",
      viewer_role: "writer",
    });
    const assignees = [
      person(2, "alice", "Alice Liu"),
      person(3, "bob", "Bob Ray"),
    ];
    const view = renderWithProviders(
      <Sidebar
        slug="p"
        issue={{ ...CARD, assignees }}
        statuses={[CARD.status]}
        allLabels={[]}
        members={assignees.map((user) => ({
          user,
          role: "writer" as const,
          created_at: "2026-01-01T00:00:00Z",
          owner_role: null,
        }))}
        canDelete={false}
        trashed={false}
      />,
      client,
    );

    // The Assignees section only — the rest of the sidebar carries chips of
    // its own. Taken from the enclosing section rather than by walking
    // siblings off the heading: T-403 wraps that heading in a title row and
    // makes the chip list conditional, and a sibling walk would then land on
    // the wrong node (or on none). The picker inside this section draws the
    // same people as bare `UserAvatar`s, which are not anchors — and were it
    // ever to link them, this list would grow rather than quietly agree.
    const section = (await view.findByText("Assignees")).closest(
      "section",
    ) as HTMLElement;
    expect(
      [...section.querySelectorAll('a[href^="/users/"]')].map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["/users/alice", "/users/bob"]);
  });
});
