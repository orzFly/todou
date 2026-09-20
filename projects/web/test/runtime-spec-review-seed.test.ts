import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { SpecReviewResult, TimelineEvent, TimelinePage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBridge } from "../src/api/runtime/bridge.ts";
import type { ProjectionDescriptor } from "../src/api/runtime/projections.ts";
import type { RuntimeSnapshot } from "../src/api/runtime/protocol.ts";
import { installRuntimeQueryAdapter } from "../src/api/runtime/query-adapter.ts";
import type { TimelineWindowData } from "../src/api/runtime/timeline.ts";
import { prepareSpecReviewTarget } from "../src/api/spec-review-target.ts";
import {
  timelineHeadOptions,
  timelineTailOptions,
} from "../src/api/timeline.ts";

const KEY = ["timeline", "p", 19, "tail"];
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
const REVIEW = SpecReviewResult.parse({
  event_id: 901,
  version: 2,
  verdict: "approve",
  summary_comment_id: null,
  comment_ids: [],
});
const OLDEST = TimelinePage.parse({
  items: [TARGET],
  prev_cursor: null,
  next_cursor: "after-target",
  total_count: 3,
});
const MIDDLE = TimelinePage.parse({
  items: [{ ...TARGET, id: 902 }],
  prev_cursor: "before-middle",
  next_cursor: "after-middle",
  total_count: 3,
});
const NEWEST = TimelinePage.parse({
  items: [{ ...TARGET, id: 903 }],
  prev_cursor: "before-newest",
  next_cursor: "after-newest",
  total_count: 3,
});
const SHALLOW: TimelineWindowData = {
  pages: [NEWEST],
  pageParams: [{ dir: "init" }],
};
const SEEDED: TimelineWindowData = {
  pages: [OLDEST, MIDDLE, NEWEST],
  pageParams: [
    { dir: "before", cursor: "before-middle" },
    { dir: "before", cursor: "before-newest" },
    { dir: "init" },
  ],
};

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

interface Subscription {
  projection: ProjectionDescriptor;
  listener: (snapshot: RuntimeSnapshot) => void;
  stopped: boolean;
}
function workerHarness() {
  const invalidation = held<unknown>();
  const cancellation = held<unknown>();
  const subscriptions: Subscription[] = [];
  const control = vi.fn<RuntimeBridge["control"]>((type) => {
    if (type === "INVALIDATE") return invalidation.promise;
    if (type === "CANCEL") return cancellation.promise;
    return Promise.resolve({});
  });
  const bridge: RuntimeBridge = {
    mode: "worker",
    ready: Promise.resolve(),
    bootstrap: async () => {
      throw new Error("Unexpected bootstrap");
    },
    read: async () => {
      throw new Error("Unexpected resource read");
    },
    readProjection: async () => {
      throw new Error("Unexpected projection read");
    },
    subscribe(projection, _options, listener) {
      const subscription = { projection, listener, stopped: false };
      subscriptions.push(subscription);
      return () => {
        subscription.stopped = true;
      };
    },
    control,
    onFrame: () => () => {},
    onSessionReset: () => () => {},
    onMode: () => () => {},
    authTransition: (action) => action(),
    authRedirect: async () => {
      throw new Error("Unexpected auth redirect");
    },
    captureAuthFence: () => "test-settled-session",
    assertAuthFence(token) {
      if (token !== "test-settled-session")
        throw new Error("Auth fence changed");
    },
    dispose() {},
  };
  function emit(
    subscription: Subscription,
    data: TimelineWindowData,
    revision: number,
  ) {
    // Deliberately permit delivery after unsubscribe: queued port callbacks are
    // exactly the stale writer the page adapter must reject by ownership.
    subscription.listener({
      projectionHash: subscription.projection.queryHash,
      status: "success",
      fetchStatus: "idle",
      data,
      revision,
      generation: 2,
      fetchedAt: Date.now(),
      stale: false,
    });
  }
  return { bridge, subscriptions, control, invalidation, cancellation, emit };
}

