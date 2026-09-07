import type { QueryClient } from "@tanstack/react-query";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import {
  admitsRow,
  type ChangeEvent,
  type CrossChangeEvent,
  CrossChangeEvent as CrossChangeEventSchema,
  filterIsDecidable,
  type InboxItem,
  type InboxRowState,
  type IssueListFilter,
  type IssueListItem,
  type IssueListRow,
  type MeEvent,
  MeEvent as MeEventSchema,
  SSE_CHANGE_EVENT,
  SSE_ME_EVENT,
  SSE_PING_EVENT,
} from "@todou/shared";
import { useEffect } from "react";
import { issueListDescriptorOf } from "@/api/issues-cache.ts";
import { api, clientOrigin } from "@/api/queries.ts";
import {
  electLeader,
  openTabChannel,
  type TabChannel,
  type TabMessage,
  tabSyncSupported,
} from "@/api/tab-sync.ts";

type QueryKeyLike = ReadonlyArray<unknown>;

/**
 * "refetch" re-fetches every active query under the key (the classic broad
 * invalidation). The two row-carrying scopes describe individual rows instead
 * and let each cache entry decide for itself whether it is affected.
 *
 * `inboxRows` compares the server's fingerprint of one inbox row against the
 * cached copy of that row (T-275). `issueRows` says what a change did to one
 * row of the project's lists (T-279), and every entry under `["issues",
 * slug]` answers it against the filter it declared in `meta.issueList`.
 *
 * What licenses skipping an entry is which properties of a row each kind of
 * event can move:
 *
 * | event | membership | sort key | rendered fields | verdict |
 * |---|---|---|---|---|
 * | `issue` with `list_row` | as stated | may move | may move | that kind |
 * | `issue` without it | unknown | unknown | unknown | broad refetch |
 * | `comment`, `timeline` | no | no | unread + question badges | `contains` |
 * | a read position (`me`) | no | no | unread badge | `read` |
 * | `status`, `label` | no | no | every row's chips | broad refetch |
 *
 * `comment` and `timeline` can be narrowed to the pages holding the row
 * because the entries that bump `updated_at` — comment, attachment, answered
 * question, spec push, spec review (T-101) — are each paired with an `issue`
 * event, whose own verdict covers the reordering; the unpaired ones
 * (`referenced`, a comment edit or delete) deliberately do not bump, so they
 * cannot reorder anything or move a row between columns.
 *
 * Both scopes carry a list rather than a single row because `coalesceBatch`
 * merges every one of them on a key into one — see there for why.
 */
export type InboxRowVerdict = {
  project: string;
  number: number;
  row: InboxRowState | null;
};

/** The `{kind:"fields"}` arm of `list_row`, which is the informative one. */
export type IssueFieldsRow = Extract<IssueListRow, { kind: "fields" }>;

/**
 * What one change did to one row of a project's lists. `contains` and `read`
 * are the two an event's pointer alone establishes; the other three are the
 * server's own answer, off `list_row`.
 */
export type IssueListVerdict =
  | { verdict: "contains"; number: number }
  | { verdict: "read"; number: number }
  | { verdict: "activity"; number: number }
  | { verdict: "fields"; number: number; row: IssueFieldsRow }
  | { verdict: "gone"; number: number };

export type InvalidationScope =
  | "refetch"
  | { inboxRows: InboxRowVerdict[] }
  | { issueRows: IssueListVerdict[] };
export type Invalidation = { key: QueryKeyLike; scope: InvalidationScope };

const refetch = (key: QueryKeyLike): Invalidation => ({
  key,
  scope: "refetch",
});

/** One verdict about one row, on the project's list key. */
const issueRow = (slug: string, verdict: IssueListVerdict): Invalidation => ({
  key: ["issues", slug],
  scope: { issueRows: [verdict] },
});

/**
 * The list-side reading of an `issue` event's `list_row`. An absent field is
 * a server that gave no answer, and the only safe reading of that is the
 * pre-T-279 one: refetch every list of the project.
 */
function issueListInvalidation(
  slug: string,
  number: number,
  row: IssueListRow | undefined,
): Invalidation {
  if (row === undefined) return refetch(["issues", slug]);
  if (row.kind === "fields") {
    return issueRow(slug, { verdict: "fields", number, row });
  }
  return issueRow(slug, { verdict: row.kind, number });
}

/**
 * Pointer event → invalidation descriptors. Exported pure for tests.
 * Events carry no data, so every mapping ends in a refetch through the
 * authorized API. The stream is user-level (T-122), so `slug` is the
 * event's own project — invalidating a project the user is not looking at
 * just marks its inactive queries stale for their next mount.
 */
