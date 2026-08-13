import type {
  ActivityPage,
  ActivityQuery,
  IssueEventType,
  TimelineItem,
  TimelinePage,
  TimelineQuery,
  UserRef,
} from "@todou/shared";
import { TimelineFilterType } from "@todou/shared";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import { getUserRefs } from "./users.ts";

/**
 * Timeline ordering is the tuple (created_at, kind, id) with comments
 * ranked before events at equal timestamps. Cursors encode that tuple and
 * are opaque to clients.
 *
 * `t` carries the full microsecond precision postgres stores — the driver's
 * Date objects truncate to milliseconds, which made a sub-millisecond
 * boundary row compare strictly after its own cursor, so forward drains
 * re-returned it forever and `before=` skipped its millisecond-mates.
 * Cursors minted before that fix (agents persist them across restarts) are
 * still honored: see `beyond`.
 */
type Cursor = { t: string; k: 0 | 1; i: number };

const KIND_COMMENT = 0 as const;
const KIND_EVENT = 1 as const;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString(),
    ) as Cursor;
    if (
      typeof parsed.t !== "string" ||
      Number.isNaN(Date.parse(parsed.t)) ||
      typeof parsed.i !== "number" ||
      (parsed.k !== KIND_COMMENT && parsed.k !== KIND_EVENT)
    ) {
      throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    throw new ValidationFailedError("malformed cursor");
  }
}

/**
 * `created_at` rendered at postgres's full microsecond precision. The
 * driver's Dates only hold milliseconds, so cursors and the merge order are
 * built from this text form instead (fixed-width, so lexicographic order is
 * chronological).
 */
export function microIso(createdAt: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Comma-separated `types` filter → validated set (null = no filter). */
function parseTypes(raw: string | undefined): Set<TimelineFilterType> | null {
  if (raw === undefined || raw === "") return null;
  const set = new Set<TimelineFilterType>();
  for (const part of raw.split(",")) {
    const parsed = TimelineFilterType.safeParse(part.trim());
    if (!parsed.success) {
      throw new ValidationFailedError(
        `unknown timeline type "${part.trim()}" (expected one of: ${TimelineFilterType.options.join(", ")})`,
      );
    }
    set.add(parsed.data);
  }
  return set;
}

type Raw =
  | { kind: 0; row: typeof comments.$inferSelect; ts: string }
  | { kind: 1; row: typeof issueEvents.$inferSelect; ts: string };

async function actorRefs(
  ctx: AppContext,
  merged: Raw[],
): Promise<Map<number, UserRef>> {
  const actorIds = merged.map((m) =>
    m.kind === KIND_COMMENT ? m.row.authorId : m.row.actorId,
  );
  return getUserRefs(ctx.router.system(), actorIds);
}

const ghost = (id: number): UserRef => ({
  id,
  login: "ghost",
  display_name: "Deleted user",
  kind: "human",
  avatar_url: null,
  owner: null,
});

function toItem(m: Raw, refs: Map<number, UserRef>): TimelineItem {
  return m.kind === KIND_COMMENT
    ? {
        type: "comment",
        id: m.row.id,
        author: refs.get(m.row.authorId) ?? ghost(m.row.authorId),
        body: m.row.body,
        component: m.row.component ?? null,
        created_at: m.row.createdAt.toISOString(),
        edited_at: m.row.editedAt?.toISOString() ?? null,
        resolved_at: m.row.resolvedAt?.toISOString() ?? null,
        agent_context: m.row.agentContext ?? null,
      }
    : {
        type: "event",
        id: m.row.id,
        event_type: m.row.type,
        actor: refs.get(m.row.actorId) ?? ghost(m.row.actorId),
        payload: m.row.payload as Record<string, unknown>,
        created_at: m.row.createdAt.toISOString(),
        agent_context: m.row.agentContext ?? null,
      };
}

/** The parsed `types`/`exclude_actor` filters as per-table SQL conditions. */
function filterConditions(query: { types?: string; exclude_actor?: number }): {
  wantComments: boolean;
  wantEvents: boolean;
  commentConditions: SQL[];
  eventConditions: SQL[];
} {
  const typeFilter = parseTypes(query.types);
  const wantComments = typeFilter === null || typeFilter.has("comment");
  const eventTypes =
    typeFilter === null
      ? null
      : ([...typeFilter].filter((t) => t !== "comment") as IssueEventType[]);
  const commentConditions: SQL[] = [];
  const eventConditions: SQL[] = [];
  if (eventTypes !== null && eventTypes.length > 0) {
    eventConditions.push(inArray(issueEvents.type, eventTypes));
  }
  if (query.exclude_actor !== undefined) {
    commentConditions.push(ne(comments.authorId, query.exclude_actor));
    eventConditions.push(ne(issueEvents.actorId, query.exclude_actor));
  }
  return {
    wantComments,
    wantEvents: eventTypes === null || eventTypes.length > 0,
    commentConditions,
    eventConditions,
  };
}

function cursorOf(item: Raw): Cursor {
  return {
    t: item.ts,
    k: item.kind,
    i: item.row.id,
  };
}

function compareRaw(a: Raw, b: Raw): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.kind !== b.kind) return a.kind - b.kind;
  return a.row.id - b.row.id;
}

