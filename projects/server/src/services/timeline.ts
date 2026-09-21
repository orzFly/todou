import type {
  ActivityPage,
  ActivityQuery,
  CrossActivityPage,
  CrossActivityQuery,
  IssueEventType,
  MultiCursorPositions,
  TimelineItem,
  TimelinePage,
  TimelineQuery,
  UserRef,
} from "@todou/shared";
import {
  decodeMultiCursor,
  encodeMultiCursor,
  MalformedMultiCursorError,
  TimelineFilterType,
  UnsupportedCursorVersionError,
} from "@todou/shared";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn, PgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import {
  accessibleProjectRows,
  authorizeProjects,
  type ProjectRow,
  projectForRead,
  requireCapabilities,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import {
  crossRefVisibleCondition,
  type VisibleProjects,
  visibleProjects,
} from "./cross-references.ts";
import {
  type TimelineCursor as Cursor,
  decodeTimelineCursor as decodeCursor,
  encodeTimelineCursor as encodeCursor,
} from "./cursor.ts";
import { assertIssueReadable, gateColumns, live } from "./trash.ts";
import { getUserRefs } from "./users.ts";

const KIND_COMMENT = 0 as const;
const KIND_EVENT = 1 as const;

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

/**
 * `elideHidden` decides whether a hidden comment hands back its body (T-281).
 * The row itself always stays in the stream: dropping it would have to change
 * `total_count`, the cursors and the page boundaries with it, and blanking a
 * field cannot move a boundary.
 *
 * Every merged read passes `true` and only `include_hidden` turns it off, so
 * the rule holds for `--json` and `todou api` exactly as it does for a
 * rendered timeline. Asking for one comment by id goes through
 * `toTimelineComment` instead, which never elides.
 */
function toItem(
  m: Raw,
  refs: Map<number, UserRef>,
  elideHidden: boolean,
): TimelineItem {
  return m.kind === KIND_COMMENT
    ? {
        type: "comment",
        id: m.row.id,
        author: refs.get(m.row.authorId) ?? ghost(m.row.authorId),
        body: elideHidden && m.row.hiddenAt !== null ? "" : m.row.body,
        component: m.row.component ?? null,
        created_at: m.row.createdAt.toISOString(),
        edited_at: m.row.editedAt?.toISOString() ?? null,
        resolved_at: m.row.resolvedAt?.toISOString() ?? null,
        hidden_at: m.row.hiddenAt?.toISOString() ?? null,
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

type Filters = {
  types?: string;
  exclude_actor?: number;
  exclude_agent_session?: string;
};

/**
 * What an event naming another project may say to this reader — moves, and
 * block edges named with the far end's current slug at read time (T-419).
 *
 * Blanking fields rather than hiding rows is why this is post-processing
 * while `crossRefVisibleCondition` is a SQL predicate: dropping rows would
 * move page boundaries and corrupt cursors, blanking fields cannot. The keys
 * stay behind as nulls, which is how a client tells "redacted" apart from
 * "an old event that never carried this".
 *
 * It also strips `id_map` and `activity_imported_max_ids` from every
 * `moved_in`. Recovery needs the map and activity classification needs the
 * imported row boundaries, but both are internal metadata.
 *
 * Reference events are not redacted here at all since T-266: the SQL
 * predicate decides them whole, and a move no longer rewrites one, so there
 * is no row that was visible under an old spelling and needs to survive.
 */
export function redactEventPayloads<T extends TimelineItem>(
  items: T[],
  visible: VisibleProjects,
): T[] {
  const seen = (id: unknown) => typeof id === "number" && visible.ids.has(id);
  const blank = (payload: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) payload[key] = null;
  };
  const nameBlockEnd = (
    payload: Record<string, unknown>,
    idKey: string,
    numberKey: string,
    slugKey: string,
  ) => {
    const id = payload[idKey];
    if (!seen(id)) {
      blank(payload, [idKey, numberKey, slugKey]);
    } else {
      // Always override a stored slug: an old name may now belong to a
      // different project. A missing map entry leaves the numeric address.
      payload[slugKey] = visible.currentSlugs.get(id as number) ?? null;
    }
  };

  return items.map((item) => {
    if (item.type !== "event") return item;
    const payload = { ...item.payload };
    switch (item.event_type) {
      case "moved_in":
        delete payload.id_map;
        delete payload.activity_imported_max_ids;
        if (!seen(payload.from_project_id)) {
          blank(payload, ["from_project_id", "from_project", "from_number"]);
        }
        break;
      case "moved_out":
        if (!seen(payload.to_project_id)) {
          blank(payload, ["to_project_id", "to_project", "to_number"]);
        }
        break;
      // A block edge keeps its row and loses the far end's name, for the
      // same reason a move does: "this card is waiting on something" is a
      // fact about this card, and dropping the line would show it as free.
      case "block_added":
      case "block_removed":
        nameBlockEnd(
          payload,
          "other_project_id",
          "other_number",
          "other_project",
        );
        break;
      case "block_cleared":
      case "block_reblocked":
        nameBlockEnd(
          payload,
          "blocker_project_id",
          "blocker_number",
          "blocker_project",
        );
        break;
      default:
        return item;
    }
    return { ...item, payload };
  });
}

/**
 * "Not mine", as conditions over one table's (actor, agent session) pair.
 *
 * Each axis stands alone: `exclude_actor` drops an account's entries,
 * `exclude_agent_session` drops one agent session's. Together they compose
 * into the filter a watching agent actually wants (T-121): entries carrying
 * a session are judged by session alone — so a sibling agent sharing the
 * machine account stays visible — and the account axis narrows to the
 * entries that carry none (web writes, clients without a harness), where it
 * remains the only available answer to "was this me?".
 *
 * The empty string is normalized to "no session": a harness that reports
 * `session_id: ""` has told us nothing to compare, and letting it match
 * would make every such entry look like everyone else's own writes.
 */
function notSelfConditions(
  actorId: AnyPgColumn,
  agentContext: AnyPgColumn,
  filters: Filters,
): SQL[] {
  const conditions: SQL[] = [];
  const session = sql`nullif(${agentContext} ->> 'session_id', '')`;
  if (filters.exclude_agent_session !== undefined) {
    conditions.push(
      sql`${session} is distinct from ${filters.exclude_agent_session}::text`,
    );
  }
  if (filters.exclude_actor !== undefined) {
    conditions.push(
      filters.exclude_agent_session === undefined
        ? ne(actorId, filters.exclude_actor)
        : sql`(${session} is not null or ${actorId} <> ${filters.exclude_actor})`,
    );
  }
  return conditions;
}

/** The parsed `types`/self/visibility filters as per-table SQL conditions. */
function filterConditions(
  query: Filters,
  visible: VisibleProjects,
): {
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
  commentConditions.push(
    ...notSelfConditions(comments.authorId, comments.agentContext, query),
  );
  eventConditions.push(
    ...notSelfConditions(issueEvents.actorId, issueEvents.agentContext, query),
    crossRefVisibleCondition(visible.slugs, visible.ids),
  );
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
 * A cursor as the half-open window `[lo, hi)` of timestamps it cannot order
 * plus the (kind, id) pair that breaks ties inside it.
 */
export type CursorBounds = {
  lo: SQL;
  hi: SQL;
  /** A JS literal when the caller has one cursor, SQL when it comes from a row. */
  k: 0 | 1 | SQL;
  i: number | SQL;
};

/**
 * Cursor timestamps come in two precisions: microseconds from current
 * servers, milliseconds from servers before the T-69 fix (and from any
 * PGlite-era cursor an agent still has persisted). Both collapse onto one
 * window rule because `timestamptz`'s own resolution is a microsecond:
 * `'…00.1234565+00'::timestamptz` stores `…00.123456+00`, so
 * `+ interval '1 microsecond'` is that value's immediate successor and
 * `[t, t+1µs)` holds exactly the rows a µs cursor calls "equal". A
 * millisecond `t` cannot order rows inside its own millisecond, so its
 * window is the whole `[t, t+1ms)` — the same rule the old encoding applied
 * at equal timestamps, extended to the digits it could not see. The
 * single-table form of it lives in issues.ts#timeAdvance.
 *
 * A null cursor becomes `±infinity`, with a null (kind, id). Sentinels
 * rather than "no predicate at all" because the VALUES-driven form needs a
 * value in every column of every row; see `fetchActivityRows`.
 */
export function cursorBounds(
  cursor: Cursor | null,
  forward: boolean,
): CursorBounds {
  if (cursor === null) {
    const edge = forward
      ? sql`'-infinity'::timestamptz`
      : sql`'infinity'::timestamptz`;
    // Casts, not bare NULLs: an untyped null in a VALUES column leaves the
    // column typeless and the comparisons against it fail to parse.
    return { lo: edge, hi: edge, k: sql`null::int`, i: sql`null::bigint` };
  }
  const exact = /\.\d{4,}/.test(cursor.t);
  const lo = sql`${cursor.t}::timestamptz`;
  const hi = exact
    ? sql`${cursor.t}::timestamptz + interval '1 microsecond'`
    : sql`${new Date(Date.parse(cursor.t) + 1).toISOString()}::timestamptz`;
  return { lo, hi, k: cursor.k, i: cursor.i };
}

/**
 * Per-table cursor predicate. `forward` means "strictly after the cursor in
 * timeline order"; backward is the mirror image.
 *
 * Shaped as `window AND (past-the-window OR (in-window AND tie))` rather
 * than the older `past-the-window OR (in-window AND tie)`: the extra
 * conjunct is redundant as logic and decisive as an access path, because it
 * is the only part a planner can turn into an index bound. Without it a
 * mid-stream resume rescans the project's whole history to reach the cursor.
 *
 * When `bounds.k` is a JS literal the kind comparison is decided here and
 * the tie folds away, because a planner cannot prune a tie it only learns at
 * run time — that is the price of answering a whole database in one
 * statement, and single-cursor callers should not pay it.
 */
export function beyondBounds(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  tableKind: 0 | 1,
  bounds: CursorBounds,
  forward: boolean,
): SQL {
  const { lo, hi, k, i } = bounds;
  if (typeof k === "number" && k !== tableKind) {
    // The tie is constant, not the window: with the kinds ordered the right
    // way every in-window row of this table qualifies, which leaves the
    // window's own bound. Folding this into `created_at >= hi` instead would
    // silently drop every row sharing the cursor's microsecond.
    const kindAfter = forward ? tableKind > k : tableKind < k;
    if (forward) return kindAfter ? gte(createdAt, lo) : gte(createdAt, hi);
    return kindAfter ? lt(createdAt, hi) : lt(createdAt, lo);
  }
  let tie: SQL;
  if (typeof k === "number") {
    tie = forward ? gt(id, i) : lt(id, i);
  } else if (tableKind === KIND_COMMENT) {
    // Comments sort before events at an equal timestamp, so a cursor parked
    // on an event has already delivered every comment in the window.
    tie = forward
      ? sql`(${k} = 0 and ${id} > ${i})`
      : sql`(${k} = 1 or ${id} < ${i})`;
  } else {
    tie = forward
      ? sql`(${k} = 0 or ${id} > ${i})`
      : sql`(${k} = 1 and ${id} < ${i})`;
  }
  // A sentinel row's null (kind, id) makes `tie` null, and null never
  // reaches the result: `created_at` is NOT NULL, so the window bound beside
  // it is TRUE and `TRUE OR NULL` is TRUE by the truth table — which holds
  // whichever side SQL chooses to evaluate first.
  return forward
    ? sql`(${createdAt} >= ${lo} and (${createdAt} >= ${hi} or (${createdAt} < ${hi} and ${tie})))`
    : sql`(${createdAt} < ${hi} and (${createdAt} < ${lo} or (${createdAt} >= ${lo} and ${tie})))`;
}

export async function getTimeline(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  query: TimelineQuery,
): Promise<TimelinePage> {
  // The card's own timeline goes where the card went, so an old address gets
  // the redirect before the reader's role here is known (T-245). The two
  // project-wide activity reads below are not addressed by card and keep
  // their own gate.
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));

  const issueRows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueReadable(issue, actor, role);

  // Directions: `after` walks forward, `before` walks backward, `last`
  // takes the newest page. Default (no cursor) reads from the beginning.
  const backward = query.before !== undefined || query.last;
  const cursorRaw = query.before ?? query.after;
  const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw);
  const forward = !backward;

  // Filters narrow each table's query; a filtered-out table is skipped
  // entirely. Cursors still order the merged stream, so a poll that matches
  // nothing simply returns an empty page and the caller keeps its cursor.
  const visible = await visibleProjects(ctx, actor);
  const { wantComments, wantEvents, commentConditions, eventConditions } =
    filterConditions(query, visible);
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
    const bounds = cursorBounds(cursor, forward);
    commentConditions.push(
      beyondBounds(
        comments.createdAt,
        comments.id,
        KIND_COMMENT,
        bounds,
        forward,
      ),
    );
    eventConditions.push(
      beyondBounds(
        issueEvents.createdAt,
        issueEvents.id,
        KIND_EVENT,
        bounds,
        forward,
      ),
    );
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

  const hasMore = merged.length > query.limit;
  merged = backward ? merged.slice(-query.limit) : merged.slice(0, query.limit);

  const refs = await actorRefs(ctx, merged);
  const items: TimelineItem[] = redactEventPayloads(
    merged.map((m) => toItem(m, refs, !query.include_hidden)),
    visible,
  );

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

  return { items, prev_cursor, next_cursor, has_more: hasMore, total_count };
}

