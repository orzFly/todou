import { describe, expect, it } from "vitest";
import {
  boardColumnRegion,
  extraPagesOf,
  isSameSnapshot,
  locateRegion,
  parseReturnView,
  RETURN_VIEW_VERSION,
  type ReturnView,
  regionOf,
  returnAccessibleName,
  returnLabelOf,
} from "../src/lib/return-view.ts";

const VIEWER = 7;

/** A snapshot as `useReturnView` writes one, before it reaches a history entry. */
function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: RETURN_VIEW_VERSION,
    userId: VIEWER,
    snapshotId: "s1",
    target: {
      kind: "list",
      slug: "todou",
      search: { q: "guard", status: "3,9" },
    },
    pages: [{ lane: "flat", extraPages: 2 }],
    scroll: [{ region: "window", x: 0, y: 900, candidates: [] }],
    ...over,
  };
}

describe("parseReturnView — the destination has to be entirely valid", () => {
  it("keeps every filter the list route models", () => {
    const view = parseReturnView(stored(), VIEWER);
    expect(view?.target).toEqual({
      kind: "list",
      slug: "todou",
      search: { q: "guard", status: "3,9" },
    });
  });

  it("drops a snapshot another account wrote", () => {
    expect(parseReturnView(stored(), VIEWER + 1)).toBeNull();
  });

  it("drops a snapshot from a format this build cannot read", () => {
    expect(
      parseReturnView(stored({ v: RETURN_VIEW_VERSION + 1 }), VIEWER),
    ).toBeNull();
  });

  it.each([
    [
      "an off-site address",
      { kind: "list", slug: "https://evil.example", search: {} },
    ],
    [
      "a protocol-relative one",
      { kind: "list", slug: "//evil.example", search: {} },
    ],
    ["a traversal", { kind: "list", slug: "../../admin", search: {} }],
    ["a detail page", { kind: "issue", slug: "todou", number: 407 }],
    [
      "a filter the route would reject",
      { kind: "list", slug: "todou", search: { status: "3;DROP" } },
    ],
    [
      "a user reference with a path in it",
      { kind: "user", ref: "a/b", search: {} },
    ],
  ])("refuses %s as a return target", (_case, target) => {
    expect(parseReturnView(stored({ target }), VIEWER)).toBeNull();
  });

  it("accepts each collection the entry matrix names", () => {
    const targets = [
      { kind: "list", slug: "todou", search: { deleted: 1 } },
      { kind: "board", slug: "todou" },
      {
        kind: "search",
        slug: "todou",
        search: { q: "is:spec guard", in: "specs" },
      },
      { kind: "inbox" },
      { kind: "user", ref: "alice", search: { role: "assignee" } },
    ];
    for (const target of targets) {
      expect(parseReturnView(stored({ target }), VIEWER)?.target).toEqual(
        target,
      );
    }
  });

  it("refuses an inbox tab that is not a tab", () => {
    expect(parseReturnView(stored({ tab: "drafts" }), VIEWER)).toBeNull();
  });
});

describe("parseReturnView — a broken position costs only the position", () => {
  it("keeps the filters when the remembered scroll is nonsense", () => {
    const view = parseReturnView(
      stored({
        scroll: [{ region: "window", x: 0, y: Number.NaN, candidates: [] }],
      }),
      VIEWER,
    );
    expect(view?.target).toEqual({
      kind: "list",
      slug: "todou",
      search: { q: "guard", status: "3,9" },
    });
    expect(view?.scroll).toEqual([]);
    // The page range is a different field and survives its neighbour's loss.
    expect(extraPagesOf(view as ReturnView, "flat")).toBe(2);
  });

  it("keeps the regions that are intact beside the one that is not", () => {
    const view = parseReturnView(
      stored({
        scroll: [
          { region: "window", x: 0, y: 40, candidates: [] },
          { region: "status:3", x: 0, y: "far", candidates: [] },
          { region: "status:9", x: 0, y: 120, candidates: [] },
        ],
      }),
      VIEWER,
    );
    expect(view?.scroll.map((region) => region.region)).toEqual([
      "window",
      "status:9",
    ]);
  });

  it("keeps the filters when a page count is negative", () => {
    const view = parseReturnView(
      stored({ pages: [{ lane: "flat", extraPages: -3 }] }),
      VIEWER,
    );
    expect(view?.target.kind).toBe("list");
    // Nothing to replay rather than a replay that never terminates.
    expect(extraPagesOf(view as ReturnView, "flat")).toBe(0);
  });

  it("treats a missing position as no position rather than as a broken snapshot", () => {
    const view = parseReturnView(
      stored({ scroll: undefined, pages: undefined }),
      VIEWER,
    );
    expect(view?.target.kind).toBe("list");
    expect(view?.scroll).toEqual([]);
    expect(view?.pages).toEqual([]);
  });
});

