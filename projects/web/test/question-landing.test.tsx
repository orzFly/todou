import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRouter,
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
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Issue,
  IssueQuestions,
  IssueQuestionsItem,
  Me,
  Project,
  QuestionsComponent,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { type ReactElement, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { questionsQuery } from "../src/api/questions.ts";
import { UnsavedChangesGuard } from "../src/components/shared/unsaved-guard.tsx";
import { registerDirtySource } from "../src/lib/unsaved-guard.ts";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";

// These imports deliberately reach the production keyed Timeline through the
// actual detail page, so `vitest related` follows the same graph as the app.
const ENTRY = "unanswered-questions";
const LOCATE_FAILURE = "Couldn't locate questions.";
const UNAVAILABLE = "This question is no longer available.";
const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const timestamp = (second: number) =>
  new Date(Date.UTC(2026, 8, 10, 10, 0, second)).toISOString();
const me: Me = {
  ...user,
  email: null,
  is_instance_admin: false,
  created_at: timestamp(0),
};
const status = {
  id: 1,
  name: "Todo",
  category: "open" as const,
  color: "#6b7280",
  position: 0,
  is_default: true,
};

function question(id: number, createdAt = timestamp(id)): IssueQuestionsItem {
  return {
    comment_id: id,
    author: user,
    created_at: createdAt,
    questions: [
      {
        key: "q1",
        multiple: false,
        question: `Decision ${id}?`,
        options: [{ label: "Proceed" }, { label: "Wait" }],
      },
    ],
    answer: null,
  };
}

function answered(
  item: IssueQuestionsItem,
  at: number,
  declined = false,
): IssueQuestionsItem {
  return {
    ...item,
    answer: {
      event_id: 10_000 + item.comment_id,
      actor: user,
      created_at: timestamp(at),
      answers: [
        {
          key: "q1",
          selected: declined ? [] : [{ index: 0, label: "Proceed" }],
          other: null,
          declined,
        },
      ],
    },
  };
}

const questions = (items: IssueQuestionsItem[]): IssueQuestions => ({
  items,
  open: items.reduce(
    (count, item) => count + (item.answer === null ? item.questions.length : 0),
    0,
  ),
});

const comment = (id: number, body = `comment body ${id}`): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body,
  component: null,
  created_at: timestamp(id),
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

function questionComment(item: IssueQuestionsItem, hidden = false) {
  return {
    ...comment(item.comment_id),
    created_at: item.created_at,
    component: {
      type: "questions",
      questions: item.questions,
    } satisfies QuestionsComponent,
    hidden_at: hidden ? (item.answer?.created_at ?? null) : null,
  } satisfies TimelineComment;
}

function answerEvent(item: IssueQuestionsItem): TimelineEvent {
  if (item.answer === null) throw new Error("An answer event needs an answer");
  return {
    type: "event",
    id: item.answer.event_id,
    actor: item.answer.actor,
    created_at: item.answer.created_at,
    event_type: "question_answered",
    payload: { comment_id: item.comment_id, answers: item.answer.answers },
    agent_context: null,
  };
}

const ordered = (items: TimelineItem[]) =>
  [...items].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );

function questionItems(items: IssueQuestionsItem[], hiddenIds: number[] = []) {
  return ordered(
    items.flatMap((item): TimelineItem[] => [
      questionComment(item, hiddenIds.includes(item.comment_id)),
      ...(item.answer === null ? [] : [answerEvent(item)]),
    ]),
  );
}

/** Fifty-item windows with real overlap/deduplication and an opaque cursor
 * mapping. A target around 125 needs two after requests, not just one. */
function pagedItems(items: IssueQuestionsItem[], count = 200) {
  const byId = new Map(items.map((item) => [item.comment_id, item]));
  return ordered([
    ...Array.from({ length: count }, (_, index) => {
      const id = index + 1;
      const item = byId.get(id);
      return item === undefined ? comment(id) : questionComment(item);
    }),
    ...items.filter((item) => item.answer !== null).map(answerEvent),
  ]);
}

function timelinePage(items: TimelineItem[], url: URL): TimelinePage {
  const after = url.searchParams.get("after");
  const start = url.searchParams.has("last")
    ? Math.max(0, items.length - 50)
    : after === null
      ? 0
      : Number(/^cursor-(\d+)$/.exec(after)?.[1]);
  if (!Number.isInteger(start) || start < 0 || start > items.length) {
    throw new Error(`Unexpected timeline cursor: ${url.search}`);
  }
  const slice = items.slice(start, start + 50);
  return {
    items: slice,
    prev_cursor: start === 0 ? null : `before-${start}`,
    next_cursor: slice.length === 0 ? null : `cursor-${start + slice.length}`,
    total_count: items.length,
  };
}

