import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type InfiniteData,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { SpecReviewVerdict, TimelinePage } from "@todou/shared";
import { StrictMode, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { meQuery } from "../src/api/queries.ts";
import { specQuery } from "../src/api/spec.ts";
import {
  type TimelinePageParam,
  timelineTailOptions,
} from "../src/api/timeline.ts";
import { AppShell } from "../src/components/shell.tsx";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import { groupTimeline } from "../src/components/timeline/group-events.ts";
import {
  clearReturnMemory,
  readCurrentReturnEntry,
} from "../src/lib/return-view-history.ts";
import { useSpecReviewDrafts } from "../src/lib/spec-drafts.ts";
import { parseSpecSearch } from "../src/lib/spec-search.ts";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { SpecViewPage } from "../src/pages/spec-view.tsx";
import { router as appRouter } from "../src/router.tsx";
import {
  renderOnTheAppRouter,
  restoreAppRouterPage,
  teardownAppRouter,
} from "./app-router.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";
import { reviewViewport } from "./review-viewport.ts";
import {
  type Deferred,
  DRAFT,
  held,
  ISSUE_TITLE,
  ISSUE_URL,
  json,
  ME,
  type ReviewApiFixture,
  rejectHeldRequests,
  reviewApiFixture,
  reviewPages,
  reviewResult,
  SPEC,
  SPEC_URL,
  SUMMARY,
  TAIL_KEY,
} from "./spec-review-navigation-fixture.ts";

// Only the source-code renderer is inert. Router, transport, QueryClient,
// submission dialog, session owner, ReturnViewProvider, guard, MarkdownView,
// IssueDetailPage and its keyed Timeline are the production implementations.
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: () => <div data-testid="diff" />,
  File: () => <div data-testid="file-view" />,
  CodeView: () => null,
}));

/**
 * Mutation expectations, written before the scenarios:
 * - summary_comment_id / max event / latest review as target: exact URL and
 *   #event-901 flash fail even though 902, 903 and 904 all really render.
 * - navigate after inactive invalidation alone: the PUSH-time GET/cache
 *   observations fail; fetching only after mounting the issue cannot pass.
 * - types=spec_review / fake single-event tail / reversed pages: ordinary
 *   comment, page metadata, DOM order and real refetch cursor checks fail.
 * - release pending at POST201: disabled controls / duplicate POST checks fail.
 * - fixed 3000ms minimum: quick-missing and retry-success scenarios fail.
 * - Promise.race without retiring its loser: late GET cache-write checks fail.
 * - seed before checking deadline after cancelQueries: expired cache check fails.
 * - completion errors routed to POST failure: toast.error and draft checks fail.
 * - pathname-only / token-only stale ownership: leave/reenter and same-owner
 *   leave tests fail at the actual route or fresh summary.
 * - replace spec history entry or drop return state: the PUSH/Back observations
 *   and full T-407 source round trips fail.
 * - fold adjacent spec_review / enhance event hrefs: standalone-unit and real
 *   MarkdownView link assertions fail.
 *
 * This file intentionally does not claim browser geometry or CSS animation
 * execution: happy-dom needs animationend dispatched, after verifying the
 * production 2s declaration. Those visual checks belong to browser coverage.
 */
const WAIT = { timeout: 15_000 };
const BRANCHES = ["controlled", "legacy"] as const;
type Branch = (typeof BRANCHES)[number];
const VERDICTS = ["approve", "request_changes", "comment"] as const;
const WIDTHS = [390, 1280] as const;
const SUCCESS = {
  approve: "Approved spec v1",
  request_changes: "Requested changes on spec v1",
  comment: "Commented on spec v1",
};
const LABEL = {
  approve: "Approve",
  request_changes: "Request changes",
  comment: "Comment",
};
const cleanups: (() => void)[] = [];
let server: ReviewApiFixture;
let success: MockInstance<typeof toast.success>;
let failure: MockInstance<typeof toast.error>;
let stagedDrafts: unknown;

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  localStorage.clear();
  // localStorage.clear alone leaves the production module's snapshot cached.
  // Seed through its public hook so both persistence and subscribers agree.
  const drafts = renderHook(() => useSpecReviewDrafts("demo", 7));
  act(() => {
    drafts.result.current.clear();
    drafts.result.current.add(DRAFT);
  });
  stagedDrafts = JSON.parse(
    localStorage.getItem("todou-spec-review:demo:7") ?? "[]",
  );
  drafts.unmount();
  server = reviewApiFixture();
  vi.stubGlobal("fetch", server.fetch);
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  success = vi.spyOn(toast, "success");
  failure = vi.spyOn(toast, "error");
});