/** `slot` is the index in the caller's `entries` that produced the row. */
type RawWithIssue = Raw & { number: number; slot: number };

/** One entry's window into one project's stream. */
export type ActivityEntry = { projectId: number; cursor: Cursor | null };

/**
 * PostgreSQL binds at most 65535 parameters per statement and an entry
 * spends six of them, so an unsplit VALUES list turns into an opaque bind
 * failure somewhere past ten thousand entries. Before this shape that scale
 * cost twenty thousand statements — slow, but it answered; trading slow for
 * "errors out" is not an acceptable exchange.
 */
const VALUES_CHUNK = 1000;

/**
 * `SelectionProxyHandler` stamps the subquery's alias onto columns only in
 * its `get` trap, while `orderSelectedFields` reads the selection with
 * `Object.entries` and walks straight past it. Spreading a subquery
 * therefore yields columns that still name the base table and the dialect
 * rejects the query. Property access, not spread.
 */
function fromSubquery<T extends Record<string, PgColumn>>(
  sub: object,
  columns: T,
): T {
  const fields = sub as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(columns).map((key) => [key, fields[key]]),
  ) as T;
}

/**
 * Activity rows in ascending timeline order for a batch of (project,
 * cursor) entries that live in one database: comments × events merged, each
 * joined to its issue number, up to `fetchCount` rows per table and per
 * entry. Callers cut the page.
 *
 * Two statements answer the whole batch, whatever its size. The entries ride
 * in as a VALUES table that a `cross join lateral` drives, one correlated
 * `ORDER BY … LIMIT` per row of it, which is why the per-entry limit
 * survives batching.
 */
