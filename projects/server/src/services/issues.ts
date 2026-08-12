import type {
  AgentContext,
  ChangeEvent,
  Issue,
  IssueCounts,
  IssueCountsQuery,
  IssueCreateInput,
  IssueListQuery,
  IssueUpdateInput,
  Label,
  Status,
  UserRef,
} from "@todou/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  issueAssignees,
  issueEvents,
  issueLabels,
  issues,
  labels,
  projectMeta,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers } from "../db/system-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { type ProjectRow, requireProject, routeInfoOf } from "./access.ts";
import { toLabel } from "./labels.ts";
import { unreadIssueIds } from "./reads.ts";
import { recordReferences } from "./references.ts";
import { recordRevision } from "./revisions.ts";
import { toStatus } from "./statuses.ts";
import { getUserRefs } from "./users.ts";

type IssueRow = typeof issues.$inferSelect;

export type IssueBundle = {
  row: IssueRow;
  status: Status;
  labels: Label[];
  assignees: UserRef[];
  author: UserRef;
};

function toIssue(bundle: IssueBundle): Issue {
  return {
    id: bundle.row.id,
    number: bundle.row.number,
    title: bundle.row.title,
    body: bundle.row.body,
    status: bundle.status,
    author: bundle.author,
    assignees: bundle.assignees,
    labels: bundle.labels,
    created_at: bundle.row.createdAt.toISOString(),
    updated_at: bundle.row.updatedAt.toISOString(),
    body_edited_at: bundle.row.bodyEditedAt?.toISOString() ?? null,
    open_questions: bundle.row.openQuestions,
    spec_version: bundle.row.specVersion,
    spec_review_status: bundle.row.specReviewStatus,
    spec_unresolved_comments: bundle.row.specUnresolvedComments,
    // Per-viewer field; only listIssues overrides it (#46).
    unread: false,
  };
}

async function loadIssueRow(
  db: Db,
  projectId: number,
  number: number,
): Promise<IssueRow> {
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row;
}

/** Bulk-assemble DTO parts for a set of issue rows (2 project-db queries). */
async function bundleIssues(
  ctx: AppContext,
  db: Db,
  projectId: number,
  rows: IssueRow[],
): Promise<IssueBundle[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const statusRows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId));
  const statusById = new Map(statusRows.map((s) => [s.id, toStatus(s)]));

  const labelRows = await db
    .select({ issueId: issueLabels.issueId, label: labels })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, ids));
  const assigneeRows = await db
    .select()
    .from(issueAssignees)
    .where(inArray(issueAssignees.issueId, ids));

  const refIds = [
    ...rows.map((r) => r.authorId),
    ...assigneeRows.map((a) => a.userId),
  ];
  const refs = await getUserRefs(ctx.router.system(), refIds);
  const ghost = (id: number): UserRef => ({
    id,
    login: "ghost",
    display_name: "Deleted user",
    kind: "human",
    avatar_url: null,
    owner: null,
  });

  return rows.map((row) => {
    const status = statusById.get(row.statusId);
    if (!status) throw new Error(`issue ${row.id} has unknown status`);
    return {
      row,
      status,
      labels: labelRows
        .filter((l) => l.issueId === row.id)
        .map((l) => toLabel(l.label)),
      assignees: assigneeRows
        .filter((a) => a.issueId === row.id)
        .map((a) => refs.get(a.userId) ?? ghost(a.userId)),
      author: refs.get(row.authorId) ?? ghost(row.authorId),
    };
  });
}

async function validateStatusId(
  db: Db,
  projectId: number,
  statusId: number,
): Promise<Status> {
  const rows = await db
    .select()
    .from(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)));
  const row = rows[0];
  if (!row) throw new ValidationFailedError("unknown status_id");
  return toStatus(row);
}

async function validateLabelIds(
  db: Db,
  projectId: number,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.projectId, projectId), inArray(labels.id, ids)));
  if (rows.length !== new Set(ids).size) {
    throw new ValidationFailedError("unknown label_ids");
  }
}

async function validateAssigneeIds(
  ctx: AppContext,
  projectId: number,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await ctx.router
    .system()
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.userId, ids),
      ),
    );
  if (rows.length !== new Set(ids).size) {
    throw new ValidationFailedError("assignees must be project members");
  }
}