/**
 * Per-table cursor predicate. `forward` means "strictly after the cursor
 * in timeline order"; backward is the mirror image.
 *
 * Cursor timestamps come in two precisions: microseconds from current
 * servers, milliseconds from servers before the #69 fix (and from any
 * PGlite-era cursor an agent still has persisted). A millisecond `t`
 * cannot order rows inside its own millisecond, so for those cursors the
 * whole [t, t+1ms) window counts as "equal timestamp" and the (kind, id)
 * tie-break decides — the same rule the old encoding applied at equal
 * timestamps, extended to the sub-millisecond digits it could not see.
 */
function beyond(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  tableKind: 0 | 1,
  cursor: Cursor,
  forward: boolean,
) {
  const exact = /\.\d{4,}/.test(cursor.t);
  const from = sql`${cursor.t}::timestamptz`;
  const to = exact
    ? from
    : sql`${new Date(Date.parse(cursor.t) + 1).toISOString()}::timestamptz`;
  const strict = forward
    ? exact
      ? gt(createdAt, from)
      : gte(createdAt, to)
    : lt(createdAt, from);
  const equal = exact
    ? eq(createdAt, from)
    : and(gte(createdAt, from), lt(createdAt, to));

  const conditions: SQL[] = [strict];
  if (tableKind === cursor.k) {
    const cmp = forward ? gt : lt;
    const tie = and(equal, cmp(id, cursor.i));
    if (tie) conditions.push(tie);
  } else {
    const kindAfter = forward ? tableKind > cursor.k : tableKind < cursor.k;
    if (kindAfter && equal) conditions.push(equal);
  }
  return or(...conditions);
}

export async function getTimeline(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  query: TimelineQuery,
): Promise<TimelinePage> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

  // Directions: `after` walks forward, `before` walks backward, `last`
  // takes the newest page. Default (no cursor) reads from the beginning.
  const backward = query.before !== undefined || query.last;
  const cursorRaw = query.before ?? query.after;
  const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw);
  const forward = !backward;

  // Filters narrow each table's query; a filtered-out table is skipped
  // entirely. Cursors still order the merged stream, so a poll that matches
  // nothing simply returns an empty page and the caller keeps its cursor.
  const { wantComments, wantEvents, commentConditions, eventConditions } =
    filterConditions(query);
  commentConditions.push(eq(comments.issueId, issue.id));
  eventConditions.push(eq(issueEvents.issueId, issue.id));

  // Counted before the cursor predicates join the condition arrays:
  // total_count spans the whole filtered timeline, not the cursor window.
  const [commentTotal, eventTotal] = [
    wantComments
      ? await db
          .select({ n: count() })
          .from(comments)
          .where(and(...commentConditions))
      : [{ n: 0 }],
    wantEvents
      ? await db
          .select({ n: count() })
          .from(issueEvents)
          .where(and(...eventConditions))
      : [{ n: 0 }],
  ];
  const total_count = (commentTotal[0]?.n ?? 0) + (eventTotal[0]?.n ?? 0);

  if (cursor) {
    const c1 = beyond(
      comments.createdAt,
      comments.id,
      KIND_COMMENT,
      cursor,
      forward,
    );
    const c2 = beyond(
      issueEvents.createdAt,
      issueEvents.id,
      KIND_EVENT,
      cursor,
      forward,
    );
    if (c1) commentConditions.push(c1);
    if (c2) eventConditions.push(c2);
  }

  const fetch = query.limit + 1;
  const commentOrder = backward
    ? [desc(comments.createdAt), desc(comments.id)]
    : [asc(comments.createdAt), asc(comments.id)];
  const eventOrder = backward
    ? [desc(issueEvents.createdAt), desc(issueEvents.id)]
    : [asc(issueEvents.createdAt), asc(issueEvents.id)];

  const [commentRows, eventRows] = [
    wantComments
      ? await db
          .select({ row: comments, ts: microIso(comments.createdAt) })
          .from(comments)
          .where(and(...commentConditions))
          .orderBy(...commentOrder)
          .limit(fetch)
      : [],
    wantEvents
      ? await db
          .select({ row: issueEvents, ts: microIso(issueEvents.createdAt) })
          .from(issueEvents)
          .where(and(...eventConditions))
          .orderBy(...eventOrder)
          .limit(fetch)
      : [],
  ];

  let merged: Raw[] = [
    ...commentRows.map(
      (r) => ({ kind: KIND_COMMENT, row: r.row, ts: r.ts }) as Raw,
    ),
    ...eventRows.map(
      (r) => ({ kind: KIND_EVENT, row: r.row, ts: r.ts }) as Raw,
    ),
  ].sort(compareRaw);

  let hasMore: boolean;
  if (backward) {
    hasMore = merged.length > query.limit;
    merged = merged.slice(-query.limit);
  } else {
    hasMore = merged.length > query.limit;
    merged = merged.slice(0, query.limit);
  }

  const refs = await actorRefs(ctx, merged);
  const items: TimelineItem[] = merged.map((m) => toItem(m, refs));

  const first = merged[0];
  const last = merged.at(-1);
  // prev_cursor → pass as `before=` for older items (null when the start of
  // the timeline is known to be reached). next_cursor → pass as `after=`
  // for newer items (always present when the page is non-empty, so clients
  // can poll forward after SSE notifications).
  const atBeginning = backward ? !hasMore : cursor === null;
  const prev_cursor =
    first && !atBeginning ? encodeCursor(cursorOf(first)) : null;
  const next_cursor = last ? encodeCursor(cursorOf(last)) : null;

  return { items, prev_cursor, next_cursor, total_count };
}