const json = (body: unknown, statusCode = 200) =>
  Response.json(body, { status: statusCode });
const failure = (message: string) =>
  json({ error: { code: "internal", message } }, 500);

type Reply = Response | Promise<Response>;
type Card = {
  questions: IssueQuestions;
  items: TimelineItem[];
  questionReply?: () => Reply;
  timelineReply?: (url: URL) => Reply;
  issueReply?: () => Reply;
};
function card(
  items: IssueQuestionsItem[] = [],
  timeline = questionItems(items),
): Card {
  return { questions: questions(items), items: timeline };
}

function issue(number: number, model: Card): Issue {
  return {
    id: number,
    number,
    title: `Card ${number}`,
    body: "",
    status,
    author: user,
    assignees: [],
    labels: [],
    created_at: timestamp(0),
    updated_at: timestamp(300),
    body_edited_at: null,
    open_questions: model.questions.open,
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
}

type FetchCall = { url: URL; method: string; body: string | undefined };
const unexpected: string[] = [];
const disposers: Array<() => void> = [];
const initialWindowUrl = window.location.href;

/** Only the HTTP boundary is replaced. Unknown URLs fail, including incidental
 * reads by the real page, comment rows, question cards, and sidebar. */
function serve(
  cards: Record<string, Card>,
  extra?: (call: FetchCall) => Reply | undefined,
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: new URL(
          input instanceof Request ? input.url : String(input),
          "http://todou.example",
        ),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : String(init.body),
      };
      calls.push(call);
      const override = extra?.(call);
      if (override !== undefined) return override;
      const path = call.url.pathname;
      if (call.method === "GET") {
        if (path === "/api/me") return json(me);
        if (path === "/api/me/prefs") return json({});
        if (path === "/api/me/mutes") return json({ issues: [], projects: [] });
        if (path === "/api/me/reference-directory") {
          return json({ entries: [], contested: [], slug_entries: [] });
        }
        if (path === "/api/projects") {
          return json(
            ["p", "q"].map(
              (slug, index) =>
                ({
                  id: index + 1,
                  slug,
                  name: slug,
                  description: "",
                  created_at: timestamp(0),
                }) satisfies Project,
            ),
          );
        }
        const project = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
        if (project !== null) {
          const slug = project[1];
          const rest = project[2] ?? "";
          if (rest === "") {
            return json({
              id: slug === "p" ? 1 : 2,
              slug,
              name: slug,
              description: "",
              created_at: timestamp(0),
              viewer_role: "writer",
            } satisfies Project);
          }
          if (rest === "statuses") return json([status]);
          if (rest === "labels") return json([]);
          if (rest === "members") {
            return json([{ user, role: "writer", created_at: timestamp(0) }]);
          }
          if (rest === "references/config") {
            return json({
              format: { prefix: "T", history: [] },
              autolinks: [],
            });
          }
          if (
            rest === "attachments" &&
            cards[`${slug}/${call.url.searchParams.get("issue_number")}`] !==
              undefined
          ) {
            return json([]);
          }
          const match = /^issues\/(\d+)(?:\/(.*))?$/.exec(rest);
          if (match !== null) {
            const number = Number(match[1]);
            const model = cards[`${slug}/${number}`];
            const resource = match[2] ?? "";
            if (model !== undefined) {
              if (resource === "")
                return model.issueReply?.() ?? json(issue(number, model));
              if (resource === "questions")
                return model.questionReply?.() ?? json(model.questions);
              if (resource === "timeline") {
                expect(call.url.searchParams.get("include_hidden")).toBe(
                  "true",
                );
                expect(call.url.searchParams.get("limit")).toBe("50");
                return (
                  model.timelineReply?.(call.url) ??
                  json(timelinePage(model.items, call.url))
                );
              }
              if (resource === "metadata") return json({ entries: [] });
              if (resource === "metadata/namespaces")
                return json({ namespaces: [] });
              if (resource === "spec") {
                return json(
                  { error: { code: "not_found", message: "No spec" } },
                  404,
                );
              }
              if (resource === "spec/comments") return json({ items: [] });
            }
          }
        }
      }
      if (
        call.method === "PUT" &&
        /^\/api\/projects\/[^/]+\/issues\/\d+\/read$/.test(path)
      ) {
        return new Response(null, { status: 204 });
      }
      const message = `Unexpected fetch: ${call.method} ${path}${call.url.search}`;
      unexpected.push(message);
      throw new Error(message);
    },
  );
  return {
    calls,
    questions: (key = "p/7") =>
      calls.filter(
        (call) =>
          call.url.pathname ===
          `/api/projects/${key.replace("/", "/issues/")}/questions`,
      ),
    timeline: (key = "p/7") =>
      calls.filter(
        (call) =>
          call.url.pathname ===
          `/api/projects/${key.replace("/", "/issues/")}/timeline`,
      ),
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function release(pending: Deferred<Response>, response: Response) {
  await act(async () => {
    pending.resolve(response);
    await pending.promise;
  });
}

function queryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: false },
      mutations: { retry: false },
    },
  });
  disposers.push(() => client.clear());
  return client;
}