afterEach(async () => {
  await act(async () => {
    cleanup();
    rejectHeldRequests();
    // A failed timer assertion must not strand the real session's shared
    // pending store and disable all subsequent cases for this same issue.
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5000);
  });
  restoreAppRouterPage();
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  toast.dismiss();
  vi.useRealTimers();
  clearReturnMemory();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(teardownAppRouter);

/** An actual standalone consumer: no onSubmit AND no optional onSubmitted. */
function LegacySpec() {
  const [open, setOpen] = useState(false);
  const drafts = useSpecReviewDrafts("demo", 7);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Finish review
      </button>
      <ReviewSubmitDialog
        slug="demo"
        issueNumber={7}
        currentVersion={1}
        drafts={drafts.drafts}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function mountBranch(branch: Branch, width = 1280) {
  reviewViewport(width);
  const client = testQueryClient();
  cleanups.push(() => client.clear());
  client.setQueryData(meQuery.queryKey, ME);
  client.setQueryData(specQuery("demo", 7).queryKey, SPEC);
  const root = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <Toaster />
      </>
    ),
  });
  const authed = createRoute({
    getParentRoute: () => root,
    id: "authed",
    // This nesting is intentional: the real shell owns the stable session
    // above its real ReturnViewProvider and unsaved-changes blocker.
    component: () => (
      <AppShell me={ME}>
        <Outlet />
      </AppShell>
    ),
  });
  const project = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const spec = createRoute({
    getParentRoute: () => project,
    path: "issues/$number/spec",
    validateSearch: parseSpecSearch,
    component: branch === "controlled" ? SpecViewPage : LegacySpec,
  });
  const issue = createRoute({
    getParentRoute: () => project,
    path: "issues/$number",
    component: IssueDetailPage,
  });
  const history = createMemoryHistory({ initialEntries: [SPEC_URL] });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([project.addChildren([spec, issue])]),
    ]),
    history,
    defaultPendingMs: 0,
  });
  cleanups.push(() => history.destroy());
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { ...view, client, router };
}

async function openReview(summary = SUMMARY) {
  fireEvent.click(
    await screen.findByRole("button", { name: /finish review/i }, WAIT),
  );
  await screen.findByLabelText("Review summary", {}, WAIT);
  act(() => cmSetValue(screen.getByRole("dialog"), summary));
}

function noLocatingCopy() {
  // Deliberately include hidden DOM; a visually hidden status still regresses.
  expect(document.body.textContent).not.toMatch(/locating/i);
  expect(
    screen.queryByRole("button", { name: /retry locating/i, hidden: true }),
  ).toBeNull();
}

function pendingControls() {
  const dialog = screen.getByRole("dialog");
  const actions = within(dialog).getAllByRole("button", {
    name: /^(Comment|Request changes|Approve|Submitting…)$/,
  });
  expect(actions).toHaveLength(3);
  expect(
    within(dialog).getAllByRole("button", { name: "Submitting…" }).length,
  ).toBeGreaterThan(0);
  for (const action of actions) {
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(action);
  }
  expect(server.posts).toHaveLength(1);
  noLocatingCopy();
}

function ordinarySuccess(verdict: SpecReviewVerdict) {
  expect(success.mock.calls.map(([message]) => message)).toEqual([
    SUCCESS[verdict],
  ]);
  expect(failure).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/review failed/i);
  noLocatingCopy();
  expect(
    JSON.parse(localStorage.getItem("todou-spec-review:demo:7") ?? "[]"),
  ).toEqual([]);
  expect(server.posts).toHaveLength(1);
}