export async function createIssue(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: IssueCreateInput,
  agentContext: AgentContext | null = null,
): Promise<Issue> {
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));

  await validateLabelIds(db, project.id, input.label_ids);
  await validateAssigneeIds(ctx, project.id, input.assignee_ids);

  let statusId = input.status_id;
  if (statusId === undefined) {
    // The project's default status wins; without one, first by position.
    const first = await db
      .select({ id: statuses.id })
      .from(statuses)
      .where(eq(statuses.projectId, project.id))
      .orderBy(
        desc(statuses.isDefault),
        asc(statuses.position),
        asc(statuses.id),
      )
      .limit(1);
    statusId = first[0]?.id;
    if (statusId === undefined) {
      throw new ValidationFailedError("project has no statuses");
    }
  } else {
    await validateStatusId(db, project.id, statusId);
  }

  const events: ChangeEvent[] = [];
  const row = await db.transaction(async (tx) => {
    const meta = await tx
      .update(projectMeta)
      .set({ nextIssueNumber: sql`${projectMeta.nextIssueNumber} + 1` })
      .where(eq(projectMeta.projectId, project.id))
      .returning({ next: projectMeta.nextIssueNumber });
    const next = meta[0]?.next;
    if (next === undefined) throw new Error("project_meta row missing");
    const number = next - 1;

    const inserted = await tx
      .insert(issues)
      .values({
        projectId: project.id,
        number,
        title: input.title,
        body: input.body,
        statusId: statusId as number,
        authorId: actor.id,
      })
      .returning();
    const issue = inserted[0];
    if (!issue) throw new Error("issue insert returned no row");

    if (input.assignee_ids.length > 0) {
      await tx
        .insert(issueAssignees)
        .values(
          input.assignee_ids.map((userId) => ({ issueId: issue.id, userId })),
        );
    }
    if (input.label_ids.length > 0) {
      await tx
        .insert(issueLabels)
        .values(
          input.label_ids.map((labelId) => ({ issueId: issue.id, labelId })),
        );
    }
    const opened = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "opened",
        payload: {},
        agentContext,
      })
      .returning({ id: issueEvents.id });

    events.push({
      entity: "issue",
      id: issue.id,
      action: "created",
      issue_number: number,
    });
    const openedId = opened[0]?.id;
    if (openedId !== undefined) {
      events.push({
        entity: "timeline",
        id: openedId,
        action: "created",
        issue_number: number,
      });
    }

    const refs = await recordReferences(
      tx,
      project.id,
      actor.id,
      { issueNumber: number },
      input.body,
      agentContext,
    );
    for (const ref of refs) {
      events.push({
        entity: "timeline",
        id: ref.eventId,
        action: "created",
        issue_number: ref.issueNumber,
      });
    }
    return issue;
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  const bundles = await bundleIssues(ctx, db, project.id, [row]);
  const bundle = bundles[0];
  if (!bundle) throw new Error("bundle missing");
  return toIssue(bundle);
}

export async function getIssue(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
): Promise<Issue> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const row = await loadIssueRow(db, project.id, number);
  const bundle = (await bundleIssues(ctx, db, project.id, [row]))[0];
  if (!bundle) throw new Error("bundle missing");
  return toIssue(bundle);
}

type ListCursor = { v: string | number; i: number };

function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): ListCursor {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString()) as ListCursor;
  } catch {
    throw new ValidationFailedError("malformed cursor");
  }
}

/**
 * WHERE clauses for the category-neutral list filters, shared by list and
 * counts. Returns null when a filter provably matches nothing.
 */