/**
 * Project-wide activity stream: the same merged comments × events order as
 * the issue timeline, but across every issue, each entry annotated with its
 * issue number. Forward-only — `after` polls onward, `last` bootstraps a
 * "now" cursor. Cursors are interchangeable with issue-timeline cursors
 * (both encode a project-wide (created_at, kind, id) position).
 */
export async function getProjectActivity(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: ActivityQuery,
): Promise<ActivityPage> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const backward = query.last;
  const cursor = query.after === undefined ? null : decodeCursor(query.after);
  const forward = !backward;

  const { wantComments, wantEvents, commentConditions, eventConditions } =
    filterConditions(query);
  commentConditions.push(eq(comments.projectId, project.id));
  eventConditions.push(eq(issueEvents.projectId, project.id));
  if (cursor) {
    const c1 = beyond(
      comments.createdAt,
      comments.id,
      KIND_COMMENT,
      cursor,
      forward,
    );
    const c2 = beyond(
      issueEvents.createdAt,
      issueEvents.id,
      KIND_EVENT,
      cursor,
      forward,
    );
    if (c1) commentConditions.push(c1);
    if (c2) eventConditions.push(c2);
  }

  const fetch = query.limit + 1;
  const commentOrder = backward
    ? [desc(comments.createdAt), desc(comments.id)]
    : [asc(comments.createdAt), asc(comments.id)];
  const eventOrder = backward
    ? [desc(issueEvents.createdAt), desc(issueEvents.id)]
    : [asc(issueEvents.createdAt), asc(issueEvents.id)];

  const commentRows = wantComments
    ? await db
        .select({
          row: comments,
          number: issues.number,
          ts: microIso(comments.createdAt),
        })
        .from(comments)
        .innerJoin(issues, eq(comments.issueId, issues.id))
        .where(and(...commentConditions))
        .orderBy(...commentOrder)
        .limit(fetch)
    : [];
  const eventRows = wantEvents
    ? await db
        .select({
          row: issueEvents,
          number: issues.number,
          ts: microIso(issueEvents.createdAt),
        })
        .from(issueEvents)
        .innerJoin(issues, eq(issueEvents.issueId, issues.id))
        .where(and(...eventConditions))
        .orderBy(...eventOrder)
        .limit(fetch)
    : [];

  type RawWithIssue = Raw & { number: number };
  let merged: RawWithIssue[] = [
    ...commentRows.map(
      (r) =>
        ({
          kind: KIND_COMMENT,
          row: r.row,
          ts: r.ts,
          number: r.number,
        }) as RawWithIssue,
    ),
    ...eventRows.map(
      (r) =>
        ({
          kind: KIND_EVENT,
          row: r.row,
          ts: r.ts,
          number: r.number,
        }) as RawWithIssue,
    ),
  ].sort(compareRaw);
  merged = backward ? merged.slice(-query.limit) : merged.slice(0, query.limit);

  const refs = await actorRefs(ctx, merged);
  const items = merged.map((m) => ({
    ...toItem(m, refs),
    issue_number: m.number,
  }));

  const last = merged.at(-1);
  const next_cursor = last ? encodeCursor(cursorOf(last)) : null;
  return { items, next_cursor };
}