const href = (router: AnyRouter) => router.state.location.href;
const tail = (client: QueryClient) =>
  client.getQueryData<InfiniteData<TimelinePage, TimelinePageParam>>(TAIL_KEY);

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// No waitFor under a frozen clock. Advance the actual scheduler, with a bound
// so a missing router transition fails rather than hanging the test worker.
async function clockUntil(assertion: () => void, budget = 1000) {
  let last: unknown;
  for (let elapsed = 0; elapsed <= budget; elapsed += 10) {
    await tick(elapsed === 0 ? 0 : 10);
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function at(start: number, offset: number) {
  const remaining = start + offset - Date.now();
  expect(remaining).toBeGreaterThanOrEqual(0);
  await tick(remaining);
}

async function startTimedSubmit(
  branch: Branch,
  width: number,
  verdict: SpecReviewVerdict,
) {
  const view = mountBranch(branch, width);
  await openReview();
  const button = screen.getByRole("button", { name: LABEL[verdict] });
  const response = held<Response>();
  server.postReply = () => response.promise;
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  // Two activations in one turn exercise the ref/session single-flight guard,
  // before a disabled re-render can hide a second request.
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  await tick(0);
  expect(server.posts).toHaveLength(1);
  return { ...view, response };
}

async function releasePost(
  response: Deferred<Response>,
  verdict: SpecReviewVerdict,
) {
  const start = Date.now();
  await act(async () => {
    response.release(json(reviewResult(verdict), 201));
  });
  await tick(0);
  return start;
}

async function expectLanding(router: AnyRouter) {
  await waitFor(() => {
    expect(href(router)).toBe(`${ISSUE_URL}#event-901`);
    expect(
      document.getElementById("event-901")?.classList.contains("anchor-flash"),
    ).toBe(true);
  }, WAIT);
  return document.getElementById("event-901") as HTMLElement;
}

describe.each(WIDTHS)("review navigation at %ipx", (width) => {
  describe.each(BRANCHES)("%s submission", (branch) => {
    it.each(VERDICTS)(
      "%s reaches the response event through a real unfiltered tail",
      async (verdict) => {
        const view = mountBranch(branch, width);
        const transitions: {
          href: string;
          action: string;
          reads: number;
          data: unknown;
        }[] = [];
        cleanups.push(
          view.router.history.subscribe(({ location, action }) => {
            transitions.push({
              href: location.href,
              action: action.type,
              reads: server.timelineReads.length,
              data: tail(view.client),
            });
          }),
        );
        await openReview();
        fireEvent.click(screen.getByRole("button", { name: LABEL[verdict] }));
        const target = await expectLanding(view.router);
        ordinarySuccess(verdict);
        expect(server.posts[0]?.body).toMatchObject({
          version: 1,
          verdict,
          body: SUMMARY,
          comments: [
            {
              body: DRAFT.body,
              anchor: {
                path: "proposal.md",
                version: 1,
                line_start: 1,
                line_end: 1,
              },
            },
          ],
        });
        const push = transitions.find(
          (entry) => entry.href === `${ISSUE_URL}#event-901`,
        );
        expect(push?.action).toBe("PUSH");
        expect(push?.reads).toBeGreaterThanOrEqual(2);
        const pages = reviewPages(verdict);
        expect(push?.data).toEqual({
          pages: [pages.older, pages.newer],
          pageParams: [
            { dir: "before", cursor: "before-newer" },
            { dir: "init" },
          ],
        });
        expect(view.router.state.location.search).toEqual({});
        expect(
          view.router.history.location.state.__hashScrollIntoViewOptions,
        ).toBe(false);
        const params = server.timelineReads
          .slice(0, 2)
          .map(({ url }) => Object.fromEntries(url.searchParams));
        expect(params).toEqual([
          { last: "1", include_hidden: "true", limit: "50" },
          { before: "before-newer", include_hidden: "true", limit: "50" },
        ]);
        // The mounted issue also reads a legitimately filtered latest push.
        // Only requests captured before its PUSH belong to review preheating.
        for (const { url } of server.timelineReads.slice(0, push?.reads))
          expect(url.searchParams.has("types")).toBe(false);
        expect(target.closest('[data-testid="event-group"]')).toBeNull();
        for (const id of [
          "comment-900",
          "comment-902",
          "comment-903",
          "event-904",
        ]) {
          const row = document.getElementById(id);
          expect(
            row,
            `${id} must render from the unfiltered pages`,
          ).not.toBeNull();
          expect(row?.classList.contains("anchor-flash")).toBe(false);
        }
        expect(document.getElementById("comment-900")?.textContent).toContain(
          "ordinary discussion",
        );
        const ids = [
          ...view.container.querySelectorAll(
            '[id^="comment-"], [id^="event-"]',
          ),
        ]
          .map((node) => node.id)
          .filter((id) => /^(comment-(900|902|903)|event-(901|904))$/.test(id));
        expect(ids).toEqual([
          "comment-900",
          "event-901",
          "comment-902",
          "comment-903",
          "event-904",
        ]);

        // A real InfiniteQuery refetch must still use the older page's BEFORE
        // cursor, then increment from its next_cursor, never reverse the pages.
        const refetchStart = server.timelineReads.length;
        await act(async () => {
          await view.client.refetchQueries({ queryKey: TAIL_KEY, exact: true });
        });
        const refetched = server.timelineReads
          .slice(refetchStart)
          .map(({ url }) => url.searchParams);
        expect(refetched[0]?.get("before")).toBe("before-newer");
        expect(refetched[1]?.get("after")).toBe("after-901");
        expect(refetched.every((params) => !params.has("types"))).toBe(true);
        expect(
          timelineTailOptions("demo", 7).getNextPageParam?.(
            pages.newer,
            [pages.older, pages.newer],
            { dir: "init" },
            [],
          ),
        ).toEqual({ dir: "after", cursor: "after-904" });
      },
      25_000,
    );

    it.each(VERDICTS)(
      "%s times out at 3000ms as ordinary success, with no late cache write or jump",
      async (verdict) => {
        const requests: Deferred<Response>[] = [];
        server.timelineReply = () => {
          const request = held<Response>();
          requests.push(request);
          return request.promise;
        };
        const view = await startTimedSubmit(branch, width, verdict);
        const start = await releasePost(view.response, verdict);
        expect(requests).toHaveLength(1);
        pendingControls();
        await at(start, 1249);
        expect(requests).toHaveLength(1);
        await at(start, 1250);
        pendingControls();
        await at(start, 1749);
        expect(requests).toHaveLength(1);
        await at(start, 1750);
        expect(requests).toHaveLength(2);
        await at(start, 2999);
        pendingControls();
        expect(success).not.toHaveBeenCalled();
        expect(href(view.router)).toBe(SPEC_URL);
        expect(tail(view.client)).toBeUndefined();
        await at(start, 3000);
        ordinarySuccess(verdict);
        expect(href(view.router)).toBe(SPEC_URL);
        expect(tail(view.client)).toBeUndefined();
        const toastCount = success.mock.calls.length;
        await act(async () => {
          for (const request of requests)
            request.release(json(reviewPages(verdict).older));
        });
        await tick(5000);
        expect(href(view.router)).toBe(SPEC_URL);
        expect(tail(view.client)).toBeUndefined();
        expect(success).toHaveBeenCalledTimes(toastCount);
        expect(server.timelineReads).toHaveLength(2);
        expect(failure).not.toHaveBeenCalled();
        noLocatingCopy();
      },
      25_000,
    );
  });
});

describe.each(BRANCHES)("%s completion failure boundaries", (branch) => {
  it("a newer equal spec GET protects a reopened round from an old approve response", async () => {
    // A approved, then B requested changes, while A's POST201 was delayed.
    // Both before/after GETs can have identical false fields: reference
    // equality is insufficient because QueryClient structurally shares them.
    // Removing the completion revision guard must turn false into true here,
    // disable Approve and prevent the second actual POST.
    const reopened = { ...SPEC, review_status: "changes_requested" as const };
    server.specReply = async () => json(reopened);
    server.timelineReply = async () => json(reviewPages("approve").empty);
    const post = held<Response>();
    server.postReply = () => post.promise;
    const view = mountBranch(branch);
    await openReview();
    const key = specQuery("demo", 7).queryKey;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: key, exact: true });
    });
    const before = view.client.getQueryData(key);
    const revision = view.client.getQueryState(key)?.dataUpdateCount ?? 0;
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.posts).toHaveLength(1), WAIT);
    let freshReads = 0;
    server.specReply = async () => {
      freshReads++;
      return json(reopened);
    };
    await act(async () => {
      await view.client.refetchQueries({ queryKey: key, exact: true });
    });
    expect(freshReads).toBe(1);
    expect(view.client.getQueryData(key)).toBe(before);
    expect(view.client.getQueryState(key)?.dataUpdateCount).toBeGreaterThan(
      revision,
    );
    expect(
      view.client.getQueryData(key)?.viewer_review?.approved_in_current_round,
    ).toBe(false);

    // No later successful GET may hide an incorrect local true mirror.
    const refresh = held<Response>();
    server.specReply = () => refresh.promise;
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const start = await releasePost(post, "approve");
    expect(
      view.client.getQueryData(key)?.viewer_review?.approved_in_current_round,
    ).toBe(false);
    await at(start, 500);
    ordinarySuccess("approve");
    expect(href(view.router)).toBe(SPEC_URL);
    if (branch === "controlled") {
      fireEvent.click(screen.getByRole("button", { name: /finish review/i }));
    }
    await clockUntil(() => {
      expect(
        screen
          .getByRole("button", { name: "Approve" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    const second = held<Response>();
    server.postReply = () => second.promise;
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await clockUntil(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]?.body.verdict).toBe("approve");
    expect(failure).not.toHaveBeenCalled();
    // afterEach retires the deliberately still-pending refresh and second POST.
  }, 25_000);

  it("finishes a quick miss after two rounds without a fixed 3000ms minimum", async () => {
    server.timelineReply = async () => json(reviewPages("comment").empty);
    const view = await startTimedSubmit(branch, 1280, "comment");
    const start = await releasePost(view.response, "comment");
    await at(start, 499);
    expect(success).not.toHaveBeenCalled();
    await at(start, 500);
    ordinarySuccess("comment");
    expect(server.timelineReads).toHaveLength(2);
    expect(href(view.router)).toBe(SPEC_URL);
    expect(tail(view.client)).toBeUndefined();
  });

  it("ignores a retired first-round target while the second round still owns the wait", async () => {
    const old = held<Response>();
    const current = held<Response>();
    let read = 0;
    server.timelineReply = () => (++read === 1 ? old.promise : current.promise);
    const view = await startTimedSubmit(branch, 1280, "comment");
    const start = await releasePost(view.response, "comment");
    await at(start, 1750);
    await act(async () => {
      old.release(json(reviewPages("comment").older));
    });
    await tick(0);
    expect(tail(view.client)).toBeUndefined();
    expect(href(view.router)).toBe(SPEC_URL);
    expect(success).not.toHaveBeenCalled();
    pendingControls();
    await at(start, 2000);
    await act(async () => {
      current.release(json(reviewPages("comment").older));
    });
    await clockUntil(() =>
      expect(href(view.router)).toBe(`${ISSUE_URL}#event-901`),
    );
    ordinarySuccess("comment");
  });

  it("does not seed when asynchronous cache preparation crosses the absolute deadline", async () => {
    const second = held<Response>();
    let read = 0;
    server.timelineReply = async () =>
      ++read === 1 ? json(reviewPages("comment").empty) : second.promise;
    const view = await startTimedSubmit(branch, 1280, "comment");
    const preparation = held<void>();
    const cancel = view.client.cancelQueries.bind(view.client);
    vi.spyOn(view.client, "cancelQueries").mockImplementation(
      async (...args) => {
        await cancel(...args);
        if (JSON.stringify(args[0]?.queryKey) === JSON.stringify(TAIL_KEY))
          await preparation.promise;
      },
    );
    const start = await releasePost(view.response, "comment");
    await at(start, 500);
    await at(start, 1600);
    await act(async () => {
      second.release(json(reviewPages("comment").older));
    });
    await tick(0);
    expect(view.client.cancelQueries).toHaveBeenCalledWith({
      queryKey: TAIL_KEY,
      exact: true,
    });
    await at(start, 3001);
    await act(async () => {
      preparation.release(undefined);
    });
    await tick(0);
    ordinarySuccess("comment");
    expect(tail(view.client)).toBeUndefined();
    expect(href(view.router)).toBe(SPEC_URL);
  });

  it.each([403, 503])(
    "a timeline HTTP %i cannot turn POST201 into Review failed",
    async (status) => {
      server.timelineReply = async () =>
        json({ error: "timeline read unavailable" }, status);
      const view = await startTimedSubmit(branch, 1280, "comment");
      const start = await releasePost(view.response, "comment");
      await at(start, 500);
      ordinarySuccess("comment");
      expect(server.timelineReads).toHaveLength(status === 403 ? 1 : 2);
      expect(tail(view.client)).toBeUndefined();
      expect(href(view.router)).toBe(SPEC_URL);
    },
  );

  it("a real history write rejection stays a successful review", async () => {
    const view = mountBranch(branch);
    await openReview();
    // Fault at the history boundary; router.navigate itself remains real.
    const push = vi
      .spyOn(view.router.history, "push")
      .mockImplementationOnce(() => {
        throw new Error("history write rejected");
      });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(push).toHaveBeenCalled(), WAIT);
    await waitFor(() => ordinarySuccess("comment"), WAIT);
    expect(href(view.router)).toBe(SPEC_URL);
    expect(view.router.history.location.href).toBe(SPEC_URL);
    expect(
      tail(view.client)
        ?.pages.flatMap((page) => page.items)
        .some((item) => item.id === 901),
    ).toBe(true);
  }, 25_000);

  it("3000ms never completes a pending POST, and POST failure preserves input", async () => {
    const view = await startTimedSubmit(branch, 1280, "comment");
    await tick(5000);
    pendingControls();
    expect(server.timelineReads).toHaveLength(0);
    expect(success).not.toHaveBeenCalled();
    expect(href(view.router)).toBe(SPEC_URL);
    expect(cmGetValue(screen.getByRole("dialog"))).toBe(SUMMARY);
    await act(async () => {
      view.response.release(json({ error: "review POST rejected" }, 500));
    });
    await clockUntil(() => expect(failure).toHaveBeenCalledTimes(1));
    expect(success).not.toHaveBeenCalled();
    expect(server.timelineReads).toHaveLength(0);
    expect(cmGetValue(screen.getByRole("dialog"))).toBe(SUMMARY);
    expect(
      JSON.parse(localStorage.getItem("todou-spec-review:demo:7") ?? "[]"),
    ).toEqual(stagedDrafts);
    expect(href(view.router)).toBe(SPEC_URL);
  });
});

