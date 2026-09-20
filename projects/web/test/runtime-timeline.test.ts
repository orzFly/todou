import { TimelineComment, TimelinePage } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  executeProjection,
  projectionId,
  timelineAllResource,
  timelineResource,
} from "../src/api/runtime/projections.ts";
import type { ResourceDescriptor } from "../src/api/runtime/resources.ts";
import { ResourceRuntime } from "../src/api/runtime/runtime.ts";
import {
  drainTimelineComments,
  latestNextCursor,
  nextTimelinePageParam,
  previousTimelinePageParam,
  rebuildTimelineWindow,
  type TimelineWindowData,
  timelinePageQuery,
  timelineWindow,
} from "../src/api/runtime/timeline.ts";
import {
  allCommentsQuery,
  mergeFolded,
  timelineHeadOptions,
  timelineProjection,
  timelineTailOptions,
} from "../src/api/timeline.ts";

const USER = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};
function comment(id: number, hidden = false) {
  return TimelineComment.parse({
    type: "comment",
    id,
    author: USER,
    body: `Comment ${id}`,
    created_at: "2026-09-01T00:00:00Z",
    edited_at: null,
    hidden_at: hidden ? "2026-09-01T01:00:00Z" : null,
    agent_context: null,
  });
}
function page(ids: number[], next: string | null, prev: string | null = null) {
  return TimelinePage.parse({
    items: ids.map((id) => comment(id)),
    next_cursor: next,
    prev_cursor: prev,
    total_count: 6,
  });
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const OLDEST = page([1, 2], "new-middle");
const MIDDLE = page([3, 4], "new-tail", "oldest");
const NEWEST = page([5, 6], "new-end", "middle");

describe("shared timeline windows", () => {
  it("retains keys, head gate, hidden bodies and full resource parameters", () => {
    expect(timelineTailOptions("p", 19).queryKey).toEqual([
      "timeline",
      "p",
      19,
      "tail",
    ]);
    expect(timelineHeadOptions("p", 19, false).enabled).toBe(false);
    expect(timelineHeadOptions("p", 19, true).enabled).toBe(true);
    expect(allCommentsQuery("p", 19).queryKey).toEqual([
      "timeline",
      "p",
      19,
      "all",
    ]);
    expect(timelineResource("p", 19, { dir: "init" }).query).toEqual({
      include_hidden: true,
      limit: 50,
      last: 1,
    });
    expect(
      timelineResource("p", 19, { dir: "init-head" }, "head").query,
    ).toEqual({
      include_hidden: true,
      limit: 50,
    });
    expect(timelinePageQuery({ dir: "before", cursor: "older" })).toEqual({
      include_hidden: true,
      limit: 50,
      before: "older",
    });
    expect(
      timelinePageQuery({ dir: "after", cursor: "newer" }, "head"),
    ).toEqual({
      include_hidden: true,
      limit: 50,
      after: "newer",
    });
    expect(timelineAllResource("p", 19).query).toEqual({
      after: undefined,
      types: "comment,question_answered",
      limit: 100,
    });
  });

  it("isolates windows with the same key but different starting cursors or depths", () => {
    const shallow = timelineProjection("p", 19, "tail");
    const deep = timelineProjection("p", 19, "tail", [
      { dir: "before", cursor: "oldest" },
      { dir: "before", cursor: "middle" },
      { dir: "init" },
    ]);
    expect(deep.queryHash).toBe(shallow.queryHash);
    expect(deep.windowDescriptor).toEqual({
      initialPageParam: { dir: "init" },
      pageParams: [
        { dir: "before", cursor: "oldest" },
        { dir: "before", cursor: "middle" },
        { dir: "init" },
      ],
      depth: 3,
    });
    const identities = [
      shallow,
      deep,
      timelineProjection("p", 19, "tail", [{ dir: "before", cursor: "other" }]),
      timelineProjection("p", 19, "head"),
      timelineProjection("other", 19, "tail"),
      timelineProjection("p", 20, "tail"),
    ].map(projectionId);
    expect(new Set(identities).size).toBe(identities.length);
    expect(shallow.windowDescriptor.depth).toBe(1);
  });
  it("singleflights a shared page while keeping each subscriber's loaded depth", async () => {
    const first = held<TimelinePage>();
    const network = vi.fn(async (resource: ResourceDescriptor) => {
      if (resource.query?.after === "new-middle") return MIDDLE;
      if (resource.query?.after === "new-tail") return NEWEST;
      return first.promise;
    });
    const runtime = new ResourceRuntime({ network });
    const shallow = timelineProjection("p", 19, "head");
    const deep = timelineProjection("p", 19, "head", [
      { dir: "init-head" },
      { dir: "after", cursor: "old-middle" },
      { dir: "after", cursor: "old-tail" },
    ]);
    const shallowSnapshots: TimelineWindowData[] = [];
    const deepSnapshots: TimelineWindowData[] = [];
    const stopShallow = runtime.subscribe(
      "page-a",
      shallow,
      { enabled: true, visible: true },
      (snapshot) => {
        if (snapshot.status === "success")
          shallowSnapshots.push(snapshot.data as TimelineWindowData);
      },
    );
    const stopDeep = runtime.subscribe(
      "page-b",
      deep,
      { enabled: true, visible: true },
      (snapshot) => {
        if (snapshot.status === "success")
          deepSnapshots.push(snapshot.data as TimelineWindowData);
      },
    );
    try {
      await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
      first.resolve(OLDEST);
      await vi.waitFor(() => {
        expect(shallowSnapshots.at(-1)?.pages).toEqual([OLDEST]);
        expect(deepSnapshots.at(-1)?.pages).toEqual([OLDEST, MIDDLE, NEWEST]);
      });
      expect(network).toHaveBeenCalledTimes(3);
      expect(
        shallowSnapshots.every((snapshot) => snapshot.pageParams.length === 1),
      ).toBe(true);
      expect(deepSnapshots.at(-1)?.pageParams).toEqual([
        { dir: "init-head" },
        { dir: "after", cursor: "new-middle" },
        { dir: "after", cursor: "new-tail" },
      ]);
      // A fresh imperative read uses the completed shared pages, preserving the
      // requested one-page window even after another subscriber loaded three.
      expect(
        (await runtime.readProjection<TimelineWindowData>(shallow)).pages,
      ).toEqual([OLDEST]);
      expect(network).toHaveBeenCalledTimes(3);
    } finally {
      stopShallow();
      stopDeep();
      runtime.dispose();
    }
  });

  it("sequentially rebuilds a backward-expanded tail using new forward cursors", async () => {
    const first = held<TimelinePage>();
    // Deferred pages make ordering observable without replacing the recipe.
    const second = held<TimelinePage>();
    const third = held<TimelinePage>();
    const replies = [first, second, third];
    let nextReply = 0;
    const reads = vi.fn(
      (_resource: ResourceDescriptor): Promise<TimelinePage> =>
        replies[nextReply++]!.promise,
    );
    const projection = timelineProjection("p", 19, "tail", [
      { dir: "before", cursor: "oldest" },
      { dir: "before", cursor: "stale-middle" },
      { dir: "init" },
    ]);
    const settled = vi.fn();
    const pending = executeProjection(
      projection,
      async <T>(resource: ResourceDescriptor) => (await reads(resource)) as T,
    ).then((data) => {
      settled(data);
      return data;
    });
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    expect(reads.mock.calls[0]?.[0]?.query).toMatchObject({ before: "oldest" });
    first.resolve(OLDEST);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(reads.mock.calls[1]?.[0]?.query).toEqual({
      include_hidden: true,
      limit: 50,
      after: "new-middle",
    });
    expect(settled).not.toHaveBeenCalled();
    second.resolve(MIDDLE);
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
    expect(reads.mock.calls[2]?.[0]?.query).toEqual({
      include_hidden: true,
      limit: 50,
      after: "new-tail",
    });
    third.resolve(NEWEST);
    expect(await pending).toEqual({
      pages: [OLDEST, MIDDLE, NEWEST],
      pageParams: [
        { dir: "before", cursor: "oldest" },
        { dir: "after", cursor: "new-middle" },
        { dir: "after", cursor: "new-tail" },
      ],
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("keeps forward head depth, empty poll pages and their paired parameters", async () => {
    const empty = page([], null);
    const window = timelineWindow("head", [
      { dir: "init-head" },
      { dir: "after", cursor: "obsolete" },
      { dir: "after", cursor: "obsolete" },
    ]);
    const reads = vi
      .fn()
      .mockResolvedValueOnce(OLDEST)
      .mockResolvedValue(empty);
    const data = await rebuildTimelineWindow(window, reads);
    expect(data).toEqual({
      pages: [OLDEST, empty, empty],
      pageParams: [
        { dir: "init-head" },
        { dir: "after", cursor: "new-middle" },
        { dir: "after", cursor: "new-middle" },
      ],
    });
    expect(latestNextCursor(data.pages)).toBe("new-middle");
    expect(nextTimelinePageParam(data.pages)).toEqual({
      dir: "after",
      cursor: "new-middle",
    });
    expect(previousTimelinePageParam(NEWEST)).toEqual({
      dir: "before",
      cursor: "middle",
    });
    expect(previousTimelinePageParam(OLDEST)).toBeUndefined();
  });

  it("does not expose partially rebuilt pages after a later page fails", async () => {
    const failure = new Error("timeline unavailable");
    const read = vi
      .fn()
      .mockResolvedValueOnce(OLDEST)
      .mockRejectedValue(failure);
    await expect(
      rebuildTimelineWindow(
        timelineWindow("head", [
          { dir: "init-head" },
          { dir: "after", cursor: "old" },
        ]),
        read,
      ),
    ).rejects.toBe(failure);
  });

  it("preserves folded seam deduplication and hidden comment bodies", async () => {
    const hidden = comment(4, true);
    const head = { ...MIDDLE, items: [comment(3), hidden] };
    const tail = { ...NEWEST, items: [hidden, comment(5), comment(6)] };
    const merged = mergeFolded([OLDEST, head], [tail]);
    expect(merged.above.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(merged.below.map((item) => item.id)).toEqual([5, 6]);
    expect(merged.above.at(-1)).toMatchObject({
      body: "Comment 4",
      hidden_at: expect.any(String),
    });
  });
});

describe("shared all-comments drain", () => {
  it("includes the folded middle, respects has_more, and returns the flat result", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...OLDEST, has_more: true })
      .mockResolvedValueOnce({ ...MIDDLE, has_more: true })
      .mockResolvedValueOnce({ ...NEWEST, has_more: false });
    const projection = {
      kind: "timeline-all" as const,
      version: 1 as const,
      queryKey: ["timeline", "p", 19, "all"],
      queryHash: "all-comments",
      resources: [timelineAllResource("p", 19)],
    };
    const items = await executeProjection(projection, read);
    expect(items).toEqual([...OLDEST.items, ...MIDDLE.items, ...NEWEST.items]);
    expect(read.mock.calls.map(([resource]) => resource.query)).toEqual([
      { types: "comment,question_answered", limit: 100, after: undefined },
      { types: "comment,question_answered", limit: 100, after: "new-middle" },
      { types: "comment,question_answered", limit: 100, after: "new-tail" },
    ]);
  });

  it("drops a stalled page and stops on an empty page even with has_more", async () => {
    const stalled = vi.fn().mockResolvedValue({ ...OLDEST, has_more: true });
    expect(await drainTimelineComments(stalled)).toEqual(OLDEST.items);
    expect(stalled).toHaveBeenCalledTimes(2);
    const empty = vi
      .fn()
      .mockResolvedValue({ ...page([], "unexpected"), has_more: true });
    expect(await drainTimelineComments(empty)).toEqual([]);
    expect(empty).toHaveBeenCalledTimes(1);
  });
});