export function invalidationsFor(
  event: ChangeEvent,
  slug: string,
): Invalidation[] {
  switch (event.entity) {
    case "issue":
      return event.issue_number === undefined
        ? [refetch(["issues", slug])]
        : [
            // Where the row landed is the one thing the pointer cannot say,
            // so the write path says it instead (T-279).
            issueListInvalidation(slug, event.issue_number, event.list_row),
            refetch(["issue", slug, event.issue_number]),
            refetch(["timeline", slug, event.issue_number]),
          ];
    case "comment":
    case "timeline":
      // Question components and their answers ride the timeline, so the
      // per-issue question status (T-19) goes stale with it — as do the
      // unread markers (T-46), which travel in the list payload. List
      // ordering is the paired issue event's job; see InvalidationScope.
      return event.issue_number === undefined
        ? []
        : [
            refetch(["timeline", slug, event.issue_number]),
            refetch(["questions", slug, event.issue_number]),
            issueRow(slug, {
              verdict: "contains",
              number: event.issue_number,
            }),
          ];
    case "attachment":
      return event.issue_number === undefined
        ? []
        : [
            refetch(["issue", slug, event.issue_number]),
            refetch(["timeline", slug, event.issue_number]),
            refetch(["attachments", slug, event.issue_number]),
          ];
    case "spec":
      // A push moves the "current" file set and the denormalized issue
      // columns (version / review status) that feed list badges. The lists
      // are deliberately absent: every spec write is paired with an `issue`
      // event, whose `activity` verdict refreshes exactly the pages showing
      // the badge (T-279).
      return event.issue_number === undefined
        ? []
        : [
            refetch(["spec", slug, event.issue_number]),
            refetch(["spec-files", slug, event.issue_number, "current"]),
            refetch(["issue", slug, event.issue_number]),
          ];
    case "status":
      return [refetch(["statuses", slug]), refetch(["issues", slug])];
    case "label":
      return [refetch(["labels", slug]), refetch(["issues", slug])];
    case "member":
      // A membership change can grant or revoke a whole project — the
      // user-level stream delivers your own member events even for projects
      // outside the visible set, so the switcher updates live (T-122).
      return [
        refetch(["members", slug]),
        refetch(["projects"]),
        refetch(["agent-memberships"]),
      ];
    case "project":
      return [refetch(["project", slug]), refetch(["projects"])];
  }
}

/**
 * The inbox badge (T-97) is user-scoped and cross-project. Since T-122 the
 * stream is too, so this covers every readable project — the 30s /activity
 * poll that bridged the not-in-view projects (T-112) is gone.
 *
 * Only entities that can move a row in or out: comments and timeline entries
 * (unread counts, questions), spec pushes and reviews (pending review), and
 * issue updates — closing one retires both pending reasons (T-111).
 *
 * Whether a given change concerns *this* reader is a question the payload
 * cannot answer — it is a pointer, with no actor and no state — so the
 * server answers it per receiver in `inbox_row` (T-275): the deciding
 * fields of the reader's own row for that issue. Comparing them against the
 * cached row leaves two branches, where the T-273 boolean needed three, and
 * makes a replayed event free: identical fields mean nothing to do.
 */
export function inboxInvalidations(event: CrossChangeEvent): Invalidation[] {
  switch (event.entity) {
    case "issue":
    case "comment":
    case "timeline":
    case "spec":
      break;
    default:
      return [];
  }
  // Absent means the server did not work it out — an older server, a
  // subscription that did not ask, a failed judgement, a flood — and the
  // only safe reading of "I don't know" is the pre-T-273 one.
  if (event.inbox_row === undefined || event.issue_number === undefined) {
    return [refetch(["inbox"])];
  }
  return [
    {
      key: ["inbox"],
      scope: {
        inboxRows: [
          {
            project: event.project,
            number: event.issue_number,
            row: event.inbox_row,
          },
        ],
      },
    },
  ];
}

/**
 * Pointer-free event about the reader's own account → invalidation
 * descriptors (T-275). Exported pure for tests.
 *
 * `["issues", …]` is in here because the unread markers travel in the list
 * payload (T-46), so a read position moves them as surely as it moves the
 * inbox.
 */
