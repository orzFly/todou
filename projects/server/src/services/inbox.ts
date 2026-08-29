import type { InboxItem, InboxPage, InboxQuery } from "@todou/shared";
import { and, eq, gt, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issueReads,
  issues,
  specVersions,
  statuses,
} from "../db/project-schema.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireProject,
  routeInfoOf,
} from "./access.ts";
import {
  crossRefVisibleCondition,
  visibleSlugsWithHistory,
} from "./cross-references.ts";
import { bundleIssues, toIssue } from "./issues.ts";
import { readPrefs } from "./prefs.ts";
import { ensureFrontier, unreadIssueState } from "./reads.ts";
import { notDeleted } from "./trash.ts";

type ProjectSlice = { items: InboxItem[]; truncated: boolean };

async function projectInbox(
  ctx: AppContext,
  db: Db,
  project: ProjectRow,
  userId: number,
  limit: number,
  showWeakUnread: boolean,
  visibleSlugs: string[],
): Promise<ProjectSlice> {
  const frontier = await ensureFrontier(db, project.id, userId);

  // Candidate discovery mirrors unreadIssueState's thresholds — including
  // the asymmetry where a per-issue position older than the frontier keeps
  // counting comments (but not events) after it. unreadIssueState remains
  // the authority below; a stray candidate just falls out at the keep-check.
  const commentCand = await db
    .select({ issueId: comments.issueId, latest: max(comments.createdAt) })
    .from(comments)
    .leftJoin(
      issueReads,
      and(
        eq(issueReads.issueId, comments.issueId),
        eq(issueReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(comments.projectId, project.id),
        ne(comments.authorId, userId),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${frontier})`,
      ),
    )
    .groupBy(comments.issueId);

  // Cards opened by someone else, on the comment threshold rather than the
  // event one: the top post counts as a comment (T-151), so the asymmetry
  // above applies to it too. `opened` reaches eventCand as well, but only
  // above the frontier floor — which would drop exactly the cards a stale
  // per-issue position is meant to keep.
  const issueCand = await db
    .select({ issueId: issues.id })
    .from(issues)
    .leftJoin(
      issueReads,
      and(eq(issueReads.issueId, issues.id), eq(issueReads.userId, userId)),
    )
    .where(
      and(
        eq(issues.projectId, project.id),
        ne(issues.authorId, userId),
        sql`${issues.createdAt} > coalesce(${issueReads.lastSeenAt}, ${frontier})`,
      ),
    );

  const eventCand = await db
    .select({
      issueId: issueEvents.issueId,
      latest: max(issueEvents.createdAt),
    })
    .from(issueEvents)
    .leftJoin(
      issueReads,
      and(
        eq(issueReads.issueId, issueEvents.issueId),
        eq(issueReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(issueEvents.projectId, project.id),
        ne(issueEvents.actorId, userId),
        gt(issueEvents.createdAt, frontier),
        sql`${issueEvents.createdAt} > coalesce(${issueReads.lastSeenAt}, ${frontier})`,
        crossRefVisibleCondition(visibleSlugs),
      ),
    )
    .groupBy(issueEvents.issueId);

  // Closed issues are excluded here and neutralized again at the keep-check
  // below: once an issue is closed its unreviewed spec and unanswered
  // questions have lost their timeliness (T-111). Only a genuinely new
  // comment may still pull one in, and that arrives via commentCand.
  const pendingRows = await db
    .select({ id: issues.id })
    .from(issues)
    .innerJoin(statuses, eq(issues.statusId, statuses.id))
    .where(
      and(
        eq(issues.projectId, project.id),
        ne(statuses.category, "closed"),
        or(
          gt(issues.openQuestions, 0),
          and(
            eq(issues.specReviewStatus, "unreviewed"),
            isNotNull(issues.specVersion),
          ),
        ),
      ),
    );

  const candidateIds = new Set<number>([
    ...commentCand.map((r) => r.issueId),
    ...issueCand.map((r) => r.issueId),
    ...eventCand.map((r) => r.issueId),
    ...pendingRows.map((r) => r.id),
  ]);
  if (candidateIds.size === 0) return { items: [], truncated: false };
  const ids = [...candidateIds];

  // The one choke point for the trash (T-145): candidates arrive from four
  // separate scans, but every item the inbox emits is built from these rows,
  // so filtering here is what makes "deleted → out of everyone's inbox"
  // hold no matter which scan turned the card up.
  const rows = await db
    .select()
    .from(issues)
    .where(and(inArray(issues.id, ids), notDeleted));
  const bundles = await bundleIssues(ctx, db, project.id, rows);
  const { unread, counts } = await unreadIssueState(
    db,
    project.id,
    userId,
    ids,
    visibleSlugs,
  );

  // Current version's author, for the "waiting for MY review" exclusion —
  // issues.spec_version is the denormalized current number (T-23).
  const specAuthors = new Map<number, { authorId: number; createdAt: Date }>();
  const unreviewedIds = rows
    .filter(
      (r) => r.specReviewStatus === "unreviewed" && r.specVersion !== null,
    )
    .map((r) => r.id);
  if (unreviewedIds.length > 0) {
    const versionRows = await db
      .select({
        issueId: specVersions.issueId,
        authorId: specVersions.authorId,
        createdAt: specVersions.createdAt,
      })
      .from(specVersions)
      .innerJoin(issues, eq(specVersions.issueId, issues.id))
      .where(
        and(
          inArray(specVersions.issueId, unreviewedIds),
          eq(specVersions.number, issues.specVersion),
        ),
      );
    for (const v of versionRows) specAuthors.set(v.issueId, v);
  }

  // Newest question comment per issue — an approximation used only for
  // ordering (an answered-then-reasked issue sorts slightly off, never
  // in or out of the inbox).
  const questionIds = rows.filter((r) => r.openQuestions > 0).map((r) => r.id);
  const questionTimes = new Map<number, Date>();
  if (questionIds.length > 0) {
    const qRows = await db
      .select({ issueId: comments.issueId, latest: max(comments.createdAt) })
      .from(comments)
      .where(
        and(
          inArray(comments.issueId, questionIds),
          sql`${comments.component}->>'type' = 'questions'`,
        ),
      )
      .groupBy(comments.issueId);
    for (const q of qRows) {
      if (q.latest !== null) questionTimes.set(q.issueId, q.latest);
    }
  }

  const commentLatest = new Map(
    commentCand.flatMap((r) => (r.latest ? [[r.issueId, r.latest]] : [])),
  );
  const eventLatest = new Map(
    eventCand.flatMap((r) => (r.latest ? [[r.issueId, r.latest]] : [])),
  );

  const slice: { item: InboxItem; at: Date }[] = [];
  for (const bundle of bundles) {
    const row = bundle.row;
    const isUnread = unread.has(row.id);
    const specAuthor = specAuthors.get(row.id);
    // Closing an issue retires both pending reasons (T-111), so a closed
    // issue only survives on unread activity of its own — a new foreign
    // comment (or, with the weak toggle on, a foreign event). The flag goes
    // false with it: telling the reader to review a spec on a closed issue
    // is the staleness the card is about.
    const isClosed = bundle.status.category === "closed";
    const pendingSpecReview =
      !isClosed && specAuthor !== undefined && specAuthor.authorId !== userId;
    const openQuestions = isClosed ? 0 : row.openQuestions;
    // Candidates are a slight superset (e.g. an unreviewed spec the caller
    // pushed themself); only rows with a live reason stay.
    if (!isUnread && !pendingSpecReview && openQuestions === 0) continue;
    const unreadComments = counts.get(row.id) ?? 0;
    if (
      !showWeakUnread &&
      isUnread &&
      unreadComments === 0 &&
      !pendingSpecReview &&
      openQuestions === 0
    ) {
      continue;
    }

    const at = [
      commentLatest.get(row.id),
      eventLatest.get(row.id),
      pendingSpecReview ? specAuthor?.createdAt : undefined,
      openQuestions > 0 ? questionTimes.get(row.id) : undefined,
    ]
      .filter((d): d is Date => d !== undefined)
      .reduce((a, b) => (a > b ? a : b), row.updatedAt);

    const { body: _body, ...listItem } = toIssue(bundle);
    slice.push({
      at,
      item: {
        ...listItem,
        unread: isUnread,
        unread_comments: unreadComments,
        project: { slug: project.slug, name: project.name },
        last_activity_at: at.toISOString(),
        pending_spec_review: pendingSpecReview,
      },
    });
  }

  slice.sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    items: slice.slice(0, limit).map((s) => s.item),
    truncated: slice.length > limit,
  };
}

/**
 * Cross-project attention aggregation (T-97): flat, sorted by
 * last_activity_at desc — grouping is the client's business. A project db
 * being unreachable fails the whole request; a silently missing project
 * is worse than a loud error.
 */
export async function getInbox(
  ctx: AppContext,
  actor: UserRow,
  query: InboxQuery,
): Promise<InboxPage> {
  let scope: ProjectRow[];
  if (query.projects === undefined) {
    scope = await accessibleProjectRows(ctx, actor);
  } else {
    scope = [];
    for (const slug of query.projects) {
      const { project } = await requireProject(ctx, actor, slug, "reader");
      scope.push(project);
    }
  }

  const prefs = await readPrefs(ctx.router.system(), actor.id);
  // The full readable set, not `scope`: a request narrowed to two projects
  // still gets to see references from every project its caller can read.
  const visibleSlugs = await visibleSlugsWithHistory(ctx, actor);

  const items: InboxItem[] = [];
  let truncated = false;
  for (const project of scope) {
    const db = await ctx.router.forProject(routeInfoOf(project));
    const slice = await projectInbox(
      ctx,
      db,
      project,
      actor.id,
      query.limit,
      prefs.show_weak_unread,
      visibleSlugs,
    );
    items.push(...slice.items);
    truncated ||= slice.truncated;
  }

  items.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  return { items, truncated };
}
