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
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
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
import { bundleIssues, listCursorBounds, toIssue } from "./issues.ts";
import { loadIssueMutes, loadMutedProjects } from "./mutes.ts";
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

  const projectById = new Map(scope.map((p) => [p.id, p]));

  // Decoded before any query runs, so a malformed cursor is a 422 rather
  // than a failed statement. Keyed by id because the VALUES rows below are
  // built from ids.
  const boundsById = new Map<number, ReturnType<typeof listCursorBounds>>();
  for (const project of scope) {
    const position = incoming[project.slug] ?? null;
    if (position === null) continue;
    boundsById.set(
      project.id,
      listCursorBounds(decodeListCursor(position, false)),
    );
  }

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
  const stateCond =
    query.state === "all" ? undefined : eq(statuses.category, query.state);

  const candidates = (
    await ctx.router.perDatabase(scope, routeInfoOf, async (db, group) => {
      // Written out here rather than lifted into a shared helper, following
      // the derived table in services/calendar.ts that ends
      // `) as calendar_samples(sample)`. Three VALUES tables now drive
      // queries in this repo — this one, `"cur"` in timeline.ts and
      // calendar's — and their column sets have nothing in common; merging
      // them buys a parameter list nobody can read.
      const valueRows = group.map((p) => {
        const b = boundsById.get(p.id);
        // Every cell is cast: an uncast parameter arrives inside VALUES as
        // text, and comparing a timestamptz column against it errors out
        // rather than falling back to some coercion. `project_id` is bigint
        // to match the column it is compared to.
        return b === undefined
          ? sql`(${p.id}::bigint, null::timestamptz, null::timestamptz, null::bigint)`
          : sql`(${p.id}::bigint, ${b.from}, ${b.hi}, ${b.id}::bigint)`;
      });
      // The alias and its column names are literal template text: rendered
      // as parameters they would go out as `as $1($2)` and the statement
      // would not parse.
      const scopeSource = sql`(values ${sql.join(valueRows, sql`, `)}) as scope(project_id, after_from, after_hi, after_id)`;
      const ref = {
        projectId: sql`scope.project_id`,
        from: sql`scope.after_from`,
        hi: sql`scope.after_hi`,
        id: sql`scope.after_id`,
      };
      const position = or(
        sql`scope.after_from is null`,
        lt(issues.updatedAt, ref.from),
        and(
          gte(issues.updatedAt, ref.from),
          lt(issues.updatedAt, ref.hi),
          lt(issues.id, ref.id),
        ),
      );
      const hit = db
        .select({
          ...getTableColumns(issues),
          ts: microIso(issues.updatedAt).as("ts"),
        })
        .from(issues)
        .innerJoin(statuses, eq(statuses.id, issues.statusId))
        .leftJoin(
          issueAssignees,
          and(
            eq(issueAssignees.issueId, issues.id),
            eq(issueAssignees.userId, subject.id),
          ),
        )
        .where(
          and(
            eq(issues.projectId, ref.projectId),
            live,
            involved,
            stateCond,
            position,
          ),
        )
        .orderBy(desc(issues.updatedAt), desc(issues.id))
        .limit(query.limit + 1)
        .as("hit");
      const rows = await db.select().from(scopeSource).crossJoinLateral(hit);
      return rows.map(({ hit: { ts, ...row } }) => {
        const project = projectById.get(row.projectId);
        if (project === undefined) throw new Error("candidate outside scope");
        return { project, row, ts } satisfies Candidate;
      });
    })
  ).flat();

  candidates.sort(compare);
  const has_more = candidates.length > query.limit;
  const page = candidates.slice(0, query.limit);

  const byProject = new Map<number, Candidate[]>();
  // Grouped over the projects that actually delivered a row, not over
  // `scope`: `unreadIssueState` mints a read frontier for every project it
  // is handed (T-151), and widening that would start calling projects
  // "looked at" that this page never showed anything from.
  const delivered: ProjectRow[] = [];
  for (const candidate of page) {
    const slice = byProject.get(candidate.project.id);
    if (slice) slice.push(candidate);
    else {
      byProject.set(candidate.project.id, [candidate]);
      delivered.push(candidate.project);
    }
  }

  // Read once here rather than per group: a project mute lives in the
  // system db, and every group needs the same answer (T-372).
  const mutedProjects = await loadMutedProjects(
    ctx.router.system(),
    viewer.id,
    delivered.map((p) => p.id),
  );

  const enriched = new Map(
    (
      await ctx.router.perDatabase(
        delivered,
        routeInfoOf,
        // No transaction around this body. Under shared placement `db` is
        // the system handle, and the body goes back to the system database
        // through `bundleIssues`; on inline PGlite's single connection that
        // is a wait on one's own snapshot. Everything here is a read, so
        // there is nothing a transaction would buy.
        async (db, group) => {
          const groupProjectIds = group.map((p) => p.id);
          const rows = group.flatMap((p) =>
            (byProject.get(p.id) ?? []).map((c) => c.row),
          );
          const ids = rows.map((r) => r.id);
          const bundles = await bundleIssues(
            ctx,
            db,
            groupProjectIds,
            rows,
            viewer,
          );
          const mutes = await loadIssueMutes(db, viewer.id, ids, mutedProjects);
          const { unread, counts, silenced } = await unreadIssueState(
            db,
            groupProjectIds,
            viewer.id,
            ids,
            visible,
            mutes,
            new Map(rows.map((r) => [r.id, r.projectId])),
          );
          const items: [string, UserIssueItem][] = [];
          for (const bundle of bundles) {
            const project = projectById.get(bundle.row.projectId);
            if (project === undefined) {
              throw new Error("bundled row outside scope");
            }
            const { body: _body, ...listItem } = toIssue(bundle);
            items.push([
              `${project.id}/${bundle.row.id}`,
              {
                ...listItem,
                unread: unread.has(bundle.row.id),
                unread_comments: counts.get(bundle.row.id) ?? 0,
                muted: silenced.get(bundle.row.id) ?? null,
                project: toProjectBrief(project),
              },
            ]);
          }
          return items;
        },
      )
    ).flat(),
  );

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