export function meInvalidations(event: MeEvent): Invalidation[] {
  switch (event.kind) {
    case "issue_read":
      return [
        {
          key: ["inbox"],
          scope: {
            inboxRows: [
              {
                project: event.project,
                number: event.issue_number,
                row: event.inbox_row,
              },
            ],
          },
        },
        // A mark-read always ends in "unread: false, unread_comments: 0" for
        // that row, so the event needs to carry neither: only the pages
        // still showing it lit have anything to refetch.
        issueRow(event.project, {
          verdict: "read",
          number: event.issue_number,
        }),
      ];
    case "reads_swept":
      return event.projects === undefined
        ? [refetch(["inbox"]), refetch(["issues"])]
        : [
            refetch(["inbox"]),
            ...event.projects.map((slug) => refetch(["issues", slug])),
          ];
    case "prefs":
      // show_weak_unread decides which rows /me/inbox returns at all.
      return [refetch(["inbox"]), refetch(["me-prefs"])];
  }
}

/**
 * Shape test for `contains`: an issue-list-like page holding the row.
 * The counts cache shares the ["issues", slug] prefix but has no items,
 * so it falls through to false and is only marked stale.
 */
export function pageContainsIssue(data: unknown, issueNumber: number): boolean {
  if (typeof data !== "object" || data === null) return false;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { number?: unknown }).number === issueNumber,
  );
}

/**
 * The cached inbox row for one issue, or undefined when this cache entry
 * does not hold it. Anything that is not a list of rows — the badge count,
 * an error state — reads as "does not hold it", so it is left alone.
 */
export function inboxRowIn(
  data: unknown,
  project: string,
  issueNumber: number,
): InboxItem | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  return items.find((item) => {
    if (typeof item !== "object" || item === null) return false;
    if ((item as { number?: unknown }).number !== issueNumber) return false;
    const itemProject = (item as { project?: unknown }).project;
    if (typeof itemProject !== "object" || itemProject === null) return false;
    return (itemProject as { slug?: unknown }).slug === project;
  }) as InboxItem | undefined;
}

/**
 * Does this cache entry disagree with the server about what the reader has
 * to attend to? True whenever the row arrives, leaves, or keeps any of the
 * unread / pending-review / open-question fields at a different value —
 * which is exactly the set the badge count and the row's markers are drawn
 * from, so a true here means a refetch.
 */
export function inboxAttentionDiffers(
  data: unknown,
  project: string,
  issueNumber: number,
  row: InboxRowState | null,
): boolean {
  const cached = inboxRowIn(data, project, issueNumber);
  if (row === null) return cached !== undefined;
  if (cached === undefined) return true;
  return (
    cached.unread !== row.unread ||
    cached.unread_comments !== row.unread_comments ||
    cached.pending_spec_review !== row.pending_spec_review ||
    cached.open_questions !== row.open_questions
  );
}

/**
 * Does this cache entry hold the row with the right attention fields but an
 * older `updated_at`? That means the title, status, labels or assignees may
 * have moved while the badge did not, which is worth marking stale and not
 * worth a request.
 */
export function inboxRowContentDiffers(
  data: unknown,
  project: string,
  issueNumber: number,
  row: InboxRowState | null,
): boolean {
  if (row === null) return false;
  if (inboxAttentionDiffers(data, project, issueNumber, row)) return false;
  const cached = inboxRowIn(data, project, issueNumber);
  if (cached === undefined) return false;
  return cached.updated_at !== row.updated_at;
}

/**
 * Is this cache entry the whole result set under its filter, rather than a
 * window onto it? Only then does "the row is not in here" mean "the row does
 * not match this filter".
 */
export function pageIsComplete(
  filter: IssueListFilter,
  data: unknown,
): boolean {
  if (filter.cursor !== undefined) return false;
  if (typeof data !== "object" || data === null) return false;
  return (data as { next_cursor?: unknown }).next_cursor === null;
}

/**
 * One row's set-valued fields as some cache entry of this project already has
 * them (T-279), for the dimensions a `fields` verdict left out. Any page under
 * the key will do: they are project-level facts, not per-page ones.
 *
 * The entry found may itself be stale — a hidden tab's cache marked stale by
 * an earlier event and not yet refetched. `admitsRow` can then judge on old
 * labels and skip a page it should not have; that page is already in the
 * invalidation queue from the event that marked it, so the reader still sees
 * the update on the way back.
 */
export function cachedIssueRow(
  queryClient: QueryClient,
  key: QueryKeyLike,
  issueNumber: number,
): IssueListItem | undefined {
  for (const [, data] of queryClient.getQueriesData({ queryKey: key })) {
    if (typeof data !== "object" || data === null) continue;
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    const found = items.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { number?: unknown }).number === issueNumber,
    );
    if (found !== undefined) return found as IssueListItem;
  }
  return undefined;
}

