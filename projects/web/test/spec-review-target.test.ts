import {
  type InfiniteData,
  InfiniteQueryObserver,
  QueryClient,
} from "@tanstack/react-query";
import { cleanup, waitFor } from "@testing-library/react";
import {
  DEFAULT_REFERENCE_CONFIG,
  SpecReviewResult,
  TimelineComment,
  TimelineEvent,
  TimelinePage,
} from "@todou/shared";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSpecReviewTarget } from "../src/api/spec-review-target.ts";
import {
  type TimelinePageParam,
  timelineTailOptions,
} from "../src/api/timeline.ts";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { renderWithProviders } from "./render.tsx";

const REVIEW = SpecReviewResult.parse({
  event_id: 901,
  version: 2,
  verdict: "approve",
  summary_comment_id: 902,
  comment_ids: [903],
});
const USER = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};
const TARGET = TimelineEvent.parse({
  type: "event",
  id: 901,
  event_type: "spec_review",
  actor: USER,
  payload: { version: 2, verdict: "approve" },
  created_at: "2026-09-01T00:00:00Z",
  agent_context: null,
});
const SUMMARY = TimelineComment.parse({
  type: "comment",
  id: 902,
  author: USER,
  body: "Submitted summary",
  created_at: "2026-09-01T00:00:01Z",
  edited_at: null,
  agent_context: null,
});
const COMMENT = TimelineComment.parse({
  ...SUMMARY,
  id: 903,
  body: "Ordinary unfiltered comment",
  created_at: "2026-09-01T00:00:02Z",
});
const CONCURRENT = TimelineEvent.parse({
  ...TARGET,
  id: 904,
  created_at: "2026-09-01T00:00:03Z",
});
const OLDEST = TimelinePage.parse({
  items: [TARGET],
  prev_cursor: null,
  next_cursor: "after-target",
  total_count: 4,
  has_more: false,
});
const MIDDLE = TimelinePage.parse({
  items: [SUMMARY, COMMENT],
  prev_cursor: "before-middle",
  next_cursor: "after-comments",
  total_count: 4,
  has_more: true,
});
const NEWEST = TimelinePage.parse({
  items: [CONCURRENT],
  prev_cursor: "before-newest",
  next_cursor: "after-concurrent",
  total_count: 4,
  has_more: true,
});
const EMPTY = TimelinePage.parse({
  items: [],
  prev_cursor: null,
  next_cursor: null,
  total_count: 0,
  has_more: false,
});
const KEY = ["timeline", "p", 19, "tail"];
const START = new Date("2026-09-01T12:00:00Z").getTime();
type TailData = InfiniteData<TimelinePage, TimelinePageParam>;
type Request = { at: number; method: string; params: Record<string, string> };

type Held<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function held<T>(): Held<T> {
  let resolve!: Held<T>["resolve"];
  let reject!: Held<T>["reject"];
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Exercise the real TodouClient serializer and HTTP error conversion. */
function stubTimeline(
  reply: (request: Request, index: number) => Response | Promise<Response>,
  allowMetadata = false,
) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "https://todou.example");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/projects/p/issues/19/timeline") {
      const request = {
        at: Date.now() - START,
        method,
        params: Object.fromEntries(url.searchParams),
      };
      requests.push(request);
      return reply(request, requests.length - 1);
    }
    if (allowMetadata && method === "GET") {
      if (url.pathname.endsWith("/references/config")) {
        return Response.json(DEFAULT_REFERENCE_CONFIG);
      }
      if (url.pathname.endsWith("/reference-directory")) {
        return Response.json(null);
      }
      if (url.pathname.endsWith("/questions")) {
        return Response.json({ items: [], open: 0 });
      }
      return Response.json([]);
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  });
  return requests;
}

let client: QueryClient;
let current: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  current = true;
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function prepare() {
  return prepareSpecReviewTarget({
    queryClient: client,
    slug: "p",
    issueNumber: 19,
    result: REVIEW,
    isCurrent: () => current,
  });
}