describe("parseReturnView — the result is the reader's own copy", () => {
  it("does not follow a later change to the object it was read from", () => {
    const raw = stored();
    const view = parseReturnView(raw, VIEWER);
    (raw.target as { slug: string }).slug = "somewhere-else";
    (raw.pages as { extraPages: number }[])[0].extraPages = 99;
    expect(view?.target).toMatchObject({ slug: "todou" });
    expect(extraPagesOf(view as ReturnView, "flat")).toBe(2);
  });
});

describe("locateRegion", () => {
  // Distinct numbers throughout: an implementation that restored the FIRST
  // candidate's offset to whichever row it found would pass with equal ones.
  const remembered = {
    y: 4000,
    candidates: [
      { id: "a", offset: 12 },
      { id: "b", offset: 158 },
      { id: "c", offset: 301 },
    ],
  };

  it("puts the anchor row back where the reader had it", () => {
    const at = locateRegion(
      remembered,
      (id) => (id === "a" ? 2400 : undefined),
      9000,
    );
    expect(at).toBe(2400 - 12);
  });

  it("falls to the next surviving row, at that row's own offset", () => {
    // `b` sat 158px below the visible edge, not 12: restoring it to the first
    // candidate's offset would land 146px out.
    const at = locateRegion(
      remembered,
      (id) => (id === "b" ? 2570 : id === "c" ? 2713 : undefined),
      9000,
    );
    expect(at).toBe(2570 - 158);
  });

  it("uses the remembered pixel when every row it knew is gone", () => {
    expect(locateRegion(remembered, () => undefined, 9000)).toBe(4000);
  });

  it("clamps that pixel into a list that has since got shorter", () => {
    expect(locateRegion(remembered, () => undefined, 1500)).toBe(1500);
  });

  it("goes to the top when there is nothing left to scroll", () => {
    expect(locateRegion(remembered, () => undefined, 0)).toBe(0);
  });

  it("never scrolls backwards past the start", () => {
    // A row now higher than its remembered offset would otherwise ask for a
    // negative scroll, which the platform reads as 0 anyway — but only after
    // a frame of the page jumping.
    expect(
      locateRegion(remembered, (id) => (id === "a" ? 4 : undefined), 9000),
    ).toBe(0);
  });

  it("clamps an anchor that has moved beyond the current end", () => {
    expect(
      locateRegion(remembered, (id) => (id === "a" ? 8000 : undefined), 1200),
    ).toBe(1200);
  });
});

describe("what the control says", () => {
  it("calls the trash the Trash and the list Issues", () => {
    expect(returnLabelOf({ kind: "list", slug: "todou", search: {} })).toBe(
      "Issues",
    );
    expect(
      returnLabelOf({ kind: "list", slug: "todou", search: { deleted: 1 } }),
    ).toBe("Trash");
  });

  it.each([
    [{ kind: "board", slug: "todou" } as const, "Board"],
    [{ kind: "search", slug: "todou", search: {} } as const, "Search"],
    [{ kind: "inbox" } as const, "Inbox"],
    [{ kind: "user", ref: "alice", search: {} } as const, "User"],
  ])("labels %o as %s", (target, label) => {
    expect(returnLabelOf(target)).toBe(label);
  });

  it("names the person a user page is about, since 'User' does not", () => {
    const target = { kind: "user", ref: "alice", search: {} } as const;
    expect(returnAccessibleName({ target, userLabel: "alice" })).toBe(
      "Back to alice",
    );
    expect(returnAccessibleName({ target })).toBe("Back to User");
  });

  it("says where, not what, everywhere else", () => {
    expect(
      returnAccessibleName({ target: { kind: "board", slug: "todou" } }),
    ).toBe("Back to Board");
  });
});

describe("lookups", () => {
  const view = parseReturnView(
    stored({
      pages: [
        { lane: "status:3", extraPages: 1 },
        { lane: "status:9", extraPages: 4 },
      ],
      scroll: [{ region: boardColumnRegion(9), x: 0, y: 220, candidates: [] }],
    }),
    VIEWER,
  ) as ReturnView;

  it("keeps two groups read to different depths apart", () => {
    expect(extraPagesOf(view, "status:3")).toBe(1);
    expect(extraPagesOf(view, "status:9")).toBe(4);
  });

  it("reports nothing owed for a group the snapshot never saw", () => {
    expect(extraPagesOf(view, "status:44")).toBe(0);
  });

  it("finds a board column by its status id", () => {
    expect(regionOf(view, "status:9")?.y).toBe(220);
    expect(regionOf(view, "status:3")).toBeUndefined();
  });

  it("tells two captures apart by their id, never by their contents", () => {
    const a = parseReturnView(
      stored({ snapshotId: "s1" }),
      VIEWER,
    ) as ReturnView;
    const b = parseReturnView(
      stored({ snapshotId: "s1", scroll: [] }),
      VIEWER,
    ) as ReturnView;
    const c = parseReturnView(
      stored({ snapshotId: "s2" }),
      VIEWER,
    ) as ReturnView;
    expect(isSameSnapshot(a, b)).toBe(true);
    expect(isSameSnapshot(a, c)).toBe(false);
    expect(isSameSnapshot(a, undefined)).toBe(false);
  });
});