/**
 * The category of each status of one project, from the client's own
 * `statuses` cache — which every page rendering a status chip already holds,
 * so this costs no request. A status the cache does not know maps to
 * `undefined`, which `admitsRow` reads as "no telling".
 */
export function statusCategories(
  queryClient: QueryClient,
  slug: string,
): (statusId: number) => "open" | "closed" | undefined {
  const statuses = queryClient.getQueryData(["statuses", slug]);
  const byId = new Map<number, "open" | "closed">();
  if (Array.isArray(statuses)) {
    for (const status of statuses) {
      if (typeof status !== "object" || status === null) continue;
      const { id, category } = status as { id?: unknown; category?: unknown };
      if (typeof id !== "number") continue;
      if (category === "open" || category === "closed") byId.set(id, category);
    }
  }
  return (statusId) => byId.get(statusId);
}

/**
 * Does one verdict oblige this cache entry to refetch? The whole saving of
 * T-279 is the `false` returns; every uncertainty resolves to `true`, which
 * is the behaviour that existed before the verdicts did.
 */
export function entryWantsRefetch(
  verdict: IssueListVerdict,
  descriptor: ReturnType<typeof issueListDescriptorOf>,
  data: unknown,
  context: {
    cached: (issueNumber: number) => IssueListItem | undefined;
    categoryOf: (statusId: number) => "open" | "closed" | undefined;
  },
): boolean {
  // No declaration: a producer this build does not know about, so there is
  // nothing to judge against.
  if (descriptor === undefined) return true;
  const { filter } = descriptor;
  // `q` matches bodies and the trash sorts by deletion time; neither follows
  // from a row's fields.
  if (!filterIsDecidable(filter)) return true;
  const holds = pageContainsIssue(data, verdict.number);

  if (descriptor.kind === "counts") {
    switch (verdict.verdict) {
      // A count is drawn from membership alone: unread markers, question
      // badges and `updated_at` are not in it.
      case "contains":
      case "read":
      case "activity":
        return false;
      case "gone":
        return true;
      case "fields": {
        if (verdict.row.label_ids !== undefined) return true;
        if (verdict.row.assignee_ids !== undefined) return true;
        const before = context.cached(verdict.number);
        if (before === undefined) return true;
        return before.status.id !== verdict.row.status_id;
      }
    }
  }

  switch (verdict.verdict) {
    case "contains":
      return holds;
    case "read":
      return pageHasUnreadRow(data, verdict.number);
    case "gone":
      return holds;
    case "activity":
      // Membership is guaranteed unchanged, so a complete page that does not
      // hold the row proves the row does not match its filter. An incomplete
      // one has to ask: the row may have sat beyond the window and moved in
      // when `updated_at` bumped.
      return holds || !pageIsComplete(filter, data);
    case "fields": {
      if (holds) return true;
      const before = context.cached(verdict.number);
      return (
        admitsRow(
          filter,
          verdict.row,
          before === undefined
            ? undefined
            : {
                label_ids: before.labels.map((l) => l.id),
                assignee_ids: before.assignees.map((a) => a.id),
              },
          context.categoryOf,
        ) !== false
      );
    }
  }
}

/**
 * Shape test for the `read` verdict: an issue-list-like page whose copy of
 * the row still shows unread. The counts cache shares the ["issues", slug]
 * prefix but has no items, so it reads false.
 */
export function pageHasUnreadRow(data: unknown, issueNumber: number): boolean {
  if (typeof data !== "object" || data === null) return false;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (typeof item !== "object" || item === null) return false;
    if ((item as { number?: unknown }).number !== issueNumber) return false;
    const row = item as { unread?: unknown; unread_comments?: unknown };
    return (
      row.unread === true ||
      (typeof row.unread_comments === "number" && row.unread_comments > 0)
    );
  });
}

/**
 * `maxRefetch` is the strongest refetch this tab is willing to pay for
 * (T-276): `"none"` on a tab the reader cannot see, which marks the same
 * queries stale and leaves the request to react-query's focus refetch.
 * Only the strength is lowered, never a predicate skipped — a hidden tab
 * told "this card is not in your inbox and not in your cache" still does
 * nothing at all, which is the half T-273 won.
 */