describe("spec review target preparation", () => {
  it("returns immediately on an exact first-page match, including a fully loaded timeline", async () => {
    const requests = stubTimeline(() => Response.json(OLDEST));
    const result = await prepare();
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("Expected target");
    expect(result.canNavigate()).toBe(true);
    expect(Date.now()).toBe(START);
    expect(requests).toEqual([
      {
        at: 0,
        method: "GET",
        params: { include_hidden: "true", limit: "50", last: "1" },
      },
    ]);
    expect(client.getQueryData(KEY)).toEqual({
      pages: [OLDEST],
      pageParams: [{ dir: "init" }],
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(requests).toHaveLength(1);
    expect(result.canNavigate()).toBe(false);
  });

  it("seeds real oldest-to-newest pages and request params, then refetches and advances with real tail options", async () => {
    const appended = TimelinePage.parse({
      ...EMPTY,
      items: [TimelineComment.parse({ ...COMMENT, id: 905 })],
      next_cursor: "after-appended",
      total_count: 5,
    });
    const requests = stubTimeline(({ params }) => {
      if (params.last === "1") return Response.json(NEWEST);
      if (params.before === "before-newest") return Response.json(MIDDLE);
      if (params.before === "before-middle") return Response.json(OLDEST);
      if (params.after === "after-target") return Response.json(MIDDLE);
      if (params.after === "after-comments") return Response.json(NEWEST);
      if (params.after === "after-concurrent") return Response.json(appended);
      throw new Error(`Unexpected cursor ${JSON.stringify(params)}`);
    });
    const cancelled = vi.spyOn(client, "cancelQueries");
    expect((await prepare()).status).toBe("found");
    expect(cancelled).toHaveBeenCalledExactlyOnceWith({
      queryKey: KEY,
      exact: true,
    });
    expect(requests.map((r) => r.params)).toEqual([
      { include_hidden: "true", limit: "50", last: "1" },
      { include_hidden: "true", limit: "50", before: "before-newest" },
      { include_hidden: "true", limit: "50", before: "before-middle" },
    ]);
    expect(client.getQueryData<TailData>(KEY)).toEqual({
      pages: [OLDEST, MIDDLE, NEWEST],
      pageParams: [
        { dir: "before", cursor: "before-middle" },
        { dir: "before", cursor: "before-newest" },
        { dir: "init" },
      ],
    });

    // TanStack refetches forward from the first real pageParam; subsequent
    // params must be derived from the freshly returned next cursors.
    await client.fetchInfiniteQuery(timelineTailOptions("p", 19));
    expect(requests.slice(3).map((r) => r.params)).toEqual([
      { include_hidden: "true", limit: "50", before: "before-middle" },
      { include_hidden: "true", limit: "50", after: "after-target" },
      { include_hidden: "true", limit: "50", after: "after-comments" },
    ]);
    expect(client.getQueryData<TailData>(KEY)).toEqual({
      pages: [OLDEST, MIDDLE, NEWEST],
      pageParams: [
        { dir: "before", cursor: "before-middle" },
        { dir: "after", cursor: "after-target" },
        { dir: "after", cursor: "after-comments" },
      ],
    });
    const observer = new InfiniteQueryObserver(
      client,
      timelineTailOptions("p", 19),
    );
    try {
      await observer.fetchNextPage();
      expect(requests.at(-1)?.params).toEqual({
        include_hidden: "true",
        limit: "50",
        after: "after-concurrent",
      });
      expect(client.getQueryData<TailData>(KEY)?.pages).toEqual([
        OLDEST,
        MIDDLE,
        NEWEST,
        appended,
      ]);
    } finally {
      observer.destroy();
    }
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it.each([
    ["summary id", { ...TARGET, id: 902 }],
    ["annotation id", { ...TARGET, id: 903 }],
    ["newer review id", CONCURRENT],
    ["event type", { ...TARGET, event_type: "title_changed" }],
    ["version", { ...TARGET, payload: { version: 1, verdict: "approve" } }],
    ["verdict", { ...TARGET, payload: { version: 2, verdict: "comment" } }],
    ["comment type", { ...SUMMARY, id: 901 }],
  ])(
    "does not authorize navigation for a matching %s decoy",
    async (_label, decoy) => {
      const page = TimelinePage.parse({ ...OLDEST, items: [decoy] });
      const requests = stubTimeline(() => Response.json(page));
      const result = prepare();
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toEqual({ status: "not-found" });
      expect(requests).toHaveLength(2);
      expect(client.getQueryData(KEY)).toBeUndefined();
    },
  );

  it("restarts at last after a 500ms gap and does not mix first-round pages into the tail", async () => {
    const requests = stubTimeline((_request, index) =>
      Response.json(index === 0 ? { ...NEWEST, prev_cursor: null } : OLDEST),
    );
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(499);
    expect(requests).toHaveLength(1);
    expect(client.getQueryData(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("found");
    expect(requests.map((r) => r.at)).toEqual([0, 500]);
    expect(requests.every((r) => r.params.last === "1")).toBe(true);
    expect(client.getQueryData(KEY)).toEqual({
      pages: [OLDEST],
      pageParams: [{ dir: "init" }],
    });
  });

  it.each(["network", "503"])(
    "retries a transient %s failure in the second round",
    async (failure) => {
      const requests = stubTimeline((_request, index) => {
        if (index > 0) return Response.json(OLDEST);
        if (failure === "network") throw new TypeError("Network unavailable");
        return Response.json(
          {
            error: { code: "unavailable", message: "Temporarily unavailable" },
          },
          { status: 503 },
        );
      });
      const pending = prepare();
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).status).toBe("found");
      expect(requests.map((r) => r.at)).toEqual([0, 500]);
    },
  );

  it.each([401, 403, 404, 410])(
    "stops immediately on HTTP %s",
    async (status) => {
      const requests = stubTimeline(() =>
        Response.json(
          { error: { code: "unavailable", message: "Unavailable" } },
          { status },
        ),
      );
      expect(await prepare()).toEqual({ status: "not-found" });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(requests).toHaveLength(1);
      expect(client.getQueryData(KEY)).toBeUndefined();
    },
  );

  it("caps each round at three requests", async () => {
    const requests = stubTimeline((_request, index) =>
      Response.json({ ...NEWEST, prev_cursor: `older-${index}` }),
    );
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ status: "not-found" });
    expect(requests.map((r) => r.params)).toEqual([
      { include_hidden: "true", limit: "50", last: "1" },
      { include_hidden: "true", limit: "50", before: "older-0" },
      { include_hidden: "true", limit: "50", before: "older-1" },
      { include_hidden: "true", limit: "50", last: "1" },
      { include_hidden: "true", limit: "50", before: "older-3" },
      { include_hidden: "true", limit: "50", before: "older-4" },
    ]);
    expect(client.getQueryData(KEY)).toBeUndefined();
  });

  it("stops each round on a repeated cursor", async () => {
    const requests = stubTimeline(() => Response.json(NEWEST));
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ status: "not-found" });
    expect(requests.map((r) => r.params.before ?? "last")).toEqual([
      "last",
      "before-newest",
      "last",
      "before-newest",
    ]);
    expect(client.getQueryData(KEY)).toBeUndefined();
  });

  it("uses 1250ms + 500ms + 1250ms and ignores both late resolutions", async () => {
    const first = held<Response>();
    const second = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? first.promise : second.promise,
    );
    const write = vi.spyOn(client, "setQueryData");
    const settled = vi.fn();
    const pending = prepare().then((result) => {
      settled(result);
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(requests).toHaveLength(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.map((r) => r.at)).toEqual([0, 1_750]);
    await vi.advanceTimersByTimeAsync(1_249);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "not-found" });
    first.resolve(Response.json(OLDEST));
    second.resolve(Response.json(OLDEST));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  });

  it("can finish at 1750ms when the first round is immediately missing", async () => {
    const second = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? Response.json(EMPTY) : second.promise,
    );
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(1_750);
    expect(await pending).toEqual({ status: "not-found" });
    expect(requests.map((r) => r.at)).toEqual([0, 500]);
    second.reject(new TypeError("Late rejected response"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getQueryData(KEY)).toBeUndefined();
  });

  it("cannot use a first-round target that arrives during the second round", async () => {
    const first = held<Response>();
    const second = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? first.promise : second.promise,
    );
    const write = vi.spyOn(client, "setQueryData");
    const settled = vi.fn();
    const pending = prepare().then((result) => {
      settled(result);
      return result;
    });
    await vi.advanceTimersByTimeAsync(1_750);
    first.resolve(Response.json(OLDEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(write).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    second.resolve(Response.json(EMPTY));
    expect(await pending).toEqual({ status: "not-found" });
    expect(requests).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts only the second round's pages after the first round times out", async () => {
    const first = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? first.promise : Response.json(OLDEST),
    );
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(1_750);
    const result = await pending;
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("Expected target");
    expect(result.canNavigate()).toBe(true);
    expect(requests.map((request) => request.at)).toEqual([0, 1_750]);
    expect(client.getQueryData(KEY)).toEqual({
      pages: [OLDEST],
      pageParams: [{ dir: "init" }],
    });
    const prepared = client.getQueryData(KEY);
    first.resolve(Response.json(NEWEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(KEY)).toBe(prepared);
    vi.setSystemTime(START + 3_000);
    expect(result.canNavigate()).toBe(false);
  });

  it("also rejects a request whose microtask wins the race after the round deadline", async () => {
    const first = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? first.promise : Response.json(EMPTY),
    );
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    // Move wall time without firing timers: checking only the race winner
    // would incorrectly accept the target at this boundary.
    vi.setSystemTime(START + 1_250);
    first.resolve(Response.json(OLDEST));
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ status: "not-found" });
    expect(requests).toHaveLength(2);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not start a GET for an invalid owner", async () => {
    const requests = stubTimeline(() => Response.json(OLDEST));
    current = false;
    expect(await prepare()).toEqual({ status: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  it("does not seed a target after its owner is invalidated", async () => {
    const response = held<Response>();
    const requests = stubTimeline(() => response.promise);
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    current = false;
    response.resolve(Response.json(OLDEST));
    expect(await pending).toEqual({ status: "cancelled" });
    expect(requests).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not start round two after ownership is lost in the gap", async () => {
    const requests = stubTimeline(() => Response.json(EMPTY));
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(499);
    current = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "cancelled" });
    expect(requests).toHaveLength(1);
  });

  it("checks ownership again after asynchronous cache preparation", async () => {
    stubTimeline(() => Response.json(OLDEST));
    const cancellation = held<void>();
    const cancel = vi
      .spyOn(client, "cancelQueries")
      .mockReturnValue(cancellation.promise);
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    current = false;
    cancellation.resolve();
    expect(await pending).toEqual({ status: "cancelled" });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not seed when cancelQueries crosses the absolute 3000ms deadline", async () => {
    const first = held<Response>();
    const second = held<Response>();
    const cancellation = held<void>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? first.promise : second.promise,
    );
    const cancel = vi
      .spyOn(client, "cancelQueries")
      .mockReturnValue(cancellation.promise);
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(2_999);
    second.resolve(Response.json(OLDEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      queryKey: KEY,
      exact: true,
    });
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ status: "not-found" });
    cancellation.resolve();
    first.reject(new TypeError("Old round failed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled();
    expect(client.getQueryData(KEY)).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it("rechecks deadline when cancellation resolves before its overdue timer runs", async () => {
    stubTimeline(() => Response.json(OLDEST));
    const cancellation = held<void>();
    vi.spyOn(client, "cancelQueries").mockReturnValue(cancellation.promise);
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(START + 3_000);
    cancellation.resolve();
    expect(await pending).toEqual({ status: "not-found" });
    expect(write).not.toHaveBeenCalled();
  });

  it("checks ownership and time synchronously again at the navigation boundary", async () => {
    stubTimeline(() => Response.json(OLDEST));
    const result = await prepare();
    if (result.status !== "found") throw new Error("Expected target");
    expect(result.canNavigate()).toBe(true);
    current = false;
    expect(result.canNavigate()).toBe(false);
    current = true;
    vi.setSystemTime(START + 1_250);
    expect(result.canNavigate()).toBe(false);
  });

  it("does not seed or start another round when found preparation exceeds its round budget", async () => {
    const cancellation = held<void>();
    const requests = stubTimeline(() => Response.json(OLDEST));
    vi.spyOn(client, "cancelQueries").mockReturnValue(cancellation.promise);
    const write = vi.spyOn(client, "setQueryData");
    const pending = prepare();
    await vi.advanceTimersByTimeAsync(1_250);
    expect(await pending).toEqual({ status: "not-found" });
    cancellation.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("contains cancellation failure without writing or retrying the found target", async () => {
    const requests = stubTimeline(() => Response.json(OLDEST));
    vi.spyOn(client, "cancelQueries").mockRejectedValue(
      new Error("Cancellation failed"),
    );
    const write = vi.spyOn(client, "setQueryData");
    expect(await prepare()).toEqual({ status: "not-found" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(write).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("cancels a real pending tail query so it cannot overwrite the prepared cache", async () => {
    const stale = held<Response>();
    const requests = stubTimeline((_request, index) =>
      index === 0 ? stale.promise : Response.json(OLDEST),
    );
    const head = { pages: [EMPTY], pageParams: [{ dir: "init-head" }] };
    client.setQueryData(["timeline", "p", 19, "head"], head);
    client.setQueryData(["timeline", "other", 19, "tail"], head);
    const background = client.fetchInfiniteQuery(timelineTailOptions("p", 19));
    // Real query cancellation rejects the consumer; observe it immediately.
    const backgroundResult = background.then(
      () => "resolved",
      () => "cancelled",
    );
    expect((await prepare()).status).toBe("found");
    expect(await backgroundResult).toBe("cancelled");
    const prepared = client.getQueryData(KEY);
    stale.resolve(Response.json(NEWEST));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(KEY)).toBe(prepared);
    expect(client.getQueryData(KEY)).toEqual({
      pages: [OLDEST],
      pageParams: [{ dir: "init" }],
    });
    expect(client.getQueryData(["timeline", "p", 19, "head"])).toEqual(head);
    expect(client.getQueryData(["timeline", "other", 19, "tail"])).toEqual(
      head,
    );
    expect(requests).toHaveLength(2);
  });

  it("renders the prepared real pages through Timeline in chronological order", async () => {
    vi.useRealTimers();
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    });
    const requests = stubTimeline(({ params }) => {
      if (params.last === "1") return Response.json(NEWEST);
      if (params.before === "before-newest") return Response.json(MIDDLE);
      if (params.before === "before-middle") return Response.json(OLDEST);
      throw new Error("Unexpected timeline read");
    }, true);
    expect((await prepare()).status).toBe("found");
    const view = renderWithProviders(
      createElement(Timeline, {
        slug: "p",
        issueNumber: 19,
        pendingComments: [],
      }),
      client,
    );
    await view.findByText(COMMENT.body);
    await waitFor(() => {
      const ids = Array.from(
        view.container.querySelectorAll('[id^="event-"], [id^="comment-"]'),
      ).map((element) => element.id);
      expect(ids).toEqual([
        "event-901",
        "comment-902",
        "comment-903",
        "event-904",
      ]);
    });
    expect(requests).toHaveLength(3);
    expect(client.getQueryData<TailData>(KEY)?.pages.at(-1)?.total_count).toBe(
      4,
    );
    view.unmount();
  });
});
