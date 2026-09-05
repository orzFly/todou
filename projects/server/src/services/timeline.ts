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
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { projectForRead, requireCapability, routeInfoOf } from "./access.ts";
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
import { listProjects } from "./projects.ts";
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

type Filters = {
  types?: string;
  exclude_actor?: number;
  exclude_agent_session?: string;
};

/**
 * What a move event may say to this reader.
 *
 * Blanking fields rather than hiding rows is why this is post-processing
 * while `crossRefVisibleCondition` is a SQL predicate: dropping rows would
 * move page boundaries and corrupt cursors, blanking fields cannot. The keys
 * stay behind as nulls, which is how a client tells "redacted" apart from
 * "an old event that never carried this".
 *
 * It also strips `id_map` from every `moved_in`. That map is the
 * cross-database protocol's only durable record of which copy became which,
 * so it has to live in the payload — but it is nobody's contract, and no
 * response may carry it.
 */
export function redactMovePayloads<T extends TimelineItem>(
  items: T[],
  visibleProjectIds: Set<number>,
): T[] {
  const seen = (id: unknown) =>
    typeof id === "number" && visibleProjectIds.has(id);
  const blank = (payload: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) payload[key] = null;
  };

  return items.map((item) => {
    if (item.type !== "event") return item;
    const payload = { ...item.payload };
    switch (item.event_type) {
      case "moved_in":
        delete payload.id_map;
        if (!seen(payload.from_project_id)) {
          blank(payload, ["from_project_id", "from_project", "from_number"]);
        }
        break;
      case "moved_out":
        if (!seen(payload.to_project_id)) {
          blank(payload, ["to_project_id", "to_project", "to_number"]);
        }
        break;
      case "cross_referenced":
        // Rows a move did not rewrite are already filtered by the SQL
        // predicate, so one arriving here is visible exactly as it stands.
        // A rewritten one stays — it was visible before the move — with
        // everything identifying the far side blanked out.
        if (payload.by_moved === true && !seen(payload.by_project_id)) {
          blank(payload, [
            "by_project_id",
            "by_project",
            "by_issue",
            "by_comment",
          ]);
        }
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
 * Per-table cursor predicate. `forward` means "strictly after the cursor
 * in timeline order"; backward is the mirror image.
 *
 * Cursor timestamps come in two precisions: microseconds from current
 * servers, milliseconds from servers before the T-69 fix (and from any
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

  const hasMore = merged.length > query.limit;
  merged = backward ? merged.slice(-query.limit) : merged.slice(0, query.limit);

  const refs = await actorRefs(ctx, merged);
  const items: TimelineItem[] = redactMovePayloads(
    merged.map((m) => toItem(m, refs)),
    visible.ids,
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

type RawWithIssue = Raw & { number: number };

/**
 * One project's activity rows in ascending timeline order: comments ×
 * events merged, each joined to its issue number, up to `fetchCount` rows
 * per table beyond `cursor` (or the newest `fetchCount` when `backward`).
 * Callers cut the page; extracting this core is what lets the
 * cross-project stream (T-93) reuse the exact single-project semantics
 * once per watched project.
 */
async function fetchProjectActivityRows(opts: {
  db: Db;
  projectId: number;
  cursor: Cursor | null;
  filters: Filters;
  visible: VisibleProjects;
  backward: boolean;
  fetchCount: number;
}): Promise<RawWithIssue[]> {
  const { db, projectId, cursor, backward, fetchCount } = opts;
  const forward = !backward;
  const { wantComments, wantEvents, commentConditions, eventConditions } =
    filterConditions(opts.filters, opts.visible);
  commentConditions.push(eq(comments.projectId, projectId));
  eventConditions.push(eq(issueEvents.projectId, projectId));
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
        .limit(fetchCount)
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
        .limit(fetchCount)
    : [];

  return [
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
  const merged = await fetchProjectActivityRows({
    db,
    projectId: project.id,
    cursor,
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
  const items = redactMovePayloads(
    page.map((m) => ({ ...toItem(m, refs), issue_number: m.number })),
    visible.ids,
  );

  const last = page.at(-1);
  const next_cursor = last ? encodeCursor(cursorOf(last)) : null;
  return { items, next_cursor, has_more: hasMore };
}

type WatchedProject = {
  slug: string;
  projectId: number;
  db: Db;
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
  const slugs =
    explicit ??
    (await listProjects(ctx, actor)).map((project) => project.slug).sort();

  // The filter set is every project the caller can read, even when this
  // request only watches a few of them: what a cross-reference may name is
  // a property of the viewer, not of the requested scope.
  const visible = await visibleProjects(ctx, actor);

  const watched: WatchedProject[] = [];
  for (const slug of slugs) {
    const { project } = await requireCapability(
      ctx,
      actor,
      slug,
      "activity.read",
    );
    watched.push({
      slug,
      projectId: project.id,
      db: await ctx.router.forProject(routeInfoOf(project)),
      position: null,
    });
  }

  // The newest row's position regardless of the request's filters: a
  // bootstrap marks "everything up to here is old", and filters only
  // decide what gets delivered, never where "here" is.
  const tailOf = async (p: WatchedProject): Promise<string | null> => {
    const rows = await fetchProjectActivityRows({
      db: p.db,
      projectId: p.projectId,
      cursor: null,
      filters: {},
      visible,
      backward: true,
      fetchCount: 1,
    });
    const newest = rows.at(-1);
    return newest ? encodeCursor(cursorOf(newest)) : null;
  };

  if (query.last) {
    const positions: MultiCursorPositions = {};
    for (const p of watched) positions[p.slug] = await tailOf(p);
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
        p.position = p.slug in envelope ? (envelope[p.slug] ?? null) : fallback;
      }
    }
  }

  const all: (RawWithIssue & { slug: string })[] = [];
  for (const p of watched) {
    const rows = await fetchProjectActivityRows({
      db: p.db,
      projectId: p.projectId,
      cursor: p.position === null ? null : decodeCursor(p.position),
      filters: query,
      visible,
      backward: false,
      fetchCount: query.limit + 1,
    });
    all.push(...rows.map((row) => ({ ...row, slug: p.slug })));
  }
  all.sort(
    (a, b) =>
      compareRaw(a, b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  const hasMore = all.length > query.limit;
  const page = all.slice(0, query.limit);

  const positions: MultiCursorPositions = {};
  for (const p of watched) positions[p.slug] = p.position;
  // Later rows overwrite earlier ones, leaving each project's position on
  // its last *delivered* row — undelivered projects keep their incoming
  // position, so the cut point can fall anywhere without losing entries.
  for (const row of page) positions[row.slug] = encodeCursor(cursorOf(row));

  const refs = await actorRefs(ctx, page);
  const items = redactMovePayloads(
    page.map((m) => ({
      ...toItem(m, refs),
      issue_number: m.number,
      project: m.slug,
    })),
    visible.ids,
  );
  const next_cursor =
    page.length > 0 ? await encodeMultiCursor(positions) : null;
  return { items, next_cursor, has_more: hasMore };
}