function networkPages() {
  const requests: URL[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = new URL(String(input), "https://todou.example");
    if (url.pathname !== "/api/projects/p/issues/19/timeline") {
      throw new Error(`Unexpected path ${url.pathname}`);
    }
    requests.push(url);
    if (url.searchParams.get("last") === "1") return Response.json(NEWEST);
    if (url.searchParams.get("before") === "before-newest")
      return Response.json(MIDDLE);
    if (url.searchParams.get("before") === "before-middle")
      return Response.json(OLDEST);
    throw new Error(`Unexpected timeline cursor ${url.search}`);
  });
  return requests;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("imperative shared infinite timeline reads", () => {
  it("fetches and prefetches native pages at the requested depth without nesting projections", async () => {
    const requests: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = new URL(String(input), "https://todou.example");
      if (url.pathname !== "/api/projects/p/issues/19/timeline") {
        throw new Error(`Unexpected path ${url.pathname}`);
      }
      requests.push(Object.fromEntries(url.searchParams));
      const after = url.searchParams.get("after");
      if (after === "after-target") return Response.json(MIDDLE);
      if (after === "after-middle") return Response.json(NEWEST);
      return Response.json(OLDEST);
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const worker = workerHarness();
    const readProjection = vi.spyOn(worker.bridge, "readProjection");
    const adapter = installRuntimeQueryAdapter(client, worker.bridge);
    try {
      const tail = await client.fetchInfiniteQuery({
        ...timelineTailOptions("p", 19),
        pages: 3,
      });
      expect(tail).toEqual({
        pages: [OLDEST, MIDDLE, NEWEST],
        pageParams: [
          { dir: "init" },
          { dir: "after", cursor: "after-target" },
          { dir: "after", cursor: "after-middle" },
        ],
      });
      expect(client.getQueryData(KEY)).toEqual(tail);
      expect(requests).toEqual([
        { include_hidden: "true", limit: "50", last: "1" },
        { include_hidden: "true", limit: "50", after: "after-target" },
        { include_hidden: "true", limit: "50", after: "after-middle" },
      ]);
      const headOptions = timelineHeadOptions("p", 19, true);
      expect(
        await client.prefetchInfiniteQuery({ ...headOptions, pages: 2 }),
      ).toBeUndefined();
      expect(client.getQueryData(headOptions.queryKey)).toEqual({
        pages: [OLDEST, MIDDLE],
        pageParams: [
          { dir: "init-head" },
          { dir: "after", cursor: "after-target" },
        ],
      });
      expect(requests.slice(3)).toEqual([
        { include_hidden: "true", limit: "50" },
        { include_hidden: "true", limit: "50", after: "after-target" },
      ]);
      expect(readProjection).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
      client.clear();
    }
  });
});

