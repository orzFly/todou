import type {
  MultiCursorPositions,
  UserIssueItem,
  UserIssuesPage,
  UserIssuesQuery,
} from "@todou/shared";
import {
  decodeMultiCursor,
  encodeMultiCursor,
  MalformedMultiCursorError,
  UnsupportedCursorVersionError,
} from "@todou/shared";
import { and, desc, eq, isNotNull, or, type SQL } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { issueAssignees, issues, statuses } from "../db/project-schema.ts";
import { ValidationFailedError } from "../errors.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "./access.ts";
import { visibleProjects } from "./cross-references.ts";
import { decodeListCursor, encodeListCursor } from "./cursor.ts";
import { bundleIssues, timeAdvance, toIssue } from "./issues.ts";
import { loadMuteContext } from "./mutes.ts";
import { toProjectBrief } from "./projects.ts";
import { unreadIssueState } from "./reads.ts";
import { microIso } from "./timeline.ts";
import { live } from "./trash.ts";

/** One project's slice of the merge, before the cut decides who survives. */
type Candidate = {
  project: ProjectRow;
  row: typeof issues.$inferSelect;
  /** The sort value at full precision, which is also the cursor's. */
  ts: string;
};

/**
 * Newest first, a tie broken by project.
 *
 * What that tie-break buys is the order the page reads in, not its
 * correctness. Rows can neither double nor vanish across the cut whichever
 * way a tie resolves, because each project resumes from its own last
 * delivered row: within one project this ordering *is* that project's own
 * `ORDER BY updated_at DESC, id DESC`, so any page is a prefix of each
 * project's stream no matter how the streams interleave.
 *
 * Falling through to `row.id` instead would be ordering by nothing —
 * separate project databases mint ids from unrelated sequences.
 */
function compare(a: Candidate, b: Candidate): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  if (a.project.id !== b.project.id) return b.project.id - a.project.id;
  return b.row.id - a.row.id;
}

/**
 * Cards the subject authored or is assigned, across every project **the
 * caller** can read (T-374).
 *
 * Fan out, merge, cut, resume — the shape `getCrossActivity` already uses
 * for `/activity`, with the issue-list cursor riding inside the envelope
 * instead of the timeline one. Each project's stream is ordered on its own
 * and resumes from its own delivered tail, so the cut may land anywhere
 * without losing a row or handing one out twice.
 */
export async function listUserIssues(
  ctx: AppContext,
  viewer: UserRow,
  subject: UserRow,
  query: UserIssuesQuery,
): Promise<UserIssuesPage> {
  const scope = await accessibleProjectRows(ctx, viewer);
  if (scope.length === 0) {
    return { items: [], next_cursor: null, has_more: false };
  }
  const visible = await visibleProjects(ctx, viewer);

  let incoming: MultiCursorPositions = {};
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
    // A plain cursor is refused rather than broadcast to every project.
    // `/activity` accepts one because a wall-clock timeline position is a
    // meaningful common start for a live tail; this list has no cursor a
    // caller could plausibly be holding from anywhere else.
    if (envelope === null) {
      throw new ValidationFailedError(
        "after must be a cursor this endpoint minted",
      );
    }
    incoming = envelope;
  }

  const candidates: Candidate[] = [];
  for (const project of scope) {
    const position = incoming[project.slug] ?? null;
    const conditions: SQL[] = [eq(issues.projectId, project.id), live];

    // One left join answers all three `role` values, with no id list
    // pre-fetched into JavaScript. `issue_assignees` holds at most one row
    // per (issue, user), so the join cannot duplicate a card.
    const assigned = isNotNull(issueAssignees.userId);
    const involved =
      query.role === "author"
        ? eq(issues.authorId, subject.id)
        : query.role === "assignee"
          ? assigned
          : or(eq(issues.authorId, subject.id), assigned);
    if (involved) conditions.push(involved);

    if (query.state !== "all") {
      conditions.push(eq(statuses.category, query.state));
    }
    if (position !== null) {
      const advance = timeAdvance(
        issues.updatedAt,
        decodeListCursor(position, false),
        false,
      );
      if (advance) conditions.push(advance);
    }

    // Opened here rather than up front: DbRouter closes the least-recently
    // used handle past `database.projects.max_open`, so collecting every
    // project's handle before querying can cut a query off mid-flight once
    // the readable set outgrows that limit.
    const db = await ctx.router.forProject(routeInfoOf(project));
    const rows = await db
      .select({ row: issues, ts: microIso(issues.updatedAt) })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .leftJoin(
        issueAssignees,
        and(
          eq(issueAssignees.issueId, issues.id),
          eq(issueAssignees.userId, subject.id),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt), desc(issues.id))
      .limit(query.limit + 1);

    for (const r of rows) candidates.push({ project, row: r.row, ts: r.ts });
  }

  candidates.sort(compare);
  const has_more = candidates.length > query.limit;
  const page = candidates.slice(0, query.limit);

  const byProject = new Map<number, Candidate[]>();
  for (const candidate of page) {
    const slice = byProject.get(candidate.project.id) ?? [];
    slice.push(candidate);
    byProject.set(candidate.project.id, slice);
  }

  const enriched = new Map<string, UserIssueItem>();
  for (const slice of byProject.values()) {
    const project = slice[0]?.project;
    if (project === undefined) continue;
    const rows = slice.map((c) => c.row);
    const ids = rows.map((r) => r.id);
    const db = await ctx.router.forProject(routeInfoOf(project));
    const bundles = await bundleIssues(ctx, db, [project.id], rows, viewer);
    const mutes = await loadMuteContext(
      ctx.router.system(),
      db,
      viewer.id,
      [project.id],
      ids,
    );
    const { unread, counts, silenced } = await unreadIssueState(
      db,
      [project.id],
      viewer.id,
      ids,
      visible,
      mutes,
      new Map(ids.map((id) => [id, project.id])),
    );
    for (const bundle of bundles) {
      const { body: _body, ...listItem } = toIssue(bundle);
      enriched.set(`${project.id}/${bundle.row.id}`, {
        ...listItem,
        unread: unread.has(bundle.row.id),
        unread_comments: counts.get(bundle.row.id) ?? 0,
        muted: silenced.get(bundle.row.id) ?? null,
        project: toProjectBrief(project),
      });
    }
  }

  // Each project's position moves to its last *delivered* row; one that
  // delivered nothing keeps the position it came in with, so its rows are
  // offered again on the next page rather than skipped past.
  const positions: MultiCursorPositions = { ...incoming };
  for (const candidate of page) {
    positions[candidate.project.slug] = encodeListCursor({
      v: candidate.ts,
      i: candidate.row.id,
    });
  }

  const items = page
    .map((c) => enriched.get(`${c.project.id}/${c.row.id}`))
    .filter((item): item is UserIssueItem => item !== undefined);

  return {
    items,
    next_cursor: page.length === 0 ? null : await encodeMultiCursor(positions),
    has_more,
  };
}