export function applyInvalidation(
  queryClient: QueryClient,
  invalidation: Invalidation,
  maxRefetch: "active" | "none" = "active",
): void {
  const { key, scope } = invalidation;
  if (scope === "refetch") {
    // Visible, the call has to keep its exact former shape: `refetchType`
    // defaults to "active", so spelling it out is equivalent at runtime but
    // would break the 15 existing `toHaveBeenCalledWith({ queryKey })`
    // assertions. Left alone, the whole existing suite is the proof that
    // nothing changed for a visible tab.
    const gate = maxRefetch === "none" ? { refetchType: "none" as const } : {};
    queryClient.invalidateQueries({ queryKey: key, ...gate });
    return;
  }
  if ("inboxRows" in scope) {
    const verdicts = scope.inboxRows;
    const attention = (data: unknown) =>
      verdicts.some((v) =>
        inboxAttentionDiffers(data, v.project, v.number, v.row),
      );
    // Two passes, like `contains` below, but both of them carry a
    // predicate. There the first pass is a broad stale-marking one because
    // the row may have moved and every page is suspect. Here the server has
    // described the rows themselves, so the first pass marks only the caches
    // that hold them with the same attention fields and older content, and
    // caches that agree on everything are left as they are — which is what
    // makes a replayed event cost nothing.
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: "none",
      predicate: (query) =>
        !attention(query.state.data) &&
        verdicts.some((v) =>
          inboxRowContentDiffers(query.state.data, v.project, v.number, v.row),
        ),
    });
    queryClient.invalidateQueries({
      queryKey: key,
      refetchType: maxRefetch,
      predicate: (query) => attention(query.state.data),
    });
    return;
  }
  // One pass, and no broad stale-marking one beside it. The pass that used
  // to precede `contains` marked every page under the key stale on the
  // grounds that a row may have moved — but a `contains` verdict comes from
  // an event that cannot move one, and on a nine-column board that pass cost
  // nine refetches the moment the reader came back to the tab (T-279).
  const verdicts = scope.issueRows;
  const slug = typeof key[1] === "string" ? key[1] : "";
  const context = {
    cached: (issueNumber: number) =>
      cachedIssueRow(queryClient, key, issueNumber),
    categoryOf: statusCategories(queryClient, slug),
  };
  queryClient.invalidateQueries({
    queryKey: key,
    refetchType: maxRefetch,
    predicate: (query) => {
      const descriptor = issueListDescriptorOf(query.meta);
      return verdicts.some((verdict) =>
        entryWantsRefetch(verdict, descriptor, query.state.data, context),
      );
    },
  });
}

/**
 * One coalescing window's invalidations, reduced to what is worth applying.
 * Exported pure for tests.
 *
 * Three rules, in order:
 *
 * 1. A broad refetch on a key subsumes every narrower scope on it.
 * 2. Identical descriptors collapse into one.
 * 3. The list-carrying scopes on one key merge into a single descriptor.
 *
 * Rule 3 is what keeps a flood cheap. `invalidateQueries` defaults to
 * `cancelRefetch: true` — for good reason, since an in-flight response may
 * predate the event — so N descriptors that each match the same cache entry
 * abort and restart the same request N times. Merging asks the question once
 * with every verdict in hand: refetch if any of them moved the reader's
 * attention, and the one response that arrives is authoritative for all of
 * them. Measured on a 50-event burst in another project: 14 inbox requests
 * before merging, 1 after.
 *
 * That argument applies to the list key exactly as it does to the inbox, so
 * `issueRows` merges too (T-279): a flood over a nine-column board asks each
 * column once, whatever the burst's length.
 */
export function coalesceBatch(batch: Invalidation[]): Invalidation[] {
  const idOf = (key: QueryKeyLike) => JSON.stringify(key);
  const broad = new Set(
    batch.filter((inv) => inv.scope === "refetch").map((inv) => idOf(inv.key)),
  );

  const out: Invalidation[] = [];
  const seen = new Set<string>();
  const merged = new Map<string, Invalidation>();
  for (const inv of batch) {
    if (inv.scope !== "refetch" && broad.has(idOf(inv.key))) continue;
    const id = JSON.stringify([inv.key, inv.scope]);
    if (seen.has(id)) continue;
    seen.add(id);

    const scope = inv.scope;
    if (scope === "refetch") {
      out.push(inv);
      continue;
    }
    const kind = "inboxRows" in scope ? "inboxRows" : "issueRows";
    const mergeId = `${kind}:${idOf(inv.key)}`;
    const into = merged.get(mergeId);
    if (into === undefined) {
      // Copied, so merging never mutates a descriptor the caller still holds.
      merged.set(mergeId, {
        key: inv.key,
        scope:
          "inboxRows" in scope
            ? { inboxRows: [...scope.inboxRows] }
            : { issueRows: [...scope.issueRows] },
      });
      out.push(merged.get(mergeId) as Invalidation);
      continue;
    }
    const target = into.scope;
    if (
      "inboxRows" in scope &&
      typeof target === "object" &&
      "inboxRows" in target
    ) {
      target.inboxRows.push(...scope.inboxRows);
    } else if (
      "issueRows" in scope &&
      typeof target === "object" &&
      "issueRows" in target
    ) {
      target.issueRows.push(...scope.issueRows);
    }
  }
  return out;
}