export async function fetchActivityRows(opts: {
  db: Db;
  entries: ActivityEntry[];
  filters: Filters;
  visible: VisibleProjects;
  backward: boolean;
  fetchCount: number;
  /**
   * Test-only. Reaching the real split needs 1001 entries, which means 1001
   * projects — a fixture PGlite cannot carry, so the boundary has to be
   * movable for the slot-numbering invariant to be checkable at all.
   */
  chunk?: number;
}): Promise<RawWithIssue[]> {
  const { db, entries, backward, fetchCount } = opts;
  // `sql.join([], …)` renders `(values ) as "cur"(…)`, which is a syntax
  // error. No caller reaches it today, but this is now the only way into the
  // tables and a reader with no project memberships arrives with an empty
  // list.
  if (entries.length === 0) return [];
  const forward = !backward;
  const { wantComments, wantEvents, commentConditions, eventConditions } =
    filterConditions(opts.filters, opts.visible);
  commentConditions.push(eq(comments.projectId, sql`"cur"."project_id"`));
  eventConditions.push(eq(issueEvents.projectId, sql`"cur"."project_id"`));
  // A card in the trash goes quiet everywhere except about the trashing
  // itself (T-145): an agent blocked on `todou watch` learns the card is
  // gone, by number, and its cursor keeps advancing over a continuous
  // stream. Everything else about the card — including its comments — stops
  // reaching the feed the moment it is deleted, and comes back on restore.
  commentConditions.push(live);
  // A tombstone is as quiet as a trashed card, with the same exception: the
  // one event saying the card left is the only trace the project keeps of it.
  const trashAudible = inArray(issueEvents.type, [
    "deleted",
    "restored",
    "moved_out",
  ] satisfies IssueEventType[]);
  const eventVisible = or(live, trashAudible);
  if (eventVisible) eventConditions.push(eventVisible);
  const curBounds: CursorBounds = {
    lo: sql`"cur"."lo"`,
    hi: sql`"cur"."hi"`,
    k: sql`"cur"."k"`,
    i: sql`"cur"."i"`,
  };
  commentConditions.push(
    beyondBounds(
      comments.createdAt,
      comments.id,
      KIND_COMMENT,
      curBounds,
      forward,
    ),
  );
  eventConditions.push(
    beyondBounds(
      issueEvents.createdAt,
      issueEvents.id,
      KIND_EVENT,
      curBounds,
      forward,
    ),
  );

  const commentOrder = backward
    ? [desc(comments.createdAt), desc(comments.id)]
    : [asc(comments.createdAt), asc(comments.id)];
  const eventOrder = backward
    ? [desc(issueEvents.createdAt), desc(issueEvents.id)]
    : [asc(issueEvents.createdAt), asc(issueEvents.id)];

  const out: RawWithIssue[] = [];
  const size = opts.chunk ?? VALUES_CHUNK;
  for (let base = 0; base < entries.length; base += size) {
    // Written out as raw `sql` rather than lifted into a shared helper,
    // following the derived table in services/calendar.ts that ends
    // `) as calendar_samples(sample)`: one reader, one place to look.
    //
    // `w` stays the index into the whole list. Renumbering per chunk would
    // hand the second chunk's rows to the first chunk's entries: two watches
    // would swap streams, one replaying and the other silently skipping —
    // exactly the failure the slot key exists to make impossible.
    const cur = sql`(values ${sql.join(
      entries.slice(base, base + size).map((entry, offset) => {
        const b = cursorBounds(entry.cursor, forward);
        // Every cell is cast: an uncast parameter inside VALUES arrives as
        // text and the comparisons against it never see a timestamp.
        const k = typeof b.k === "number" ? sql`${b.k}::int` : b.k;
        const i = typeof b.i === "number" ? sql`${b.i}::bigint` : b.i;
        return sql`(${base + offset}::int, ${entry.projectId}::bigint, ${b.lo}, ${b.hi}, ${k}, ${i})`;
      }),
      sql`, `,
    )}) as "cur"("w", "project_id", "lo", "hi", "k", "i")`;

    if (wantComments) {
      const c = db
        .select({
          ...getTableColumns(comments),
          // The column itself, not a wrapping `sql` expression: wrapping
          // swaps in the noop decoder and int8 comes back as a string on
          // node-postgres. `ts` may collide with neither table's columns nor
          // `cur`'s, because drizzle names an aliased field bare in the
          // outer query.
          issueNumber: issues.number,
          ts: microIso(comments.createdAt).as("ts"),
        })
        .from(comments)
        .innerJoin(issues, eq(comments.issueId, issues.id))
        .where(and(...commentConditions))
        .orderBy(...commentOrder)
        .limit(fetchCount)
        .as("c");
      const rows = await db
        .select({
          // Read off `cur` rather than carried through the subquery: an
          // inner field named `w` would render bare and collide with this.
          slot: sql<number>`"cur"."w"`.mapWith(Number),
          row: fromSubquery(c, getTableColumns(comments)),
          number: c.issueNumber,
          ts: c.ts,
        })
        .from(cur)
        .crossJoinLateral(c);
      out.push(
        ...rows.map(
          (r) =>
            ({
              kind: KIND_COMMENT,
              row: r.row,
              ts: r.ts,
              number: r.number,
              slot: r.slot,
            }) as RawWithIssue,
        ),
      );
    }

    if (wantEvents) {
      const e = db
        .select({
          ...getTableColumns(issueEvents),
          issueNumber: issues.number,
          ts: microIso(issueEvents.createdAt).as("ts"),
        })
        .from(issueEvents)
        .innerJoin(issues, eq(issueEvents.issueId, issues.id))
        .where(and(...eventConditions))
        .orderBy(...eventOrder)
        .limit(fetchCount)
        .as("e");
      const rows = await db
        .select({
          slot: sql<number>`"cur"."w"`.mapWith(Number),
          row: fromSubquery(e, getTableColumns(issueEvents)),
          number: e.issueNumber,
          ts: e.ts,
        })
        .from(cur)
        .crossJoinLateral(e);
      out.push(
        ...rows.map(
          (r) =>
            ({
              kind: KIND_EVENT,
              row: r.row,
              ts: r.ts,
              number: r.number,
              slot: r.slot,
            }) as RawWithIssue,
        ),
      );
    }
  }

  return out.sort(compareRaw);
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
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "activity.read",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const backward = query.last;
  const cursor = query.after === undefined ? null : decodeCursor(query.after);
  const visible = await visibleProjects(ctx, actor);
  // One entry through the batched path rather than a second query shape:
  // every single-project case in the suite then also covers the SQL the
  // cross-project stream runs.
  const merged = await fetchActivityRows({
    db,
    entries: [{ projectId: project.id, cursor }],
    filters: query,
    visible,
    backward,
    fetchCount: query.limit + 1,
  });
  const hasMore = merged.length > query.limit;
  const page = backward
    ? merged.slice(-query.limit)
    : merged.slice(0, query.limit);

  const refs = await actorRefs(ctx, page);
  const items = redactEventPayloads(
    page.map((m) => ({
      ...toItem(m, refs, !query.include_hidden),
      issue_number: m.number,
    })),
    visible,
  );

  const last = page.at(-1);
  const next_cursor = last ? encodeCursor(cursorOf(last)) : null;
  return { items, next_cursor, has_more: hasMore };
}

