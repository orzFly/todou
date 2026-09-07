import type {
  InboxItem,
  InboxPage,
  InboxQuery,
  InboxRowState,
  MePrefs,
} from "@todou/shared";
import { and, eq, gt, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { ProjectRouteInfo } from "../config.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issueReads,
  issues,
  readFrontiers,
  specVersions,
  statuses,
} from "../db/project-schema.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import {
  crossRefVisibleCondition,
  type VisibleProjects,
  visibleProjects,
} from "./cross-references.ts";
import { bundleIssues, type IssueBundle, toIssue } from "./issues.ts";
import { readPrefs } from "./prefs.ts";
import { ensureFrontiers, frontierJoin, unreadIssueState } from "./reads.ts";
import { live } from "./trash.ts";

type GroupSlice = { items: InboxItem[]; truncated: boolean };

/**
 * What the keep-check already decided about a row, held while the group waits
 * to learn its newest foreign event — `last_activity_at` needs that, and the
 * trimmed path only fetches it for rows that got this far.
 */
type KeptState = {
  isUnread: boolean;
  unreadComments: number;
  pendingSpecReview: boolean;
  openQuestions: number;
  specCreatedAt: Date | undefined;
};

/**
 * Whether one issue belongs in one user's inbox, given the facts about it.
 * Pure and exported because two paths need the same answer from different
 * fetches (T-273): the list below reads its facts in bulk, the per-event
 * judgement on the SSE path reads one card's. A second copy of these rules
 * would drift, and drift here reads as "someone wrote to you and the badge
 * stayed dark".
 *
 * `pendingSpecReview` and `openQuestions` come back out because callers
 * report them: they are what the row says the issue is waiting for.
 */
export function inboxKeepCheck(input: {
  isClosed: boolean;
  isUnread: boolean;
  unreadComments: number;
  /** Author of the current spec version, when it is still unreviewed. */
  specAuthorId: number | null;
  openQuestions: number;
  userId: number;
  showWeakUnread: boolean;
}): { keep: boolean; pendingSpecReview: boolean; openQuestions: number } {
  // Closing an issue retires both pending reasons (T-111), so a closed
  // issue only survives on unread activity of its own — a new foreign
  // comment (or, with the weak toggle on, a foreign event). The flag goes
  // false with it: telling the reader to review a spec on a closed issue
  // is the staleness T-111 is about.
  const pendingSpecReview =
    !input.isClosed &&
    input.specAuthorId !== null &&
    input.specAuthorId !== input.userId;
  const openQuestions = input.isClosed ? 0 : input.openQuestions;
  const result = { pendingSpecReview, openQuestions };

  // Candidates are a slight superset (e.g. an unreviewed spec the caller
  // pushed themself); only issues with a live reason stay.
  if (!input.isUnread && !pendingSpecReview && openQuestions === 0) {
    return { keep: false, ...result };
  }
  // Weak unread is event-only news, which `show_weak_unread` is allowed to
  // hide (T-77). A card someone else just opened never lands here: its top
  // post counts as the first unread comment (T-151).
  if (
    !input.showWeakUnread &&
    input.isUnread &&
    input.unreadComments === 0 &&
    !pendingSpecReview &&
    openQuestions === 0
  ) {
    return { keep: false, ...result };
  }
  return { keep: true, ...result };
}

/**
 * One pass over the projects that share a database (T-278). Every query below
 * spans the whole group, because `project_id = $1` is the only thing that was
 * per-project about them — the rest are keyed by issue id, and issue ids are
 * unique within a database, which is exactly what a group is. Eight projects
 * in one database therefore cost the same fifteen queries as one.
 *
 * `includeEventScan` is separate from `showWeakUnread` on purpose: the first
 * decides whether discovery runs the event scan, the second is a judgement
 * rule. They are not the same question, and the test that pins the trimming
 * needs to vary one without touching the other. `includeEventScan: true` with
 * `showWeakUnread: false` is a safe combination — a wider candidate set,
 * unchanged judgement — which is why pinning the trimming takes no back door
 * into production code.
 *
 * Exported for that test alone; the route reaches it through `getInbox`.
 */
