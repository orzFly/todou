import type {
  TimelineItem,
  TimelinePage,
  TimelineQuery,
  UserRef,
} from "@todou/shared";
import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
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
    if (typeof parsed.t !== "string" || typeof parsed.i !== "number") {
      throw new Error("bad cursor");
    }
    return parsed;
  } catch {
    throw new ValidationFailedError("malformed cursor");
  }
}

type Raw =
  | { kind: 0; row: typeof comments.$inferSelect }
  | { kind: 1; row: typeof issueEvents.$inferSelect };

function cursorOf(item: Raw): Cursor {
  return {
    t: item.row.createdAt.toISOString(),
    k: item.kind,
    i: item.row.id,
  };
}

function compareRaw(a: Raw, b: Raw): number {
  const ta = a.row.createdAt.getTime();
  const tb = b.row.createdAt.getTime();
  if (ta !== tb) return ta - tb;
  if (a.kind !== b.kind) return a.kind - b.kind;
  return a.row.id - b.row.id;
}

/**
 * Per-table cursor predicate. `forward` means "strictly after the cursor
 * in timeline order"; backward is the mirror image.
 */
function beyond(
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  tableKind: 0 | 1,
  cursor: Cursor,
  forward: boolean,
) {
  const ts = new Date(cursor.t);
  const cmp = forward ? gt : lt;
  const conditions: SQL[] = [];
  const strict = cmp(createdAt, ts);
  if (strict) conditions.push(strict);

  if (tableKind === cursor.k) {
    const tie = and(eq(createdAt, ts), cmp(id, cursor.i));
    if (tie) conditions.push(tie);
  } else {
    const kindAfter = forward ? tableKind > cursor.k : tableKind < cursor.k;
    if (kindAfter) {
      const tie = eq(createdAt, ts);
      conditions.push(tie);
    }
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

  const commentConditions = [eq(comments.issueId, issue.id)];
  const eventConditions = [eq(issueEvents.issueId, issue.id)];
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
    await db
      .select()
      .from(comments)
      .where(and(...commentConditions))
      .orderBy(...commentOrder)
      .limit(fetch),
    await db
      .select()
      .from(issueEvents)
      .where(and(...eventConditions))
      .orderBy(...eventOrder)
      .limit(fetch),
  ];

  let merged: Raw[] = [
    ...commentRows.map((row) => ({ kind: KIND_COMMENT, row }) as Raw),
    ...eventRows.map((row) => ({ kind: KIND_EVENT, row }) as Raw),
  ].sort(compareRaw);

  let hasMore: boolean;
  if (backward) {
    hasMore = merged.length > query.limit;
    merged = merged.slice(-query.limit);
  } else {
    hasMore = merged.length > query.limit;
    merged = merged.slice(0, query.limit);
  }

  const actorIds = merged.map((m) =>
    m.kind === KIND_COMMENT ? m.row.authorId : m.row.actorId,
  );
  const refs = await getUserRefs(ctx.router.system(), actorIds);
  const ghost = (id: number): UserRef => ({
    id,
    login: "ghost",
    display_name: "Deleted user",
    kind: "human",
    owner: null,
  });

  const items: TimelineItem[] = merged.map((m) =>
    m.kind === KIND_COMMENT
      ? {
          type: "comment",
          id: m.row.id,
          author: refs.get(m.row.authorId) ?? ghost(m.row.authorId),
          body: m.row.body,
          created_at: m.row.createdAt.toISOString(),
          edited_at: m.row.editedAt?.toISOString() ?? null,
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
        },
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

  return { items, prev_cursor, next_cursor };
}