function SourceList() {
  return (
    <main aria-label="Source list">
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug: "p", number: "7" }}
        hash={ENTRY}
        hashScrollIntoView={false}
      >
        Questions for card 7
      </Link>
    </main>
  );
}

type View = RenderResult & {
  router: AnyRouter;
  client: QueryClient;
  ui: ReactElement;
};

function renderAt(
  url = `/projects/p/issues/7#${ENTRY}`,
  client = queryClient(),
): View {
  const root = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => root,
    id: "authed",
    component: () => (
      <>
        <UnsavedChangesGuard />
        <Outlet />
      </>
    ),
    errorComponent: ({ error }) => (
      <div>Unhandled route error: {error.message}</div>
    ),
  });
  const source = createRoute({
    getParentRoute: () => authed,
    path: "/source",
    component: SourceList,
  });
  const project = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
    component: ProjectLayout,
    errorComponent: ProjectRouteError,
  });
  const detail = createRoute({
    getParentRoute: () => project,
    path: "issues/$number",
    component: () => (
      <Suspense fallback={<div>Loading card</div>}>
        <IssueDetailPage />
      </Suspense>
    ),
    errorComponent: IssueRouteError,
    staticData: { resolvesProjectMiss: true },
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  // FollowMove reads window.location.hash, while the rest of the page reads
  // router state. Keep them identical before rendering and on every history op.
  window.history.replaceState(null, "", url);
  disposers.push(
    history.subscribe(({ location }) => {
      window.history.replaceState(null, "", location.href);
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([source, project.addChildren([detail])]),
    ]),
    history,
  });
  const ui = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...render(ui), router, client, ui };
}

async function navigate(view: View, hash: string, number = 7, slug = "p") {
  await act(async () => {
    await view.router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug, number: String(number) },
      hash,
      hashScrollIntoView: false,
    });
  });
}

type Scrolling = {
  events: string[];
  reveals: (id: string) => number;
  bottoms: () => number;
  userAt: (y: number) => void;
  position: () => number;
};

/** happy-dom cannot lay out the page. Observe production reveal/flash and
 * scroll order, modelling the viewport change without firing a native scroll
 * event; releasing landing ownership must reconcile follow-bottom itself. */
function scrolling(): Scrolling {
  const state = { y: 0, height: 10_000, events: [] as string[] };
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(
    () => state.height,
  );
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    const top =
      typeof first === "object" && first !== null
        ? ((first as ScrollToOptions).top ?? state.y)
        : Number(args[1] ?? 0);
    state.events.push(top >= state.height ? "bottom" : `scroll:${top}`);
    state.y = Math.max(0, Math.min(top, state.height - 800));
  });
  vi.spyOn(window, "scrollBy").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    const delta =
      typeof first === "object" && first !== null
        ? ((first as ScrollToOptions).top ?? 0)
        : Number(args[1] ?? 0);
    state.events.push(`prepend:${delta}`);
    state.y = Math.max(0, Math.min(state.y + delta, state.height - 800));
  });
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    state.events.push(`reveal:${this.id}`);
    state.y = 1_500;
  });
  return {
    events: state.events,
    reveals: (id: string) =>
      state.events.filter((event) => event === `reveal:${id}`).length,
    bottoms: () => state.events.filter((event) => event === "bottom").length,
    userAt: (y: number) => {
      state.y = y;
      fireEvent.scroll(window);
    },
    position: () => state.y,
  };
}

async function landed(view: View, scroll: Scrolling, id: number, count = 1) {
  await waitFor(
    () => {
      expect(view.router.state.location.hash).toBe(`comment-${id}`);
      const target = view.container.querySelector(`#comment-${id}`);
      expect(target?.classList.contains("anchor-flash")).toBe(true);
      expect(scroll.reveals(`comment-${id}`)).toBe(count);
    },
    { timeout: 3_000 },
  );
  expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
  expect(view.queryByText(UNAVAILABLE)).toBeNull();
}

async function refetchTail(view: View, slug = "p", number = 7) {
  await act(async () => {
    await view.client.refetchQueries({
      queryKey: ["timeline", slug, number, "tail"],
      exact: true,
    });
  });
}