export async function groupInbox(
  ctx: AppContext,
  db: Db,
  projects: ProjectRow[],
  actor: UserRow,
  limit: number,
  showWeakUnread: boolean,
  includeEventScan: boolean,
  visible: VisibleProjects,
): Promise<GroupSlice> {
  const userId = actor.id;
  const projectIds = projects.map((p) => p.id);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  // Before anything reads a threshold: the scans below take the frontier from
  // a join, and a project without a row there loses every one of its issues.
  await ensureFrontiers(db, projectIds, userId);

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
    .leftJoin(readFrontiers, frontierJoin(userId, comments.projectId))
    .where(
      and(
        inArray(comments.projectId, projectIds),
        ne(comments.authorId, userId),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    )
    .groupBy(comments.issueId);

  // Cards opened by someone else, on the comment threshold rather than the
  // event one: the top post counts as a comment (T-151), so the asymmetry
  // above applies to it too. `opened` reaches the event scan as well, but
  // only above the frontier floor — which would drop exactly the cards a
  // stale per-issue position is meant to keep.
  const issueCand = await db
    .select({ issueId: issues.id })
    .from(issues)
    .leftJoin(
      issueReads,
      and(eq(issueReads.issueId, issues.id), eq(issueReads.userId, userId)),
    )
    .leftJoin(readFrontiers, frontierJoin(userId, issues.projectId))
    .where(
      and(
        inArray(issues.projectId, projectIds),
        ne(issues.authorId, userId),
        sql`${issues.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    );

  // Both event scans come off this builder, differing in nothing but the id
  // restriction: the wide one discovers candidates, the narrow one only dates
  // the rows that survived the keep-check. Two spellings of this predicate is
  // how the trimmed path would start reporting timestamps the full path does
  // not, and nothing would say so.
  const eventScan = (onlyIssues?: number[]) =>
    db
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
      .leftJoin(readFrontiers, frontierJoin(userId, issueEvents.projectId))
      .where(
        and(
          inArray(issueEvents.projectId, projectIds),
          ne(issueEvents.actorId, userId),
          gt(issueEvents.createdAt, readFrontiers.frontierAt),
          sql`${issueEvents.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
          crossRefVisibleCondition(visible.slugs, visible.ids),
          onlyIssues === undefined
            ? undefined
            : inArray(issueEvents.issueId, onlyIssues),
        ),
      )
      .groupBy(issueEvents.issueId);

  const eventCand = includeEventScan ? await eventScan() : [];

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
        inArray(issues.projectId, projectIds),
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
    .where(and(inArray(issues.id, ids), live));
  const bundles = await bundleIssues(ctx, db, projectIds, rows, actor);
  const { unread, counts } = await unreadIssueState(
    db,
    projectIds,
    userId,
    ids,
    visible,
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

  const kept: { bundle: IssueBundle; state: KeptState }[] = [];
  for (const bundle of bundles) {
    const row = bundle.row;
    const isUnread = unread.has(row.id);
    const specAuthor = specAuthors.get(row.id);
    const unreadComments = counts.get(row.id) ?? 0;
    const { keep, pendingSpecReview, openQuestions } = inboxKeepCheck({
      isClosed: bundle.status.category === "closed",
      isUnread,
      unreadComments,
      specAuthorId: specAuthor?.authorId ?? null,
      openQuestions: row.openQuestions,
      userId,
      showWeakUnread,
    });
    if (!keep) continue;
    kept.push({
      bundle,
      state: {
        isUnread,
        unreadComments,
        pendingSpecReview,
        openQuestions,
        specCreatedAt: specAuthor?.createdAt,
      },
    });
  }

  // When discovery skipped the event scan, `last_activity_at` still needs the
  // newest foreign event — it just needs it for the handful of rows that
  // stayed, not for every card in the group.
  const eventRows = includeEventScan
    ? eventCand
    : kept.length === 0
      ? []
      : await eventScan(kept.map((k) => k.bundle.row.id));
  const eventLatest = new Map(
    eventRows.flatMap((r) => (r.latest ? [[r.issueId, r.latest]] : [])),
  );

  // `limit` is per project and `truncated` is "some project was cut", so the
  // group's rows split back apart before they are sorted and sliced. One sort
  // over the whole group would let a busy project eat a quiet one's rows.
  const slices = new Map<number, { item: InboxItem; at: Date }[]>();
  for (const { bundle, state } of kept) {
    const row = bundle.row;
    const at = [
      commentLatest.get(row.id),
      eventLatest.get(row.id),
      state.pendingSpecReview ? state.specCreatedAt : undefined,
      state.openQuestions > 0 ? questionTimes.get(row.id) : undefined,
    ]
      .filter((d): d is Date => d !== undefined)
      .reduce((a, b) => (a > b ? a : b), row.updatedAt);

    const project = projectById.get(row.projectId);
    if (!project) throw new Error(`issue ${row.id} is outside the inbox group`);
    const { body: _body, ...listItem } = toIssue(bundle);
    const slice = slices.get(row.projectId) ?? [];
    slice.push({
      at,
      item: {
        ...listItem,
        unread: state.isUnread,
        unread_comments: state.unreadComments,
        project: { slug: project.slug, name: project.name },
        last_activity_at: at.toISOString(),
        pending_spec_review: state.pendingSpecReview,
      },
    });
    slices.set(row.projectId, slice);
  }

  const items: InboxItem[] = [];
  let truncated = false;
  for (const slice of slices.values()) {
    slice.sort((a, b) => b.at.getTime() - a.at.getTime());
    items.push(...slice.slice(0, limit).map((s) => s.item));
    truncated ||= slice.length > limit;
  }
  return { items, truncated };
}

/**
 * The same question as `projectInbox`, asked about one issue: which row does
 * it occupy in this user's inbox right now (T-275)? `null` when it occupies
 * none. Same rules via `inboxKeepCheck`, different fetch — the list scans a
 * project, this reads one card, so the SSE path can tell a receiver what a
 * change did to their inbox without the list's cost.
 *
 * The return type used to be a boolean (T-273). Clients now compare the row
 * against the one they have cached, so the answer has to be the row itself:
 * a change that touches an issue already in the inbox without moving any of
 * these fields needs no refetch, and a boolean cannot say that.
 *
 * `prefs` and `visible` come from the caller because the SSE loop holds a
 * connection-lifetime copy of the visible set; `prefs` it re-reads per
 * judgement, since changing a preference emits no change event to
 * invalidate on.
 */
export async function inboxRowState(
  db: Db,
  project: ProjectRow,
  actor: UserRow,
  issueNumber: number,
  prefs: MePrefs,
  visible: VisibleProjects,
): Promise<InboxRowState | null> {
  const rows = await db
    .select({
      id: issues.id,
      openQuestions: issues.openQuestions,
      specReviewStatus: issues.specReviewStatus,
      specVersion: issues.specVersion,
      updatedAt: issues.updatedAt,
      category: statuses.category,
    })
    .from(issues)
    .innerJoin(statuses, eq(issues.statusId, statuses.id))
    .where(
      and(
        eq(issues.projectId, project.id),
        eq(issues.number, issueNumber),
        // Same choke point as the list's (T-145): a deleted issue is in
        // nobody's inbox, whichever way the caller arrived at it.
        live,
      ),
    );
  const row = rows[0];
  if (!row) return null;

  const { unread, counts } = await unreadIssueState(
    db,
    [project.id],
    actor.id,
    [row.id],
    visible,
  );

  let specAuthorId: number | null = null;
  if (row.specReviewStatus === "unreviewed" && row.specVersion !== null) {
    const versionRows = await db
      .select({ authorId: specVersions.authorId })
      .from(specVersions)
      .where(
        and(
          eq(specVersions.issueId, row.id),
          eq(specVersions.number, row.specVersion),
        ),
      );
    specAuthorId = versionRows[0]?.authorId ?? null;
  }

  const { keep, pendingSpecReview } = inboxKeepCheck({
    isClosed: row.category === "closed",
    isUnread: unread.has(row.id),
    unreadComments: counts.get(row.id) ?? 0,
    specAuthorId,
    openQuestions: row.openQuestions,
    userId: actor.id,
    showWeakUnread: prefs.show_weak_unread,
  });
  if (!keep) return null;

  return {
    updated_at: row.updatedAt.toISOString(),
    unread: unread.has(row.id),
    unread_comments: counts.get(row.id) ?? 0,
    // The two counters come from different places, which is what the
    // InboxItem the client has cached also does: `pending_spec_review` is
    // the keep-check's value, `open_questions` is the raw column, because
    // the list builds it through `toIssue` from `bundle.row.openQuestions`
    // (services/issues.ts). They differ on a closed issue that still holds
    // unanswered questions, and a fingerprint that used the keep-check's
    // zero there would never match the cached row.
    pending_spec_review: pendingSpecReview,
    open_questions: row.openQuestions,
  };
}

/**
 * Run `tasks`, at most `limit` of them in flight, results in input order.
 *
 * The bound is a correctness requirement, not a tuning knob. `DbRouter` keeps
 * at most `database.projects.max_open` project handles and closes the LRU one
 * past that; serially that handle is always idle, but concurrently it could be
 * a handle with queries on it, and closing it cuts them off mid-flight. At or
 * under `max_open` every handle in flight was just touched by `forProject` and
 * so is never the eviction candidate.
 *
 * One task runs exactly as sequentially as a bare `await` would, which is the
 * whole of `placement=shared` — hence no separate serial path to keep in step
 * with this one.
 */
async function inFlight<T>(
  limit: number,
  tasks: (() => Promise<T>)[],
): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < tasks.length; i = next++) {
      const task = tasks[i];
      if (task === undefined) return;
      out[i] = await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return out;
}

/**
 * Cross-project attention aggregation (T-97): flat, sorted by
 * last_activity_at desc — grouping is the client's business. A project db
 * being unreachable fails the whole request; a silently missing project
 * is worse than a loud error.
 *
 * Projects sharing a database are read in one pass, and the groups that remain
 * run concurrently (T-278) — under `placement=shared` that is a single group,
 * so this is the same shape as the loop it replaced.
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
      const { project } = await requireCapability(
        ctx,
        actor,
        slug,
        "inbox.read",
      );
      scope.push(project);
    }
  }

  const prefs = await readPrefs(ctx.router.system(), actor.id);
  // The full readable set, not `scope`: a request narrowed to two projects
  // still gets to see references from every project its caller can read.
  const visible = await visibleProjects(ctx, actor);

  // Projects that resolve to one database are one unit of work: they can be
  // read in a single pass, and `forProject` needs opening only once for the
  // whole group (any member resolves to the same url).
  const groups = new Map<
    string,
    { route: ProjectRouteInfo; projects: ProjectRow[] }
  >();
  for (const project of scope) {
    const route = routeInfoOf(project);
    const url = ctx.router.resolveProjectUrl(route);
    const group = groups.get(url);
    if (group) group.projects.push(project);
    else groups.set(url, { route, projects: [project] });
  }

  const slices = await inFlight(
    ctx.config.database.projects.max_open,
    [...groups.values()].map((group) => async (): Promise<GroupSlice> => {
      const db = await ctx.router.forProject(group.route);
      return groupInbox(
        ctx,
        db,
        group.projects,
        actor,
        query.limit,
        prefs.show_weak_unread,
        // With weak unread hidden, the event scan cannot turn up a row that
        // survives: the three surviving reasons — unread comments, a spec
        // awaiting the reader, open questions — are each found by one of the
        // other scans, and an event-only card falls at the second guard. So
        // the scan runs only when weak unread is on. This is derived from
        // `inboxKeepCheck`, which means a new event-dependent reason silently
        // invalidates it; "trimming discovers the same page" in
        // test/inbox.test.ts is the guard that turns red instead.
        prefs.show_weak_unread,
        visible,
      );
    }),
  );

  const items = slices.flatMap((s) => s.items);
  items.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  return { items, truncated: slices.some((s) => s.truncated) };
}