async function issueFilterConditions(
  db: Db,
  projectId: number,
  query: IssueCountsQuery,
): Promise<SQL[] | null> {
  const conditions: SQL[] = [eq(issues.projectId, projectId)];

  if (query.status !== undefined) {
    conditions.push(inArray(issues.statusId, query.status));
  }
  if (query.label !== undefined) {
    // Any-of semantics for multi-label filters.
    const tagged = await db
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .where(inArray(issueLabels.labelId, query.label));
    const ids = [...new Set(tagged.map((t) => t.issueId))];
    if (ids.length === 0) return null;
    conditions.push(inArray(issues.id, ids));
  }
  if (query.assignee !== undefined) {
    const assigned = await db
      .select({ issueId: issueAssignees.issueId })
      .from(issueAssignees)
      .where(eq(issueAssignees.userId, query.assignee));
    const ids = assigned.map((a) => a.issueId);
    if (ids.length === 0) return null;
    conditions.push(inArray(issues.id, ids));
  }
  if (query.q !== undefined && query.q !== "") {
    const pattern = `%${query.q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const textMatch = or(
      ilike(issues.title, pattern),
      ilike(issues.body, pattern),
    );
    if (textMatch) conditions.push(textMatch);
  }
  return conditions;
}

export async function listIssues(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: IssueListQuery,
): Promise<{ items: Issue[]; next_cursor: string | null }> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const sortColumn = {
    created: issues.createdAt,
    updated: issues.updatedAt,
    number: issues.number,
  }[query.sort];
  const direction = query.order === "asc" ? asc : desc;
  const beyond = query.order === "asc" ? gt : lt;

  const conditions = await issueFilterConditions(db, project.id, query);
  if (conditions === null) return { items: [], next_cursor: null };

  if (query.numbers !== undefined) {
    conditions.push(inArray(issues.number, query.numbers));
  }
  if (query.category !== undefined) {
    const catStatuses = await db
      .select({ id: statuses.id })
      .from(statuses)
      .where(
        and(
          eq(statuses.projectId, project.id),
          eq(statuses.category, query.category),
        ),
      );
    const ids = catStatuses.map((s) => s.id);
    if (ids.length === 0) return { items: [], next_cursor: null };
    conditions.push(inArray(issues.statusId, ids));
  }
  if (query.cursor !== undefined) {
    const cur = decodeCursor(query.cursor);
    const value =
      query.sort === "number" ? Number(cur.v) : new Date(String(cur.v));
    const tie = and(eq(sortColumn, value), beyond(issues.id, cur.i));
    const advance = or(beyond(sortColumn, value), tie);
    if (advance) conditions.push(advance);
  }

  const rows = await db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(direction(sortColumn), direction(issues.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const next_cursor =
    rows.length > query.limit && last
      ? encodeCursor({
          v:
            query.sort === "number"
              ? last.number
              : (query.sort === "created"
                  ? last.createdAt
                  : last.updatedAt
                ).toISOString(),
          i: last.id,
        })
      : null;

  const bundles = await bundleIssues(ctx, db, project.id, page);
  const unread = await unreadIssueIds(
    db,
    project.id,
    actor.id,
    page.map((r) => r.id),
  );
  return {
    items: bundles.map((b) => ({
      ...toIssue(b),
      unread: unread.has(b.row.id),
    })),
    next_cursor,
  };
}

export async function countIssuesByCategory(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: IssueCountsQuery,
): Promise<IssueCounts> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));

  const counts: IssueCounts = { open: 0, closed: 0 };
  const conditions = await issueFilterConditions(db, project.id, query);
  if (conditions === null) return counts;

  const rows = await db
    .select({ category: statuses.category, count: sql<number>`count(*)` })
    .from(issues)
    .innerJoin(statuses, eq(issues.statusId, statuses.id))
    .where(and(...conditions))
    .groupBy(statuses.category);
  for (const row of rows) counts[row.category] = Number(row.count);
  return counts;
}

export async function updateIssue(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  input: IssueUpdateInput,
  agentContext: AgentContext | null = null,
): Promise<Issue> {
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const before = await loadIssueRow(db, project.id, number);

  if (input.label_ids !== undefined) {
    await validateLabelIds(db, project.id, input.label_ids);
  }
  if (input.assignee_ids !== undefined) {
    await validateAssigneeIds(ctx, project.id, input.assignee_ids);
  }

  const statusRows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id));
  const statusById = new Map(statusRows.map((s) => [s.id, s]));
  if (input.status_id !== undefined && !statusById.has(input.status_id)) {
    throw new ValidationFailedError("unknown status_id");
  }

  // Pre-read project-db state and PREFETCH all system-db lookups here: in
  // shared placement both tiers share one PGlite connection, so a system
  // query issued inside the project transaction would deadlock it.
  const currentAssignees = new Set(
    (
      await db
        .select()
        .from(issueAssignees)
        .where(eq(issueAssignees.issueId, before.id))
    ).map((a) => a.userId),
  );
  const desiredAssignees = new Set(input.assignee_ids ?? []);
  const assigneeRefs =
    input.assignee_ids === undefined
      ? new Map()
      : await getUserRefs(ctx.router.system(), [
          ...new Set([...currentAssignees, ...desiredAssignees]),
        ]);

  const events: ChangeEvent[] = [];
  const pushTimeline = (eventId: number | undefined) => {
    if (eventId !== undefined) {
      events.push({
        entity: "timeline",
        id: eventId,
        action: "created",
        issue_number: number,
      });
    }
  };

  await db.transaction(async (tx) => {
    const addEvent = async (
      type: (typeof issueEvents.$inferInsert)["type"],
      payload: Record<string, unknown>,
    ) => {
      const inserted = await tx
        .insert(issueEvents)
        .values({
          projectId: project.id,
          issueId: before.id,
          actorId: actor.id,
          type,
          payload,
          agentContext,
        })
        .returning({ id: issueEvents.id });
      pushTimeline(inserted[0]?.id);
    };

    if (input.title !== undefined && input.title !== before.title) {
      await addEvent("title_changed", {
        from: before.title,
        to: input.title,
      });
    }

    if (input.status_id !== undefined && input.status_id !== before.statusId) {
      const from = statusById.get(before.statusId);
      const to = statusById.get(input.status_id);
      if (!to) throw new ValidationFailedError("unknown status_id");
      const payload = {
        from: from ? { id: from.id, name: from.name } : null,
        to: { id: to.id, name: to.name },
      };
      const type =
        from?.category !== "closed" && to.category === "closed"
          ? "closed"
          : from?.category === "closed" && to.category === "open"
            ? "reopened"
            : "status_changed";
      await addEvent(type, payload);
    }

    if (input.assignee_ids !== undefined) {
      const current = currentAssignees;
      const desired = desiredAssignees;
      const refs = assigneeRefs;
      for (const userId of desired) {
        if (!current.has(userId)) {
          await tx
            .insert(issueAssignees)
            .values({ issueId: before.id, userId });
          const ref = refs.get(userId);
          await addEvent("assigned", {
            user: { id: userId, login: ref?.login ?? "ghost" },
          });
        }
      }
      for (const userId of current) {
        if (!desired.has(userId)) {
          await tx
            .delete(issueAssignees)
            .where(
              and(
                eq(issueAssignees.issueId, before.id),
                eq(issueAssignees.userId, userId),
              ),
            );
          const ref = refs.get(userId);
          await addEvent("unassigned", {
            user: { id: userId, login: ref?.login ?? "ghost" },
          });
        }
      }
    }

    if (input.label_ids !== undefined) {
      const currentRows = await tx
        .select({ labelId: issueLabels.labelId, label: labels })
        .from(issueLabels)
        .innerJoin(labels, eq(issueLabels.labelId, labels.id))
        .where(eq(issueLabels.issueId, before.id));
      const current = new Map(currentRows.map((r) => [r.labelId, r.label]));
      const desired = new Set(input.label_ids);
      const allLabels = await tx
        .select()
        .from(labels)
        .where(eq(labels.projectId, project.id));
      const labelById = new Map(allLabels.map((l) => [l.id, l]));

      for (const labelId of desired) {
        if (!current.has(labelId)) {
          await tx.insert(issueLabels).values({ issueId: before.id, labelId });
          const label = labelById.get(labelId);
          await addEvent("label_added", {
            label: label
              ? { id: label.id, name: label.name, color: label.color }
              : { id: labelId },
          });
        }
      }
      for (const [labelId, label] of current) {
        if (!desired.has(labelId)) {
          await tx
            .delete(issueLabels)
            .where(
              and(
                eq(issueLabels.issueId, before.id),
                eq(issueLabels.labelId, labelId),
              ),
            );
          await addEvent("label_removed", {
            label: { id: label.id, name: label.name, color: label.color },
          });
        }
      }
    }

    const patch: Partial<typeof issues.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.body !== undefined) patch.body = input.body;
    if (input.status_id !== undefined) patch.statusId = input.status_id;
    if (input.body !== undefined && input.body !== before.body) {
      // History, not timeline: body edits record a revision (the
      // superseded text) and deliberately emit no event.
      await recordRevision(tx, {
        projectId: project.id,
        subjectType: "issue_body",
        subjectId: before.id,
        body: before.body,
        actorId: actor.id,
        agentContext,
      });
      patch.bodyEditedAt = new Date();
    }
    await tx.update(issues).set(patch).where(eq(issues.id, before.id));

    if (input.body !== undefined && input.body !== before.body) {
      const refs = await recordReferences(
        tx,
        project.id,
        actor.id,
        { issueNumber: number },
        input.body,
        agentContext,
      );
      for (const ref of refs) {
        events.push({
          entity: "timeline",
          id: ref.eventId,
          action: "created",
          issue_number: ref.issueNumber,
        });
      }
    }
  });

  events.push({
    entity: "issue",
    id: before.id,
    action: "updated",
    issue_number: number,
  });
  for (const e of events) ctx.bus.publish(project.id, e);

  const after = await loadIssueRow(db, project.id, number);
  const bundle = (await bundleIssues(ctx, db, project.id, [after]))[0];
  if (!bundle) throw new Error("bundle missing");
  return toIssue(bundle);
}

export async function requireIssueProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  minRole: "reader" | "writer" | "admin",
): Promise<{ project: ProjectRow; db: Db }> {
  const { project } = await requireProject(ctx, actor, slug, minRole);
  const db = await ctx.router.forProject(routeInfoOf(project));
  return { project, db };
}