type WatchedProject = {
  /**
   * The ref as the request spelled it — a retired slug or an id both count,
   * and one project may be watched under two spellings at once. It keys the
   * cursor envelope, so it is not interchangeable with the project's slug.
   */
  ref: string;
  project: ProjectRow;
  /** Opaque plain cursor to drain beyond; null = from the beginning. */
  position: string | null;
};

/**
 * The newest position present in the envelope, by wall-clock timestamp.
 * Used as the starting position of projects the envelope has never seen:
 * unlike "now", it is a pure function of the envelope, so re-sending the
 * same envelope over a quiet stream cannot re-bootstrap past (and thereby
 * lose) entries that arrived in between — the caller's cursor only moves
 * when a page is actually delivered. Sub-millisecond ties are compared
 * coarsely; picking the marginally older twin merely replays a hair more.
 */
function newestEnvelopePosition(envelope: MultiCursorPositions): string | null {
  let best: { raw: string; at: number } | null = null;
  for (const raw of Object.values(envelope)) {
    if (raw === null) continue;
    const at = Date.parse(decodeCursor(raw).t);
    if (best === null || at > best.at) best = { raw, at };
  }
  return best?.raw ?? null;
}

/**
 * Cross-project activity stream (T-93): the per-project stream of
 * getProjectActivity, fanned out over several projects and merged, each
 * entry annotated with its project slug. Positions advance per project —
 * project databases may sit on hosts whose clocks disagree, so a single
 * shared cursor would silently drop entries — and round-trip through the
 * caller as an opaque envelope (see cursor-envelope.ts in @todou/shared).
 *
 * `after` accepts an envelope (per-project resume) or a plain cursor (the
 * common wall-clock starting position for every watched project, letting
 * an `issue view` cursor bootstrap a cross-project watch). `last`
 * bootstraps "now" positions and returns them as an envelope with no
 * items. The page cut needs no cross-project total order: each project's
 * stream is internally ordered and resumes from its own delivered tail.
 */