function retryFor(view: View, message: string | RegExp) {
  const failureText = view.getByText(message);
  const failureBox = failureText.closest('[role="status"]');
  if (failureBox === null) throw new Error("Missing load failure container");
  return within(failureBox as HTMLElement).getByRole("button", {
    name: "Retry",
  });
}

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", initialWindowUrl);
  document.documentElement.style.removeProperty("scroll-padding-top");
  document.documentElement.style.removeProperty("scroll-padding-bottom");
  expect(unexpected.splice(0)).toEqual([]);
});

describe("question landing through the real issue route", () => {
  it("C5 selects the earliest unanswered by question time and id across two after pages", async () => {
    const items = [
      answered(question(10), 11),
      question(125),
      question(126, timestamp(125)),
      question(180),
    ];
    const model = card(items, pagedItems(items));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await landed(view, scroll, 125);

    expect(view.getByText("Decision 125?")).toBeTruthy();
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-100"]);
    expect(
      server.timeline().filter(({ url }) => url.searchParams.has("last")),
    ).toHaveLength(1);
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.reveals("comment-126")).toBe(0);
    expect(scroll.reveals("comment-180")).toBe(0);
    // Head prepend compensation is allowed before the final anchor reveal.
    expect(scroll.events.at(-1)).toBe("reveal:comment-125");
  });

  it.each(["/projects/p/issues/007", "/projects/p/issues/7/"])(
    "C9 resolves the matched card identity at %s",
    async (path) => {
      const model = card([question(10)]);
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt(`${path}#${ENTRY}`);
      await landed(view, scroll, 10);
      expect(server.questions()).toHaveLength(1);
      expect(scroll.bottoms()).toBe(0);
    },
  );

  it("C6 chooses the latest question rather than latest answer and reveals hidden declined comments", async () => {
    const items = [
      answered(question(10), 500),
      answered(question(20), 30),
      answered(question(21, timestamp(20)), 31, true),
    ];
    const model = card(items, questionItems(items, [21]));
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await landed(view, scroll, 21);

    const target = view.container.querySelector<HTMLElement>("#comment-21");
    expect(target).not.toBeNull();
    expect(
      within(target as HTMLElement).getByText("Decision 21?"),
    ).toBeTruthy();
    expect(within(target as HTMLElement).getByText(/declined/i)).toBeTruthy();
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.reveals("comment-20")).toBe(0);
  });

  it.each(["timeline first", "questions first"])(
    "C6 empty questions scrolls latest exactly once with %s",
    async (order) => {
      const pendingQuestions = deferred<Response>();
      const pendingTimeline = deferred<Response>();
      const model = card([], [comment(1), comment(2)]);
      model.questionReply = () => pendingQuestions.promise;
      model.timelineReply = () => pendingTimeline.promise;
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt();
      await waitFor(() => expect(server.questions()).toHaveLength(1));
      await waitFor(() => expect(server.timeline()).toHaveLength(1));
      const tail = () =>
        json(
          timelinePage(model.items, new URL("http://todou.example/?last=1")),
        );

      if (order === "timeline first") {
        await release(pendingTimeline, tail());
        await view.findByText("comment body 2");
        expect(scroll.bottoms()).toBe(0);
        expect(view.router.state.location.hash).toBe(ENTRY);
        await release(pendingQuestions, json(model.questions));
      } else {
        await release(pendingQuestions, json(model.questions));
        await waitFor(() => expect(view.router.state.location.hash).toBe(""));
        expect(scroll.bottoms()).toBe(0);
        await release(pendingTimeline, tail());
      }
      await waitFor(() => expect(scroll.bottoms()).toBe(1));
      expect(view.router.state.location.hash).toBe("");
      view.rerender(view.ui);
      await act(async () => {});
      expect(scroll.bottoms()).toBe(1);
      expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
    },
  );

  it.each(["old unanswered", "empty"])(
    "C7 waits for a fresh read despite a 5000ms %s cache",
    async (cached) => {
      const a = question(10);
      const b = question(20);
      const current = [answered(a, 30), b];
      const model = card(current);
      const pending = deferred<Response>();
      model.questionReply = () => pending.promise;
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const client = queryClient();
      client.setQueryData(
        questionsQuery("p", 7).queryKey,
        questions(cached === "empty" ? [] : [a]),
      );
      const view = renderAt(undefined, client);

      await waitFor(() => expect(server.questions()).toHaveLength(1));
      await view.findByText("Decision 20?");
      expect(view.router.state.location.hash).toBe(ENTRY);
      expect(scroll.reveals("comment-10")).toBe(0);
      expect(scroll.bottoms()).toBe(0);

      await release(pending, json(model.questions));
      await landed(view, scroll, 20);
      expect(server.questions()).toHaveLength(1);
      expect(scroll.reveals("comment-10")).toBe(0);
    },
  );

  it("C7 failed fresh reads keep the semantic entry and Retry fetches again without adding history", async () => {
    const a = question(10);
    const b = question(20);
    const model = card([a, b]);
    model.questionReply = () => failure("questions unavailable");
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const client = queryClient();
    client.setQueryData(questionsQuery("p", 7).queryKey, questions([a]));
    const view = renderAt(undefined, client);

    await view.findByText(LOCATE_FAILURE);
    expect(view.router.state.location.hash).toBe(ENTRY);
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.reveals("comment-10")).toBe(0);
    const before = server.questions().length;
    const length = view.router.history.length;
    model.questions = questions([answered(a, 30), b]);
    model.questionReply = undefined;
    fireEvent.click(retryFor(view, LOCATE_FAILURE));

    await landed(view, scroll, 20);
    expect(server.questions()).toHaveLength(before + 1);
    expect(view.router.history.length).toBe(length);
  });

  it("C8 reentering the same card reveals the same comment again without chasing answers or rerenders", async () => {
    const a = question(10);
    const b = question(20);
    const model = card([a, b]);
    const server = serve({ "p/7": model }, ({ url, method, body }) => {
      if (
        method !== "POST" ||
        url.pathname !== "/api/projects/p/issues/7/comments/10/answers"
      )
        return undefined;
      expect(JSON.parse(body ?? "null")).toEqual({
        answers: [{ key: "q1", selected: [0], declined: false }],
      });
      const done = answered(a, 30);
      model.questions = questions([done, b]);
      model.items = questionItems([done, b]);
      return json(answerEvent(done));
    });
    const scroll = scrolling();
    const view = renderAt();
    await landed(view, scroll, 10);
    const firstNode = view.container.querySelector("#comment-10");
    const before = server.questions().length;
    await navigate(view, ENTRY);
    await landed(view, scroll, 10, 2);
    expect(server.questions()).toHaveLength(before + 1);
    expect(view.container.querySelector("#comment-10")).toBe(firstNode);

    view.rerender(view.ui);
    const target = within(firstNode as HTMLElement);
    fireEvent.click(target.getByRole("button", { name: "Proceed" }));
    fireEvent.click(target.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(target.getByText("answered by")).toBeTruthy());
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await refetchTail(view);

    expect(view.router.state.location.hash).toBe("comment-10");
    expect(scroll.reveals("comment-10")).toBe(2);
    expect(scroll.reveals("comment-20")).toBe(0);
    expect(scroll.bottoms()).toBe(0);
  });

  it("C8 internal question annotation bypasses the real unsaved guard while ordinary exits remain blocked", async () => {
    const model = card([question(10)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 10?");
    expect(view.router.state.location.hash).toBe(ENTRY);
    disposers.push(registerDirtySource(() => true));

    await release(pending, json(model.questions));
    await landed(view, scroll, 10);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.router.history.length).toBe(1);

    act(() => {
      void view.router.navigate({ href: "/source" });
    });
    const dialog = await view.findByRole("dialog", {
      name: "Leave with unsaved changes?",
    });
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
    expect(view.router.state.location.hash).toBe("comment-10");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(scroll.reveals("comment-10")).toBe(1);
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
  });

  it("C8 leaving the semantic entry cancels its late response before a new same-card intent", async () => {
    const model = card([question(10), question(20)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 20?");
    await navigate(view, "comment-20");
    await landed(view, scroll, 20);
    const afterNavigation = [...scroll.events];

    await release(pending, json(model.questions));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(scroll.events).toEqual(afterNavigation);

    model.questionReply = undefined;
    await navigate(view, ENTRY);
    await landed(view, scroll, 10);
    expect(server.questions()).toHaveLength(2);
    expect(scroll.reveals("comment-20")).toBe(1);
  });

  it("C8 a new same-card intent alone may replace history when it shares the older in-flight read", async () => {
    const model = card([question(10), question(20)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 20?");
    await navigate(view, "comment-20");
    await landed(view, scroll, 20);
    await navigate(view, ENTRY);
    expect(view.router.state.location.hash).toBe(ENTRY);

    const replacements: string[] = [];
    disposers.push(
      view.router.history.subscribe(
        ({
          action,
          location,
        }: {
          action: { type: string };
          location: { href: string };
        }) => {
          if (action.type === "REPLACE") replacements.push(location.href);
        },
      ),
    );
    // The API does not consume an AbortSignal. Reentry can share the existing
    // query promise, but its older continuation has lost the right to navigate.
    await release(pending, json(model.questions));
    await landed(view, scroll, 10);
    expect(server.questions()).toHaveLength(1);
    expect(replacements).toEqual(["/projects/p/issues/7#comment-10"]);
    expect(scroll.reveals("comment-20")).toBe(1);
  });

  it("C9 a delayed card A read cannot navigate or scroll card B after the real keyed unmount", async () => {
    const a = card(
      [question(10)],
      [comment(1, "A shared row"), ...questionItems([question(10)])],
    );
    const b = card(
      [question(20)],
      [comment(1, "B shared row"), ...questionItems([question(20)])],
    );
    const pending = deferred<Response>();
    a.questionReply = () => pending.promise;
    const server = serve({ "p/7": a, "q/8": b });
    const scroll = scrolling();
    // Warm B by visiting its actual page, so cold query skeletons cannot
    // substitute for the production key's unmount when returning to it.
    const view = renderAt("/projects/q/issues/8");
    await view.findByText("B shared row");
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await navigate(view, ENTRY);
    await view.findByText("A shared row");
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    const outgoing = view.container.querySelector("#comment-1");
    await navigate(view, ENTRY, 8, "q");
    await landed(view, scroll, 20);
    expect(outgoing?.isConnected).toBe(false);
    expect(view.container.querySelector("#comment-1")).not.toBe(outgoing);
    const settled = [...scroll.events];

    await release(pending, json(a.questions));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.pathname).toBe("/projects/q/issues/8");
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(view.queryByText("A shared row")).toBeNull();
    expect(view.getByText("B shared row")).toBeTruthy();
    expect(scroll.events).toEqual(settled);
    expect(server.questions("q/8").length).toBeGreaterThan(0);
  });

  // Each recovery renders 150–200 real comments across multiple requests,
  // then resolves a second intent. Keep per-step deadlines; allow their sum.
  it("C10 reports a deleted target only after head readiness and bounded exhaustion, then Retry reselects", async () => {
    const gone = question(125);
    const next = question(175);
    const model = card(
      [gone, next],
      pagedItems([gone, next]).filter(
        (item) => item.type !== "comment" || item.id !== 125,
      ),
    );
    const pendingHead = deferred<Response>();
    model.timelineReply = (url) =>
      !url.searchParams.has("last") && !url.searchParams.has("after")
        ? pendingHead.promise
        : json(timelinePage(model.items, url));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() =>
      expect(view.router.state.location.hash).toBe("comment-125"),
    );
    await waitFor(() => expect(server.timeline()).toHaveLength(2));
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(scroll.reveals("comment-125")).toBe(0);

    await release(
      pendingHead,
      json(timelinePage(model.items, new URL("http://todou.example/"))),
    );
    await view.findByText(UNAVAILABLE, {}, { timeout: 3_000 });
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-100"]);
    expect(view.queryByText(/Couldn't refresh the timeline/)).toBeNull();
    const before = server.questions().length;
    model.questions = questions([next]);
    fireEvent.click(retryFor(view, UNAVAILABLE));
    await landed(view, scroll, 175);
    expect(server.questions()).toHaveLength(before + 1);
  }, 15_000);

  it("C10 pagination failure stays a timeline error and its Retry resumes the selected question", async () => {
    const item = question(125);
    const model = card([item], pagedItems([item]));
    let failPage = true;
    model.timelineReply = (url) =>
      failPage && url.searchParams.get("after") === "cursor-50"
        ? failure("middle page unavailable")
        : json(timelinePage(model.items, url));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await view.findByText(
      /Couldn't refresh the timeline \(middle page unavailable\)/,
      {},
      { timeout: 3_000 },
    );
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
    expect(view.router.state.location.hash).toBe("comment-125");
    const questionReads = server.questions().length;
    failPage = false;
    fireEvent.click(retryFor(view, /Couldn't refresh the timeline/));
    await landed(view, scroll, 125);
    expect(view.queryByText(/Couldn't refresh the timeline/)).toBeNull();
    expect(server.questions()).toHaveLength(questionReads);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-50", "cursor-100"]);
  }, 15_000);

  it("C10 no-progress pagination is bounded and reports a retryable locating failure", async () => {
    const item = question(125);
    const model = card([item], pagedItems([item]));
    // A successful but anomalous page repeats the loaded head. It cannot
    // establish deletion, and repeating this cursor forever is not recovery.
    model.timelineReply = (url) =>
      json(
        timelinePage(
          model.items,
          url.searchParams.has("after")
            ? new URL("http://todou.example/")
            : url,
        ),
      );
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await view.findByText(LOCATE_FAILURE, {}, { timeout: 3_000 });
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50"]);
    const reads = server.questions().length;
    model.timelineReply = undefined;
    fireEvent.click(retryFor(view, LOCATE_FAILURE));
    await landed(view, scroll, 125);
    expect(server.questions()).toHaveLength(reads + 1);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-50", "cursor-100"]);
  }, 15_000);

  it("C11 a warm tail racing the question handoff cannot overwrite reveal and later bottom following resumes", async () => {
    const item = question(10);
    const model = card([item], [...questionItems([item]), comment(20)]);
    const pendingQuestions = deferred<Response>();
    const pendingTail = deferred<Response>();
    model.questionReply = () => pendingQuestions.promise;
    model.timelineReply = () => pendingTail.promise;
    const server = serve({ "p/7": model });
    const client = queryClient();
    const tailKey = ["timeline", "p", 7, "tail"];
    client.setQueryData(tailKey, {
      pages: [
        timelinePage(model.items, new URL("http://todou.example/?last=1")),
      ],
      pageParams: [{ dir: "init" }],
    });
    client.setQueryData(questionsQuery("p", 7).queryKey, model.questions);
    const scroll = scrolling();
    const view = renderAt(undefined, client);
    await view.findByText("comment body 20");
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    expect(scroll.bottoms()).toBe(0);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = client.refetchQueries({ queryKey: tailKey, exact: true });
    });
    await waitFor(() => expect(server.timeline()).toHaveLength(1));
    model.items = [...model.items, comment(21)];
    await act(async () => {
      pendingQuestions.resolve(json(model.questions));
      pendingTail.resolve(
        json(
          timelinePage(model.items, new URL("http://todou.example/?last=1")),
        ),
      );
      await refreshing;
    });
    await landed(view, scroll, 10);
    await view.findByText("comment body 21");
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.events.at(-1)).toBe("reveal:comment-10");

    // No native scroll event intervenes between reveal and this SSE-style
    // refetch. Ownership release must already have reconciled atBottom.
    model.timelineReply = undefined;
    model.items = [...model.items, comment(22)];
    await refetchTail(view);
    await view.findByText("comment body 22");
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.position()).toBe(1_500);
    expect(scroll.reveals("comment-10")).toBe(1);

    scroll.userAt(9_200);
    model.items = [...model.items, comment(23)];
    await refetchTail(view);
    await view.findByText("comment body 23");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    expect(view.router.state.location.hash).toBe("comment-10");
    expect(scroll.reveals("comment-10")).toBe(1);
  });

  it("C11 selected comment keeps scroll ownership while paging and a tail refetch completes", async () => {
    const item = question(125);
    const model = card([item], pagedItems([item]));
    const pendingMiddle = deferred<Response>();
    model.timelineReply = (url) =>
      url.searchParams.get("after") === "cursor-50"
        ? pendingMiddle.promise
        : json(timelinePage(model.items, url));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() =>
      expect(
        server
          .timeline()
          .some(({ url }) => url.searchParams.get("after") === "cursor-50"),
      ).toBe(true),
    );
    expect(view.router.state.location.hash).toBe("comment-125");
    model.items = [...model.items, comment(201)];
    await refetchTail(view);
    await view.findByText("comment body 201");
    expect(scroll.bottoms()).toBe(0);
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    await release(
      pendingMiddle,
      json(
        timelinePage(
          model.items,
          new URL("http://todou.example/?after=cursor-50"),
        ),
      ),
    );
    await landed(view, scroll, 125);
    expect(scroll.events.at(-1)).toBe("reveal:comment-125");
    expect(scroll.bottoms()).toBe(0);
  });

  it("C12 replaces the semantic history entry so Back returns to source and Forward keeps the concrete comment", async () => {
    const model = card([question(10), question(20)]);
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/source");
    fireEvent.click(
      await view.findByRole("link", { name: "Questions for card 7" }),
    );
    await landed(view, scroll, 10);
    expect(view.router.history.length).toBe(2);
    const reads = server.questions().length;

    act(() => view.router.history.back());
    await view.findByRole("main", { name: "Source list" });
    expect(view.router.state.location.pathname).toBe("/source");
    model.questions = questions([answered(question(10), 30), question(20)]);
    act(() => view.router.history.forward());
    await landed(view, scroll, 10, 2);
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
    expect(server.questions()).toHaveLength(reads);
    expect(scroll.reveals("comment-20")).toBe(0);
  });

  it("C12 a real MovedError preserves the semantic hash and resolves questions at the destination", async () => {
    const old = card();
    old.issueReply = () => json({ moved_to: { slug: "q", number: 8 } }, 301);
    const destination = card([question(42)]);
    const server = serve({ "p/7": old, "q/8": destination });
    const scroll = scrolling();
    const view = renderAt();
    await landed(view, scroll, 42);
    expect(view.router.state.location.pathname).toBe("/projects/q/issues/8");
    expect(window.location.pathname).toBe("/projects/q/issues/8");
    expect(window.location.hash).toBe("#comment-42");
    expect(server.questions()).toHaveLength(0);
    expect(server.questions("q/8")).toHaveLength(1);
    expect(view.router.history.length).toBe(1);
  });

  it.each([
    ["comment-10", "comment-42"],
    ["event-9", "event-9"],
    ["unanswered-questions-extra", ""],
    ["unknown-anchor", ""],
  ])(
    "C12 moved %s retains the existing alias or unknown-hash behavior",
    async (from, to) => {
      const old = card();
      old.issueReply = () => json({ moved_to: { slug: "q", number: 8 } }, 301);
      const event: TimelineEvent = {
        type: "event",
        id: 9,
        actor: user,
        event_type: "closed",
        payload: { to: { name: "Done" } },
        created_at: timestamp(50),
        agent_context: null,
      };
      const destination = card([], [comment(42), event]);
      const server = serve(
        { "p/7": old, "q/8": destination },
        ({ url, method }) => {
          if (
            method === "GET" &&
            url.pathname === "/api/projects/p/comments/10"
          ) {
            return json(
              { moved_to: { slug: "q", number: 8, comment_id: 42 } },
              301,
            );
          }
          return undefined;
        },
      );
      const scroll = scrolling();
      const view = renderAt(`/projects/p/issues/7#${from}`);
      await view.findByText("comment body 42");
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe(
          "/projects/q/issues/8",
        );
        expect(view.router.state.location.hash).toBe(to);
      });
      if (to !== "") {
        await waitFor(() => {
          expect(scroll.reveals(to)).toBeGreaterThan(0);
          expect(
            view.container
              .querySelector(`#${to}`)
              ?.classList.contains("anchor-flash"),
          ).toBe(true);
        });
      }
      expect(window.location.hash).toBe(to === "" ? "" : `#${to}`);
      const aliases = server.calls.filter(
        ({ url }) => url.pathname === "/api/projects/p/comments/10",
      );
      if (from === "comment-10") expect(aliases.length).toBeGreaterThan(0);
      else expect(aliases).toHaveLength(0);
      expect(server.questions("q/8")).toHaveLength(0);
    },
  );

  it("C13 ordinary details still scroll latest, follow new tail items, and stop following when the reader scrolls up", async () => {
    const model = card([], [comment(1), comment(2)]);
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("comment body 2");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    scroll.userAt(9_200);
    model.items = [...model.items, comment(3)];
    await refetchTail(view);
    await waitFor(() => expect(scroll.bottoms()).toBe(2));
    scroll.userAt(0);
    model.items = [...model.items, comment(4)];
    await refetchTail(view);
    await view.findByText("comment body 4");
    expect(scroll.bottoms()).toBe(2);
    expect(view.getByRole("button", { name: "新消息" })).toBeTruthy();
    expect(server.questions()).toHaveLength(0);
  });

  it.each([
    "unanswered-questions-extra",
    "Unanswered-questions",
    "unanswered-question",
  ])(
    "C13 the ordinary route rejects the lookalike semantic hash %s",
    async (hash) => {
      const model = card([], [comment(1)]);
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt(`/projects/p/issues/7#${hash}`);
      await view.findByText("comment body 1");
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(view.router.state.location.hash).toBe(hash);
      expect(server.questions()).toHaveLength(0);
      expect(scroll.bottoms()).toBe(1);
    },
  );

  it("C13 direct event anchors still expand pagination and their collapsed event group", async () => {
    const events: TimelineEvent[] = [1001, 1002].map((id) => ({
      type: "event",
      id,
      actor: user,
      event_type: "status_changed",
      payload: {
        from: { id: id === 1001 ? 1 : 2, name: id === 1001 ? "Todo" : "Doing" },
        to: { id: id === 1001 ? 2 : 1, name: id === 1001 ? "Doing" : "Todo" },
      },
      created_at: timestamp(125),
      agent_context: null,
    }));
    const model = card([], ordered([...pagedItems([]), ...events]));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#event-1002");
    await waitFor(
      () => {
        expect(
          view.container
            .querySelector("#event-1002")
            ?.classList.contains("anchor-flash"),
        ).toBe(true);
        expect(scroll.reveals("event-1002")).toBeGreaterThan(0);
      },
      { timeout: 3_000 },
    );
    expect(view.container.querySelector("#event-1001")).not.toBeNull();
    expect(view.router.state.location.hash).toBe("event-1002");
    // The existing group's passive open schedules one extra page before its
    // event DOM mounts. Keep the ordinary anchor's bounded behavior unchanged.
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-100", "cursor-150"]);
    expect(server.questions()).toHaveLength(0);
    expect(scroll.bottoms()).toBe(0);
  });

  it("C13 direct concrete comment links retain their target without selecting another question", async () => {
    const model = card([question(10), question(20)]);
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-20");
    await landed(view, scroll, 20);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.bottoms()).toBe(0);
  });
});