describe("review network seed ownership", () => {
  it("seeds a deeper window after invalidate began and rejects late shallow snapshots without waiting for onSettled", async () => {
    vi.useFakeTimers();
    const requests = networkPages();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const worker = workerHarness();
    const adapter = installRuntimeQueryAdapter(client, worker.bridge);
    const observer = new InfiniteQueryObserver(client, {
      ...timelineTailOptions("p", 19),
      initialData: SHALLOW,
    });
    const stop = observer.subscribe(() => {});
    const writes: {
      depth: number;
      descriptor: ProjectionDescriptor | undefined;
    }[] = [];
    const stopWrites = client.getQueryCache().subscribe((event) => {
      const data = event.query.state.data as TimelineWindowData | undefined;
      if (event.query.queryKey[0] !== "timeline" || !data) return;
      writes.push({
        depth: data.pages.length,
        descriptor: (
          event.query.meta?.runtime as
            | { projection?: ProjectionDescriptor }
            | undefined
        )?.projection,
      });
    });
    let current = true;
    try {
      await vi.advanceTimersByTimeAsync(0);
      const shallowSubscription = worker.subscriptions.at(-1)!;
      expect(
        shallowSubscription.projection.windowDescriptor?.pageParams,
      ).toHaveLength(1);
      // use-review-completion starts this before calling prepareSpecReviewTarget.
      const invalidation = client.invalidateQueries({
        queryKey: ["timeline", "p", 19],
      });
      expect(
        worker.control.mock.calls.some(([type]) => type === "INVALIDATE"),
      ).toBe(true);
      const pending = prepareSpecReviewTarget({
        queryClient: client,
        slug: "p",
        issueNumber: 19,
        result: REVIEW,
        isCurrent: () => current,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(3);
      expect(
        worker.control.mock.calls.some(([type]) => type === "CANCEL"),
      ).toBe(true);
      const stale = { ...SHALLOW, pages: [{ ...NEWEST, total_count: 99 }] };
      worker.emit(shallowSubscription, stale, 100);
      expect(client.getQueryData(KEY)).toEqual(SHALLOW);
      worker.cancellation.resolve({});
      const prepared = await pending;
      expect(prepared.status).toBe("found");
      if (prepared.status !== "found") throw new Error("Expected target");
      expect(prepared.canNavigate()).toBe(true);
      expect(client.getQueryData(KEY)).toEqual(SEEDED);
      expect(shallowSubscription.stopped).toBe(true);
      const deeperSubscription = worker.subscriptions.at(-1)!;
      expect(deeperSubscription.projection.windowDescriptor).toEqual({
        initialPageParam: { dir: "init" },
        pageParams: SEEDED.pageParams,
        depth: 3,
      });
      expect(
        writes
          .filter((write) => write.depth === 3)
          .every((write) => write.descriptor?.windowDescriptor?.depth === 3),
      ).toBe(true);
      worker.emit(shallowSubscription, stale, 1_000);
      expect(client.getQueryData(KEY)).toEqual(SEEDED);
      // The earlier review invalidation is still pending. No new onSettled
      // exists; accepting this snapshot proves the seed released its own barrier.
      const revalidated: TimelineWindowData = {
        pages: [OLDEST, MIDDLE, { ...NEWEST, total_count: 4 }],
        pageParams: [
          SEEDED.pageParams[0]!,
          { dir: "after", cursor: "after-target" },
          { dir: "after", cursor: "after-middle" },
        ],
      };
      worker.emit(deeperSubscription, revalidated, 1);
      expect(client.getQueryData(KEY)).toEqual(revalidated);
      worker.invalidation.resolve({});
      await invalidation;
      const active = worker.subscriptions.at(-1)!;
      worker.emit(
        active,
        {
          ...revalidated,
          pages: revalidated.pages.map((page) => ({ ...page, total_count: 5 })),
        },
        2,
      );
      expect(client.getQueryData<TimelineWindowData>(KEY)?.pages).toHaveLength(
        3,
      );
      expect(
        client.getQueryData<TimelineWindowData>(KEY)?.pages[0]?.total_count,
      ).toBe(5);
      expect(prepared.canNavigate()).toBe(true);
      current = false;
      expect(prepared.canNavigate()).toBe(false);
    } finally {
      worker.cancellation.resolve({});
      worker.invalidation.resolve({});
      stopWrites();
      stop();
      observer.destroy();
      adapter.dispose();
      client.clear();
    }
  });

  it.each(["owner", "deadline"])(
    "releases a cancelled seed barrier after losing its %s without seeding late",
    async (loss) => {
      vi.useFakeTimers();
      const started = Date.now();
      networkPages();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const worker = workerHarness();
      const adapter = installRuntimeQueryAdapter(client, worker.bridge);
      const observer = new InfiniteQueryObserver(client, {
        ...timelineTailOptions("p", 19),
        initialData: SHALLOW,
      });
      const stop = observer.subscribe(() => {});
      let current = true;
      try {
        await vi.advanceTimersByTimeAsync(0);
        const pending = prepareSpecReviewTarget({
          queryClient: client,
          slug: "p",
          issueNumber: 19,
          result: REVIEW,
          isCurrent: () => current,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(
          worker.control.mock.calls.some(([type]) => type === "CANCEL"),
        ).toBe(true);
        if (loss === "owner") current = false;
        else vi.setSystemTime(started + 1_250);
        worker.cancellation.resolve({});
        expect(await pending).toEqual({
          status: loss === "owner" ? "cancelled" : "not-found",
        });
        expect(client.getQueryData(KEY)).toEqual(SHALLOW);
        const refreshed = {
          ...SHALLOW,
          pages: [{ ...NEWEST, total_count: 4 }],
        };
        worker.emit(worker.subscriptions.at(-1)!, refreshed, 10);
        expect(client.getQueryData(KEY)).toEqual(refreshed);
      } finally {
        worker.cancellation.resolve({});
        stop();
        observer.destroy();
        adapter.dispose();
        client.clear();
      }
    },
  );
});
