import { UserIssueRole, UserIssueState } from "@todou/shared";
import { z } from "zod";
import { issueSearchSchema } from "@/api/issues.ts";
import { searchPageSchema } from "@/api/search.ts";

/**
 * What a detail page remembers about the collection the reader came from, so
 * its back link returns to that page rather than to a guess (T-407).
 *
 * Everything here is *data written into a browser history entry*, which makes
 * it hostile input on the way back in: a reader can edit it in devtools, it
 * survives a deploy that changed this file's shape, and it outlives the
 * account that wrote it. So the schemas below are the trust boundary, not a
 * formality — see `parseReturnView` for the two tiers of degradation they
 * exist to draw.
 */

/**
 * Bumped whenever a stored shape stops being readable by this file. An entry
 * from another version is discarded whole: the reader loses a back target
 * they never asked for, which is the cheap half of the trade.
 */
export const RETURN_VIEW_VERSION = 1;

/**
 * The tabs the inbox offers, in display order. A snapshot also carries the
 * selected tab so a detail page can build its return URL.
 */
export const INBOX_TABS = [
  "all",
  "mentions",
  "comments",
  "specs",
  "questions",
] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/**
 * A slug or a user reference, as narrow as the routes that accept them. The
 * point is not tidiness: a target is turned back into a link, and a value
 * that may hold `/`, `:` or `.` is a value that can name somewhere other than
 * this app.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USER_REF = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Where a back link goes, spelled as route + params + search rather than as
 * an href. A structured target is what makes "only in-app collection pages"
 * true by construction: there is no field in this union an off-site address,
 * a protocol-relative one, or a nested detail page could be written into.
 */
export const returnTargetSchema = z.discriminatedUnion("kind", [
  // The trash is a mode of the list route, not a route of its own, so it is
  // this target with `deleted` set — one target, one place the destination
  // is built. `returnLabelOf` is where the two part company.
  z.object({
    kind: z.literal("list"),
    slug: z.string().regex(SLUG),
    search: issueSearchSchema,
  }),
  z.object({ kind: z.literal("board"), slug: z.string().regex(SLUG) }),
  z.object({
    kind: z.literal("search"),
    slug: z.string().regex(SLUG),
    search: searchPageSchema,
  }),
  z.object({ kind: z.literal("inbox") }),
  z.object({
    kind: z.literal("user"),
    ref: z.string().regex(USER_REF),
    search: z.object({
      role: UserIssueRole.optional(),
      state: UserIssueState.optional(),
    }),
  }),
]);
export type ReturnTarget = z.infer<typeof returnTargetSchema>;

/** The scrolling region a page's own window scroll is remembered under. */
export const WINDOW_REGION = "window";
/** The board's horizontal canvas. */
export const BOARD_CANVAS_REGION = "board-canvas";
/** One board column's own vertical scroll, named by the status it shows. */
export const boardColumnRegion = (statusId: number): string =>
  `status:${statusId}`;

/**
 * One row that was visible when the region was captured, with the distance
 * from the region's visible top to its own top.
 *
 * Each candidate carries *its own* offset rather than a shared one: after a
 * row above it is deleted, the surviving rows have all moved, and restoring
 * the second candidate to the first one's offset would land the page a row
 * out. `id` is a stable identity (an issue id, a hit key) — never a DOM index
 * and never an issue number, both of which a move rewrites.
 */
const scrollCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  offset: z.number().finite(),
});
export type ScrollCandidate = z.infer<typeof scrollCandidateSchema>;

const scrollRegionSchema = z.object({
  region: z.string().min(1).max(64),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  candidates: z.array(scrollCandidateSchema).max(50),
});
export type ScrollRegion = z.infer<typeof scrollRegionSchema>;

/**
 * How far one pagination lane had been read. `extraPages` counts pages
 * committed *beyond* the first, which is what the page holds in state and
 * therefore the only number that can be restored by replaying; the first page
 * is the query's own and always arrives.
 *
 * Lanes are `flat` for an ungrouped list and `status:<id>` per group, so two
 * groups read to different depths come back to different depths.
 */
const pagedRangeSchema = z.object({
  lane: z.string().min(1).max(64),
  extraPages: z.number().int().min(0).max(200),
});
export type PagedRange = z.infer<typeof pagedRangeSchema>;

/**
 * Identity and destination: the half of a snapshot that has to be entirely
 * valid for the snapshot to mean anything.
 */
const returnViewIdentitySchema = z.object({
  v: z.literal(RETURN_VIEW_VERSION),
  /**
   * Whose browsing this describes. A history entry outlives a logout, and the
   * next account must not inherit the previous one's filters — let alone a
   * user page naming somebody they cannot see.
   */
  userId: z.number().int().positive(),
  /**
   * Identifies this frozen capture. Deliberately ours rather than the
   * router's history key: `history.replace` mints a new key every time
   * (`@tanstack/history`, `assignKeyAndIndex`), and this app replaces the
   * current entry on every debounced filter change.
   */
  snapshotId: z.string().min(1).max(64),
  target: returnTargetSchema,
  /** Inbox tab for the return URL; retained for pre-URL snapshots (T-397). */
  tab: z.enum(INBOX_TABS).optional(),
  /** Who a user-page target names, for the back link's accessible name. */
  userLabel: z.string().min(1).max(200).optional(),
});

export type ReturnView = z.infer<typeof returnViewIdentitySchema> & {
  pages: PagedRange[];
  scroll: ScrollRegion[];
};