/**
 * The queries whose response is decided by the key alone, for one account
 * (T-276): same key, same session, same body, whichever tab asked. So a tab
 * that just fetched one can hand the response to its siblings instead of
 * letting each of them ask — the cache still only ever holds an authoritative
 * full response, just delivered by another messenger.
 *
 * A page's own keys (`["issues", slug, search]`, `["timeline", …]`) are
 * decided by their key too but stay out: two tabs rarely sit on the same one,
 * so shipping those bodies around buys nothing.
 */
export const SHARED_QUERY_KEYS: QueryKeyLike[] = [
  ["inbox"],
  ["me-prefs"],
  ["projects"],
];

/**
 * Exact equality, not the prefix match `invalidateQueries` does: `["issues",
 * slug]` must not slip in under `["issues"]`. Also the check on the receiving
 * side — what arrives on the channel may not write an arbitrary key.
 */
export function isSharedKey(key: unknown): boolean {
  const id = JSON.stringify(key);
  return SHARED_QUERY_KEYS.some((shared) => JSON.stringify(shared) === id);
}

/**
 * Is a sibling's response newer than the moment this tab last learned that
 * key was stale? Only then may it be adopted.
 *
 * The interleaving this rejects: the other tab's refetch went out before this
 * tab saw the event, so its response cannot reflect it — adopting would clear
 * the stale mark and make the old data look current. Both tabs read the same
 * clock (`BroadcastChannel` spans one origin on one machine), so the
 * comparison is meaningful. Guessing wrong falls on the "do not adopt" side,
 * which costs one focus refetch, so layer 3 has no failure mode: it either
 * takes effect or does not.
 */
export function shouldAdopt(at: number, staleAt: number | undefined): boolean {
  return staleAt === undefined || at >= staleAt;
}

/**
 * Everything a reconnect might have missed. Slug-less prefixes on purpose:
 * the stream carries every readable project, so the gap does too.
 */
export function reconnectInvalidations(): QueryKeyLike[] {
  return [
    ["issues"],
    ["issue"],
    ["timeline"],
    ["questions"],
    ["attachments"],
    ["spec"],
    ["spec-files"],
    ["statuses"],
    ["labels"],
    ["members"],
    ["agent-memberships"],
    ["project"],
    ["projects"],
    ["inbox"],
    // A preference toggled on another device during the outage arrives
    // nowhere else: its `me` event was dropped with the connection.
    ["me-prefs"],
  ];
}

/**
 * The server heartbeats every 30s; three silent beats means the stream is
 * dead even if the browser still thinks it is open (a proxy can hold the
 * client side of a connection open long after the upstream died — vite's
 * dev proxy does exactly this).
 */
export const STALL_TIMEOUT_MS = 90_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Agents post runs of events in quick succession (a status change plus a
 * comment plus a reference, within a second); refetching per event would
 * fetch the same pages repeatedly. One trailing window batches them; a
 * broad "refetch" on a key subsumes any `contains` on the same key.
 */
export const INVALIDATE_COALESCE_MS = 300;

/**
 * Subscribes to the user-level SSE change feed for as long as the component
 * is mounted — one connection covers every readable project (T-122), so it
 * lives in the authed shell rather than a project layout. Reconnects are
 * driven from here rather than left to the browser: EventSource only retries
 * transport-level drops, and gives up permanently when a retry gets a
 * non-200 response — which is exactly what a reverse proxy answers (502)
 * while the server restarts. After any drop we run a full compensation
 * invalidate since events may have been missed.
 *
 * Since T-276 only one tab of an account connects: the others take the same
 * frames over a `BroadcastChannel` and run them through the same handlers.
 * The lock and the channel are named after the user id, so a tab that signed
 * in as somebody else neither inherits the previous identity's stream nor
 * talks to a sibling still holding that identity's cache.
 *
 * `userId` is absent for the shell's first paint: the header now renders
 * before `/api/me` answers (T-265), and until it does there is no telling
 * whether a session exists to stream — opening one regardless earns a visitor
 * without one a run of 401s and reconnects on the way to /login.
 */