export async function getCrossActivity(
  ctx: AppContext,
  actor: UserRow,
  query: CrossActivityQuery,
): Promise<CrossActivityPage> {
  const explicit =
    query.projects === undefined
      ? null
      : [
          ...new Set(
            query.projects
              .split(",")
              .map((slug) => slug.trim())
              .filter((slug) => slug !== ""),
          ),
        ].sort();
  if (explicit !== null && explicit.length === 0) {
    throw new ValidationFailedError("projects names no project");
  }
  // Absent `projects` = everything the caller can read, re-resolved on
  // every request so a long-running watch picks up projects created (or
  // shared) after it started.
  let watchedRefs: string[];
  let rows: ProjectRow[];
  if (explicit !== null) {
    watchedRefs = explicit;
    rows = await requireCapabilities(ctx, actor, explicit, "activity.read");
  } else {
    rows = (await accessibleProjectRows(ctx, actor)).sort((a, b) =>
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
    );
    watchedRefs = rows.map((row) => row.slug);
    // Never fails today — activity.read asks for reader and every row here
    // carries one — but dropping it would take this path out of the catalog.
    await authorizeProjects(ctx, actor, rows, "activity.read");
  }

  // The filter set is every project the caller can read, even when this
  // request only watches a few of them: what a cross-reference may name is
  // a property of the viewer, not of the requested scope.
  const visible = await visibleProjects(ctx, actor);

  // Handles are not opened here: `perDatabase` takes each one inside the
  // task body that reads it, and pins it for that body's lifetime. Holding
  // one from up here is what the router's max_open bound cannot account for.
  const watched: WatchedProject[] = watchedRefs.map((ref, i) => ({
    ref,
    project: rows[i] as ProjectRow,
    position: null,
  }));

  /** Rows keyed back to the entry that asked for them. */
  const fanOut = async (
    entries: (w: WatchedProject) => ActivityEntry,
    filters: Filters,
    backward: boolean,
    fetchCount: number,
  ): Promise<(RawWithIssue & { ref: string })[]> => {
    const groups = await ctx.router.perDatabase(
      watched,
      (w) => routeInfoOf(w.project),
      async (db, group) => {
        // No transaction around the pair. They never shared a snapshot, so
        // one would be new semantics, and under `shared` the group's handle
        // is the system handle that `actorRefs` reads next — a project
        // transaction held open across it would wait on its own snapshot.
        const rows = await fetchActivityRows({
          db,
          entries: group.map(entries),
          filters,
          visible,
          backward,
          fetchCount,
        });
        // Slot → ref resolves in here because this is the only scope that
        // knows which entries went into this group's VALUES list.
        return rows.map((r) => ({
          ...r,
          ref: (group[r.slot] as WatchedProject).ref,
        }));
      },
    );
    return groups.flat();
  };

  if (query.last) {
    // The newest row's position regardless of the request's filters: a
    // bootstrap marks "everything up to here is old", and filters only
    // decide what gets delivered, never where "here" is.
    const newest = await fanOut(
      (w) => ({ projectId: w.project.id, cursor: null }),
      {},
      true,
      1,
    );
    // One row per table per entry comes back; the newer of the two is the
    // bootstrap position, which is what taking the tail of an ascending pair
    // used to mean.
    const newestOf = new Map<string, RawWithIssue>();
    for (const row of newest) {
      const held = newestOf.get(row.ref);
      if (held === undefined || compareRaw(held, row) < 0) {
        newestOf.set(row.ref, row);
      }
    }
    const positions: MultiCursorPositions = {};
    for (const p of watched) {
      // A lateral join drops a `cur` row that matched nothing, so a project
      // with no activity never comes back and keeps its null.
      const row = newestOf.get(p.ref);
      positions[p.ref] = row ? encodeCursor(cursorOf(row)) : null;
    }
    return {
      items: [],
      next_cursor: await encodeMultiCursor(positions),
      has_more: false,
    };
  }

  if (query.after !== undefined) {
    let envelope: MultiCursorPositions | null;
    try {
      envelope = await decodeMultiCursor(query.after);
    } catch (error) {
      if (
        error instanceof MalformedMultiCursorError ||
        error instanceof UnsupportedCursorVersionError
      ) {
        throw new ValidationFailedError(error.message);
      }
      throw error;
    }
    if (envelope === null) {
      // A plain cursor: wall-clock timestamps are comparable across
      // projects, so it serves as the common starting position. Validate
      // once up front so garbage fails as "malformed cursor", not as a
      // per-project surprise.
      decodeCursor(query.after);
      for (const p of watched) p.position = query.after;
    } else {
      const fallback = newestEnvelopePosition(envelope);
      for (const p of watched) {
        p.position = p.ref in envelope ? (envelope[p.ref] ?? null) : fallback;
      }
    }
  }

  const all = await fanOut(
    (w) => ({
      projectId: w.project.id,
      cursor: w.position === null ? null : decodeCursor(w.position),
    }),
    query,
    false,
    query.limit + 1,
  );
  // A total order, so the order the groups happen to finish in cannot reach
  // the page: two rows tie only when timestamp, kind, id and ref all match,
  // and the refs were deduplicated as strings before any of this.
  all.sort(
    (a, b) => compareRaw(a, b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  const hasMore = all.length > query.limit;
  const page = all.slice(0, query.limit);

  const positions: MultiCursorPositions = {};
  for (const p of watched) positions[p.ref] = p.position;
  // Later rows overwrite earlier ones, leaving each project's position on
  // its last *delivered* row — undelivered projects keep their incoming
  // position, so the cut point can fall anywhere without losing entries.
  for (const row of page) positions[row.ref] = encodeCursor(cursorOf(row));

  const refs = await actorRefs(ctx, page);
  const items = redactEventPayloads(
    page.map((m) => ({
      ...toItem(m, refs, !query.include_hidden),
      issue_number: m.number,
      project: m.ref,
    })),
    visible,
  );
  const next_cursor =
    page.length > 0 ? await encodeMultiCursor(positions) : null;
  return { items, next_cursor, has_more: hasMore };
}