/** Close the real dialog before asking the real route blocker to leave. */
async function leaveSpec(router: AnyRouter) {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  void router.navigate({
    to: "/projects/$slug/issues/$number",
    params: { slug: "demo", number: "7" },
  });
  await screen.findByText("Leave with unsaved changes?", {}, WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
  await waitFor(() => expect(href(router)).toBe(ISSUE_URL), WAIT);
}

describe("controlled session ownership", () => {
  it.each(["POST", "GET"] as const)(
    "a late %s cannot seize a departed route or clear a reentered summary",
    async (phase) => {
      const post = held<Response>();
      const target = held<Response>();
      server.postReply = () => post.promise;
      server.timelineReply = () => target.promise;
      const view = mountBranch("controlled");
      await openReview();
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await waitFor(() => expect(server.posts).toHaveLength(1), WAIT);
      if (phase === "GET") {
        await act(async () => {
          post.release(json(reviewResult("comment"), 201));
        });
        await waitFor(
          () => expect(server.timelineReads.length).toBeGreaterThan(0),
          WAIT,
        );
      }
      await leaveSpec(view.router);
      await act(async () => {
        await view.router.navigate({
          to: "/projects/$slug/issues/$number/spec",
          params: { slug: "demo", number: "7" },
          search: { v: 1, file: "proposal.md" },
          hash: "spec-top",
        });
      });
      await openReview("new visit summary");
      pendingControls();
      await act(async () => {
        post.release(json(reviewResult("comment"), 201));
        target.release(json(reviewPages("comment").older));
      });
      await waitFor(() => expect(success).toHaveBeenCalledTimes(1), WAIT);
      expect(href(view.router)).toBe(SPEC_URL);
      expect(cmGetValue(screen.getByRole("dialog"))).toBe("new visit summary");
      expect(screen.queryByRole("button", { name: "Submitting…" })).toBeNull();
      ordinarySuccess("comment");
      // A previous issue visit may have legitimately fetched its own tail;
      // check that the completion did not issue a second navigation instead of
      // treating any issue-owned cache population as stale-operation seeding.
      expect(document.getElementById("event-901")).toBeNull();
    },
    25_000,
  );

  it("a completed POST on a departed page cannot reclaim the current route", async () => {
    const post = held<Response>();
    server.postReply = () => post.promise;
    const view = mountBranch("controlled");
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await leaveSpec(view.router);
    const entry = view.router.history.location.state.__TSR_index;
    await act(async () => {
      post.release(json(reviewResult("comment"), 201));
    });
    await waitFor(() => ordinarySuccess("comment"), WAIT);
    expect(href(view.router)).toBe(ISSUE_URL);
    expect(view.router.history.location.state.__TSR_index).toBe(entry);
    expect(view.router.state.location.hash).toBe("");
  }, 25_000);

  it("new text entered during POST keeps the ordinary unsaved guard; cancelling does not ask twice", async () => {
    const post = held<Response>();
    server.postReply = () => post.promise;
    const view = mountBranch("controlled");
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    act(() =>
      cmSetValue(screen.getByRole("dialog"), "new unsubmitted summary"),
    );
    await act(async () => {
      post.release(json(reviewResult("comment"), 201));
    });
    await screen.findByText("Leave with unsaved changes?", {}, WAIT);
    expect(screen.getAllByText("Leave with unsaved changes?")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(
      () =>
        expect(screen.queryByText("Leave with unsaved changes?")).toBeNull(),
      WAIT,
    );
    expect(href(view.router)).toBe(SPEC_URL);
    expect(cmGetValue(screen.getByRole("dialog"))).toBe(
      "new unsubmitted summary",
    );
    ordinarySuccess("comment");
    vi.useFakeTimers();
    await tick(5000);
    expect(screen.queryByText("Leave with unsaved changes?")).toBeNull();
    expect(href(view.router)).toBe(SPEC_URL);
    expect(server.posts).toHaveLength(1);
  }, 25_000);
});

const SOURCES = [
  {
    name: "filtered list",
    url: "/projects/demo?q=review&category=all&status=1,2&label=10,11&assignee=9&sort=created&order=asc&group=none",
    back: "Back to Issues",
  },
  { name: "board", url: "/projects/demo/board", back: "Back to Board" },
  {
    name: "search",
    url: "/projects/demo/search?q=review&in=issues,specs&status=1,2&label=10,11&assignee=9",
    back: "Back to Search",
  },
  { name: "inbox", url: "/inbox?tab=specs", back: "Back to Inbox" },
  {
    name: "user",
    url: "/users/alice?role=author&state=all",
    back: "Back to alice",
  },
];

function clickLink(link: HTMLElement) {
  fireEvent.pointerDown(link, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(link, { button: 0 });
  fireEvent.click(link, { button: 0 });
}

function startAppAt(url: string) {
  // As in return-navigation: a singleton's previous settling work can keep
  // load/navigate pending after unmount. Let real navigation restart it and
  // let the page assertions, rather than that promise, establish readiness.
  void appRouter
    .navigate({ href: url, replace: true, ignoreBlocker: true })
    .catch(() => undefined);
  return delay(50);
}

/**
 * The way back, wherever this viewport puts it (T-461). Below `sm` it is the
 * header's nav that carries it, because no page has a gutter or a heading to
 * hang one beside there; from `sm` up it travels with the card's own heading.
 * Reading it out of one fixed row would quietly stop testing anything on
 * whichever side of 640px the case is not on.
 */
async function backControlNamed(name: string): Promise<HTMLElement> {
  const header = document.querySelector("header");
  if (window.innerWidth < 640 && header !== null) {
    return within(header).findByRole("link", { name }, WAIT);
  }
  const block = await screen.findByTestId("issue-title-block", {}, WAIT);
  return within(block).findByRole("link", { name }, WAIT);
}

function addressBar() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function sameUrl(actual: string, expected: string) {
  const a = new URL(actual, "http://localhost");
  const b = new URL(expected, "http://localhost");
  expect(a.pathname).toBe(b.pathname);
  expect([...a.searchParams].sort()).toEqual([...b.searchParams].sort());
  expect(a.hash).toBe(b.hash);
}

describe("T-407 real application origins and browser history", () => {
  it.each(SOURCES)(
    "preserves $name through spec submit, Back, Forward and product return",
    async ({ url, back }) => {
      reviewViewport(390);
      const client = testQueryClient();
      cleanups.push(() => client.clear());
      await startAppAt(url);
      renderOnTheAppRouter(client);
      const links = await screen.findAllByRole(
        "link",
        { name: new RegExp(ISSUE_TITLE) },
        WAIT,
      );
      clickLink(links[0] as HTMLElement);
      await waitFor(
        () =>
          expect(appRouter.state.location.pathname).toMatch(
            /\/issues\/7(?:\/spec)?$/,
          ),
        WAIT,
      );
      if (appRouter.state.location.pathname === ISSUE_URL) {
        clickLink(
          await screen.findByRole("link", { name: "proposal.md" }, WAIT),
        );
      }
      await screen.findByRole("button", { name: /finish review/i }, WAIT);
      const before = structuredClone(
        readCurrentReturnEntry(appRouter, ME.id).origin,
      );
      expect(before).toBeDefined();
      expect(before?.pages).toBeDefined();
      const specHref = addressBar();
      const index = appRouter.history.location.state.__TSR_index;
      await openReview();
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      await expectLanding(appRouter);
      expect(addressBar()).toBe(`${ISSUE_URL}#event-901`);
      expect(appRouter.history.location.state.__TSR_index).toBe(index + 1);
      expect(readCurrentReturnEntry(appRouter, ME.id).origin).toEqual(before);
      const returnLink = await backControlNamed(back);
      sameUrl(returnLink.getAttribute("href") ?? "", url);
      ordinarySuccess("comment");

      act(() => appRouter.history.back());
      await waitFor(() => expect(addressBar()).toBe(specHref), WAIT);
      await screen.findByRole("button", { name: /finish review/i }, WAIT);
      expect(readCurrentReturnEntry(appRouter, ME.id).origin).toEqual(before);
      act(() => appRouter.history.forward());
      await expectLanding(appRouter);
      clickLink(await backControlNamed(back));
      await waitFor(() => sameUrl(addressBar(), url), WAIT);
      await screen.findAllByRole(
        "link",
        { name: new RegExp(ISSUE_TITLE) },
        WAIT,
      );
      await waitFor(() => {
        const restored = readCurrentReturnEntry(appRouter, ME.id);
        expect(restored.pending).toBeUndefined();
        expect(restored.view?.target).toEqual(before?.target);
        expect(restored.view?.pages).toEqual(before?.pages);
      }, WAIT);
    },
    30_000,
  );

  it("a direct spec href has no recent-source fallback after a review", async () => {
    reviewViewport(1280);
    const client = testQueryClient();
    cleanups.push(() => client.clear());
    await startAppAt("/projects/demo/search?q=review");
    renderOnTheAppRouter(client);
    await screen.findAllByRole("link", { name: new RegExp(ISSUE_TITLE) }, WAIT);
    appRouter.history.push(SPEC_URL);
    appRouter.history.flush();
    await screen.findByRole("button", { name: /finish review/i }, WAIT);
    expect(readCurrentReturnEntry(appRouter, ME.id).origin).toBeUndefined();
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await expectLanding(appRouter);
    const back = await backControlNamed("Back to Issues");
    expect(back.getAttribute("href")).toBe("/projects/demo");
    clickLink(back);
    await waitFor(() => expect(addressBar()).toBe("/projects/demo"), WAIT);
  }, 25_000);
});

describe("real review rows, MarkdownView permalinks and highlight lifetime", () => {
  it("keeps adjacent same-actor reviews standalone in the real grouping function", () => {
    const pages = reviewPages("approve");
    const events = [...pages.older.items, ...pages.newer.items].filter(
      (item) => item.type === "event",
    );
    expect(events.map((event) => event.id)).toEqual([901, 904]);
    expect(events[0]?.actor).toEqual(events[1]?.actor);
    const units = groupTimeline(events);
    expect(units.map((unit) => unit.kind)).toEqual(["item", "item"]);
  });

  it("uses the actual two-second flash on event901 and leaves event Markdown href/text plain", async () => {
    const view = mountBranch("controlled");
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const target = await expectLanding(view.router);
    const summary = document.getElementById("comment-902");
    expect(summary).not.toBeNull();
    const link = within(summary as HTMLElement).getByRole("link", {
      name: "review event",
    });
    expect(link.getAttribute("href")).toBe(`${ISSUE_URL}#event-901`);
    expect(link.textContent).toBe("review event");
    expect(link.getAttribute("data-issue-link")).toBeNull();
    expect(link.getAttribute("data-comment-link")).toBeNull();
    expect(link.getAttribute("title")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
    // The issue has already been fetched for the real destination page: an
    // invalid enhancer cannot pass solely because its metadata was missing.
    expect(view.client.getQueryData(["issue", "demo", 7])).toBeDefined();
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toMatch(
      /\.anchor-flash\s*\{\s*animation:\s*anchor-flash\s+2s\s+ease-out\s+both\s*;/,
    );
    vi.useFakeTimers();
    await tick(1999);
    expect(target.classList.contains("anchor-flash")).toBe(true);
    await tick(1);
    // happy-dom does not run CSS animations; exercise the real cleanup
    // listener with the event a browser emits at the verified CSS deadline.
    fireEvent.animationEnd(target, {
      animationName: "anchor-flash",
      elapsedTime: 2,
    });
    expect(target.classList.contains("anchor-flash")).toBe(false);
    expect(document.querySelectorAll(".anchor-flash")).toHaveLength(0);
  }, 25_000);
});