export function useUserEvents(userId?: number) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (userId === undefined) return;
    let source: EventSource | null = null;
    let disposed = false;
    let dropped = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: Invalidation[] = [];
    let channel: TabChannel | undefined;
    let giveUpRole: (() => void) | undefined;
    let cleanupLifecycle: (() => void) | undefined;
    let parked = false;
    /** When this tab last learned a shared key was stale, by key hash. */
    const staleAt = new Map<string, number>();

    /**
     * `focusManager.isFocused()` rather than `document.visibilityState`,
     * because that is the very predicate deciding whether the focus refetch
     * this downgrade relies on will happen. One predicate for the downgrade
     * and for its safety net cannot disagree with itself; two separate reads
     * leave a query marked stale on a tab react-query does not consider to
     * have been refocused.
     */
    const gate = () => (focusManager.isFocused() ? "active" : "none");

    /**
     * Every path that marks a query stale on behalf of the feed, so the two
     * bookkeeping steps cannot come apart. The timestamp is what stops a
     * sibling's older response from being adopted over what we now know —
     * and a gap is exactly the moment when responses in flight predate it.
     * Recording it more eagerly than strictly needed only makes this tab
     * refuse a sibling and fall back to a focus refetch, the safe side.
     */
    const invalidate = (inv: Invalidation, maxRefetch: "active" | "none") => {
      if (isSharedKey(inv.key)) {
        staleAt.set(JSON.stringify(inv.key), Date.now());
      }
      applyInvalidation(queryClient, inv, maxRefetch);
    };

    const flush = () => {
      flushTimer = undefined;
      const batch = pending;
      pending = [];
      // Read once per flush rather than per frame: a burst is collected over
      // 300ms, and what counts is whether the reader can see the tab when it
      // lands. Coalescing first also means one window records at most one
      // timestamp per key.
      const maxRefetch = gate();
      for (const inv of coalesceBatch(batch)) {
        invalidate(inv, maxRefetch);
      }
    };

    const enqueue = (invalidations: Invalidation[]) => {
      pending.push(...invalidations);
      if (flushTimer === undefined) {
        flushTimer = setTimeout(flush, INVALIDATE_COALESCE_MS);
      }
    };

    /**
     * One SSE frame's worth of work, reached identically from this tab's own
     * connection and from a sibling's forwarded copy. Sharing the function
     * rather than the intent is what makes the order in the listeners below
     * structural: there is no second place where a frame could be handled
     * differently.
     */
    const onChangeFrame = (data: string) => {
      let event: CrossChangeEvent;
      try {
        event = CrossChangeEventSchema.parse(JSON.parse(data));
      } catch {
        return;
      }
      enqueue([
        ...invalidationsFor(event, event.project),
        ...inboxInvalidations(event),
      ]);
    };

    const onMeFrame = (data: string) => {
      let event: MeEvent;
      try {
        event = MeEventSchema.parse(JSON.parse(data));
      } catch {
        return;
      }
      // Our own write, echoed back. The mutation's onSettled already
      // invalidated locally, and MarkReadOnView re-sends its PUT about
      // every two seconds while a busy issue is open — responding to the
      // echo as well would repeat that work on the same cadence.
      if (event.origin === clientOrigin) return;
      enqueue(meInvalidations(event));
    };

    /**
     * Everything the stream may have missed while it was down. Runs through
     * `applyInvalidation` rather than invalidating directly so that a drop
     * cannot walk around the visibility gate.
     */
    const compensate = () => {
      const maxRefetch = gate();
      for (const key of reconnectInvalidations()) {
        invalidate({ key, scope: "refetch" }, maxRefetch);
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      dropped = true;
      source?.close();
      source = null;
      const backoff = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** attempts,
      );
      attempts += 1;
      // Jitter spreads the herd of tabs reconnecting after one restart.
      reconnectTimer = setTimeout(connect, backoff * (0.5 + Math.random() / 2));
    };

    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(scheduleReconnect, STALL_TIMEOUT_MS);
    };

    const connect = () => {
      reconnectTimer = undefined;
      if (disposed) return;
      const es = new EventSource(api.userEventsUrl({ inbox: true }));
      source = es;
      armStallTimer();

      // Forwarded before it is parsed, and the order is not interchangeable:
      // the `origin === clientOrigin` test inside `onMeFrame` speaks for
      // *this* tab only. Filtering first would mean the leader's own
      // mark-read never reaches any sibling — reopening precisely the hole
      // T-275 spent a section closing. Broadcast first, filter on each
      // receiving side, and both directions hold at once.
      es.addEventListener(SSE_CHANGE_EVENT, (e: MessageEvent) => {
        armStallTimer();
        channel?.post({ v: 1, frame: "change", data: e.data as string });
        onChangeFrame(e.data as string);
      });
      es.addEventListener(SSE_ME_EVENT, (e: MessageEvent) => {
        armStallTimer();
        channel?.post({ v: 1, frame: "me", data: e.data as string });
        onMeFrame(e.data as string);
      });
      es.addEventListener(SSE_PING_EVENT, armStallTimer);
      es.onopen = () => {
        attempts = 0;
        armStallTimer();
        if (dropped) {
          dropped = false;
          compensate();
          // Every tab missed the outage, not just this one, and an SSE frame
          // carries no id so nobody can say which events were lost. Giving
          // the stream event ids and a bounded replay would turn this into a
          // gap with a position; that is its own card, opened with T-275.
          channel?.post({ v: 1, frame: "gap" });
        }
      };
      es.onerror = () => {
        dropped = true;
        // CONNECTING means the browser is retrying on its own; CLOSED means
        // it has given up for good and the stream is ours to rebuild.
        if (es.readyState === EventSource.CLOSED) scheduleReconnect();
      };
    };

    /** Stops streaming without giving up anything else this tab is doing. */
    const stopStreaming = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearTimeout(stallTimer);
      stallTimer = undefined;
      source?.close();
      source = null;
    };

    /**
     * A response this tab just fetched, offered to its siblings.
     *
     * `manual !== true` is the whole guard against an echo: `setQueryData`
     * reaches the reducer as a success action carrying `manual: true`, a real
     * fetch does not. Without it, adopting a response would look like getting
     * one and the two tabs would broadcast at each other indefinitely.
     */
    const offerResponse = () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        if (event.action.type !== "success" || event.action.manual === true) {
          return;
        }
        if (!isSharedKey(event.query.queryKey)) return;
        channel?.post({
          v: 1,
          frame: "data",
          key: [...event.query.queryKey],
          data: event.query.state.data,
          at: event.query.state.dataUpdatedAt,
        });
      });

    const adopt = (msg: Extract<TabMessage, { frame: "data" }>) => {
      if (!isSharedKey(msg.key)) return;
      const hash = JSON.stringify(msg.key);
      if (!shouldAdopt(msg.at, staleAt.get(hash))) return;
      staleAt.delete(hash);
      // Carrying the source's timestamp is what makes `staleTime` count the
      // data's real age rather than the moment it arrived here; the success
      // reducer clears `isInvalidated` with it, so an adopted key needs no
      // focus refetch either.
      queryClient.setQueryData(msg.key, msg.data, { updatedAt: msg.at });
    };

    const takeRole = () =>
      electLeader(`todou:events:${userId}`, ({ promoted }) => {
        // Promotion means the previous leader died and this cache is warm but
        // has a hole in it, which is exactly what `dropped` already describes
        // — so the first `onopen` runs the existing compensate-and-announce
        // path instead of a second one built beside it.
        if (promoted) dropped = true;
        connect();
        return stopStreaming;
      });

    let unsubscribeCache: (() => void) | undefined;
    if (!tabSyncSupported()) {
      connect();
    } else {
      channel = openTabChannel(`todou:events:${userId}:ch`, (msg) => {
        if (msg.frame === "change") onChangeFrame(msg.data);
        else if (msg.frame === "me") onMeFrame(msg.data);
        else if (msg.frame === "gap") compensate();
        else adopt(msg);
      });
      unsubscribeCache = offerResponse();
      giveUpRole = takeRole();

      // A frozen leader keeps the lock without delivering anything, and a
      // page in the back/forward cache would hold every sibling hostage for
      // as long as it stays there. The browser announces both, so hand the
      // role over on the announcement — no heartbeat, no threshold, and
      // correct whether or not this browser freezes a lock-holding page.
      // A tab waiting in the queue is by definition not the frozen one.
      const park = () => {
        if (parked || disposed) return;
        parked = true;
        giveUpRole?.();
        giveUpRole = undefined;
      };
      const unpark = () => {
        if (!parked || disposed) return;
        parked = false;
        giveUpRole = takeRole();
      };
      const onPageHide = (e: PageTransitionEvent) => {
        if (e.persisted) park();
      };
      const onPageShow = (e: PageTransitionEvent) => {
        if (e.persisted) unpark();
      };
      document.addEventListener("freeze", park);
      document.addEventListener("resume", unpark);
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      cleanupLifecycle = () => {
        document.removeEventListener("freeze", park);
        document.removeEventListener("resume", unpark);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
      };
    }

    return () => {
      disposed = true;
      cleanupLifecycle?.();
      unsubscribeCache?.();
      giveUpRole?.();
      channel?.close();
      clearTimeout(flushTimer);
      pending = [];
      stopStreaming();
    };
  }, [queryClient, userId]);
}