/**
 * One scrolling region a collection page owns, and how to find the rows in
 * it. Declared by whichever component actually holds the element — a board
 * column registers its own, because nothing above it has the reference.
 */
export type ScrollArea = {
  region: string;
  /** The scrolling element, or `null` for the window. */
  element: () => HTMLElement | null;
  /** The rows now in this region, in display order, each stably identified. */
  rows: () => { id: string; element: HTMLElement }[];
  /**
   * How much of this region's leading edge fixed chrome covers, so the anchor
   * is the first row the reader can actually see rather than the first one
   * behind the sticky header.
   */
  inset?: () => number;
  /** Which axis the anchors describe. The board's canvas is the `x` one. */
  axis?: "x" | "y";
};

/** One pagination lane, as deep as it has been read and how to go deeper. */
export type ReturnLane = {
  lane: string;
  /** Pages committed beyond the first. */
  loaded: number;
  /** Whether another page can be asked for at this moment. */
  canLoadMore: boolean;
  /**
   * There is no further page: the cursor chain has ended. Distinct from
   * `canLoadMore` being false, which also covers a request in flight and a
   * page that failed — a replay must wait for those and give up on this one,
   * and one flag cannot say both.
   */
  exhausted: boolean;
  loadMore: () => void;
};

/** A restore that has not finished: what is still owed, and whether it may still move the page. */
export type PendingRestore = {
  view: ReturnView;
  /**
   * Cleared the moment the reader scrolls for themselves. The remaining pages
   * still load — they asked for those by having read that far — but nothing
   * yanks the viewport out from under them afterwards.
   */
  locate: boolean;
};

function parseEach<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  const kept: T[] = [];
  for (const entry of value) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  return kept;
}

/**
 * Read a snapshot back out of a history entry, for this viewer.
 *
 * Two tiers, and the difference is the whole point of not parsing this in one
 * `safeParse`. An unreadable *destination* — wrong version, another account,
 * a target that is not an in-app collection — discards the snapshot, and the
 * caller falls back to the project's default list. A corrupt *position* or
 * *page count* discards only that field: the reader still lands on the right
 * page with the right filters, one restored capability short. Collapsing the
 * two would throw away a perfectly good set of filters because one remembered
 * scroll offset came back as `NaN`.
 */
export function parseReturnView(
  value: unknown,
  viewerId: number,
): ReturnView | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const identity = returnViewIdentitySchema.safeParse(raw);
  if (!identity.success) return null;
  if (identity.data.userId !== viewerId) return null;
  return {
    ...identity.data,
    pages: parseEach(pagedRangeSchema, raw.pages),
    scroll: parseEach(scrollRegionSchema, raw.scroll),
  };
}

/** The word on the back link, per the entry matrix on T-407. */
export function returnLabelOf(target: ReturnTarget): string {
  switch (target.kind) {
    case "list":
      return target.search.deleted === undefined ? "Issues" : "Trash";
    case "board":
      return "Board";
    case "search":
      return "Search";
    case "inbox":
      return "Inbox";
    case "user":
      return "User";
  }
}

/**
 * The accessible name, which says where rather than what: "Back to Issues".
 * A user page names the person, because "Back to User" is the one label on
 * the list that does not identify its destination.
 */
export function returnAccessibleName(view: {
  target: ReturnTarget;
  userLabel?: string;
}): string {
  if (view.target.kind === "user" && view.userLabel !== undefined) {
    return `Back to ${view.userLabel}`;
  }
  return `Back to ${returnLabelOf(view.target)}`;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(max, 0));
}

/**
 * Where one region should be scrolled to, now that the page has been rebuilt.
 *
 * Anchors beat pixels because the data moves: a card closed since the capture
 * leaves every row below it one row higher, and the remembered pixel would
 * land the reader somewhere they never were. The first candidate that still
 * exists wins and is restored to *its own* captured offset; with none left,
 * the remembered pixel is clamped into whatever range the page now has, which
 * for an emptied list is 0.
 *
 * `positionOf` answers with a candidate's current distance from the region's
 * scroll origin, or `undefined` when that row is gone.
 */
export function locateRegion(
  remembered: Pick<ScrollRegion, "y" | "candidates">,
  positionOf: (id: string) => number | undefined,
  maxScroll: number,
): number {
  for (const candidate of remembered.candidates) {
    const at = positionOf(candidate.id);
    if (at !== undefined) return clamp(at - candidate.offset, maxScroll);
  }
  return clamp(remembered.y, maxScroll);
}

/** How deep one lane had been read, or 0 when the snapshot never knew. */
export function extraPagesOf(view: ReturnView, lane: string): number {
  return view.pages.find((p) => p.lane === lane)?.extraPages ?? 0;
}

/** One region's remembered state, or `undefined` when it was never captured. */
export function regionOf(
  view: ReturnView,
  region: string,
): ScrollRegion | undefined {
  return view.scroll.find((s) => s.region === region);
}

/**
 * Whether two snapshots describe the same capture. Compared by `snapshotId`
 * alone: a collection entry keeps updating its own view while the frozen copy
 * a detail page carries must not follow, so equal contents prove nothing and
 * unequal contents mean nothing either.
 */
export function isSameSnapshot(
  a: ReturnView | undefined,
  b: ReturnView | undefined,
): boolean {
  return a !== undefined && b !== undefined && a.snapshotId === b.snapshotId;
}
