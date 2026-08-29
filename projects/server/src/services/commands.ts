import type {
  AgentContext,
  ChangeEvent,
  CommandSubmitInput,
  CommandSubmitResult,
  TimelineComment,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  issueAssignees,
  issueEvents,
  issueLabels,
  issues,
  labels,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers } from "../db/system-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import {
  type CommentRow,
  insertCommentInTx,
  toTimelineComment,
} from "./comments.ts";
import {
  type CrossTarget,
  loadReferenceInputs,
  recordCrossReferences,
} from "./cross-references.ts";
import {
  bundleIssues,
  type StatusRow,
  statusEventOf,
  toIssue,
} from "./issues.ts";
import { assertIssueWritable } from "./trash.ts";
import { getUserRefs } from "./users.ts";

/**
 * One submission from the web composer (T-161): an optional comment body plus
 * incremental field commands compiled from `/close`-style draft lines, all in
 * a single transaction. Half-completion is the thing this endpoint exists to
 * rule out — a comment that landed while its `/close` failed would leave the
 * issue in a state nobody asked for, with only a toast to say so.
 *
 * Commands are incremental (add this label, drop this assignee), unlike
 * `PATCH issue`, whose `label_ids` / `assignee_ids` replace the whole set.
 */
export async function executeCommands(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: CommandSubmitInput,
  agentContext: AgentContext | null = null,
): Promise<CommandSubmitResult> {
  const { project, role } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({
      id: issues.id,
      number: issues.number,
      authorId: issues.authorId,
      deletedAt: issues.deletedAt,
    })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");
  assertIssueWritable(issue, actor, role);

  // Validate and prefetch BEFORE the transaction opens: in shared placement
  // both tiers share one PGlite connection, so a system query issued inside
  // the project transaction would deadlock it (same rule as updateIssue).
  const statusById = new Map(
    (
      await db.select().from(statuses).where(eq(statuses.projectId, project.id))
    ).map((row) => [row.id, row]),
  );
  const labelById = new Map(
    (
      await db.select().from(labels).where(eq(labels.projectId, project.id))
    ).map((row) => [row.id, row]),
  );
  const userIds = new Set<number>();
  for (const [i, command] of input.commands.entries()) {
    const at = `command[${i}]`;
    switch (command.type) {
      case "status":
        if (!statusById.has(command.status_id)) {
          throw new ValidationFailedError(`${at}: unknown status_id`);
        }
        break;
      case "label_add":
      case "label_remove":
        if (!labelById.has(command.label_id)) {
          throw new ValidationFailedError(`${at}: unknown label_id`);
        }
        break;
      case "assign":
      case "unassign":
        userIds.add(command.user_id);
        break;
    }
  }
  if (userIds.size > 0) {
    const members = new Set(
      (
        await ctx.router
          .system()
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, project.id),
              inArray(projectMembers.userId, [...userIds]),
            ),
          )
      ).map((row) => row.userId),
    );
    for (const [i, command] of input.commands.entries()) {
      if (
        (command.type === "assign" || command.type === "unassign") &&
        !members.has(command.user_id)
      ) {
        throw new ValidationFailedError(
          `command[${i}]: user_id must be a project member`,
        );
      }
    }
  }
  const currentAssignees = (
    await db
      .select({ userId: issueAssignees.userId })
      .from(issueAssignees)
      .where(eq(issueAssignees.issueId, issue.id))
  ).map((row) => row.userId);
  const userRefs = await getUserRefs(ctx.router.system(), [
    ...new Set([...currentAssignees, ...userIds]),
  ]);
  const refInputs = await loadReferenceInputs(ctx, db, project.id);

  const body = input.body.trim() === "" ? null : input.body;
  const events: ChangeEvent[] = [];
  const commandEvents: ChangeEvent[] = [];
  let crossTargets: CrossTarget[] = [];

  const commentRow: CommentRow | null = await db.transaction(async (tx) => {
    const addEvent = async (
      type: (typeof issueEvents.$inferInsert)["type"],
      payload: Record<string, unknown>,
    ) => {
      const inserted = await tx
        .insert(issueEvents)
        .values({
          projectId: project.id,
          issueId: issue.id,
          actorId: actor.id,
          type,
          payload,
          agentContext,
        })
        .returning({ id: issueEvents.id });
      const id = inserted[0]?.id;
      if (id !== undefined) {
        commandEvents.push({
          entity: "timeline",
          id,
          action: "created",
          issue_number: issueNumber,
        });
      }
    };

    let comment: CommentRow | null = null;
    if (body !== null) {
      const result = await insertCommentInTx(tx, {
        project,
        issue: { id: issue.id, number: issueNumber },
        actorId: actor.id,
        body,
        agentContext,
        refInputs,
      });
      comment = result.comment;
      crossTargets = result.crossTargets;
      events.push(...result.timeline);
    }

    // Read the sets being mutated inside the transaction and diff against
    // them as commands apply: the point of incremental semantics is that a
    // concurrent edit by someone else survives this submission.
    const rows = await tx
      .select({ statusId: issues.statusId })
      .from(issues)
      .where(eq(issues.id, issue.id));
    let statusId = rows[0]?.statusId;
    if (statusId === undefined) throw new NotFoundError("issue not found");
    const assigned = new Set(
      (
        await tx
          .select({ userId: issueAssignees.userId })
          .from(issueAssignees)
          .where(eq(issueAssignees.issueId, issue.id))
      ).map((row) => row.userId),
    );
    const labeled = new Set(
      (
        await tx
          .select({ labelId: issueLabels.labelId })
          .from(issueLabels)
          .where(eq(issueLabels.issueId, issue.id))
      ).map((row) => row.labelId),
    );

    for (const command of input.commands) {
      switch (command.type) {
        case "status": {
          if (command.status_id === statusId) break;
          const to = statusById.get(command.status_id) as StatusRow;
          const { type, payload } = statusEventOf(statusById.get(statusId), to);
          await addEvent(type, payload);
          statusId = command.status_id;
          break;
        }
        case "label_add": {
          if (labeled.has(command.label_id)) break;
          await tx
            .insert(issueLabels)
            .values({ issueId: issue.id, labelId: command.label_id });
          labeled.add(command.label_id);
          const label = labelById.get(command.label_id);
          await addEvent("label_added", {
            label: label
              ? { id: label.id, name: label.name, color: label.color }
              : { id: command.label_id },
          });
          break;
        }
        case "label_remove": {
          if (!labeled.has(command.label_id)) break;
          await tx
            .delete(issueLabels)
            .where(
              and(
                eq(issueLabels.issueId, issue.id),
                eq(issueLabels.labelId, command.label_id),
              ),
            );
          labeled.delete(command.label_id);
          const label = labelById.get(command.label_id);
          await addEvent("label_removed", {
            label: label
              ? { id: label.id, name: label.name, color: label.color }
              : { id: command.label_id },
          });
          break;
        }
        case "assign": {
          if (assigned.has(command.user_id)) break;
          await tx
            .insert(issueAssignees)
            .values({ issueId: issue.id, userId: command.user_id });
          assigned.add(command.user_id);
          await addEvent("assigned", {
            user: {
              id: command.user_id,
              login: userRefs.get(command.user_id)?.login ?? "ghost",
            },
          });
          break;
        }
        case "unassign": {
          if (!assigned.has(command.user_id)) break;
          await tx
            .delete(issueAssignees)
            .where(
              and(
                eq(issueAssignees.issueId, issue.id),
                eq(issueAssignees.userId, command.user_id),
              ),
            );
          assigned.delete(command.user_id);
          await addEvent("unassigned", {
            user: {
              id: command.user_id,
              login: userRefs.get(command.user_id)?.login ?? "ghost",
            },
          });
          break;
        }
      }
    }

    await tx
      .update(issues)
      .set({ statusId, updatedAt: new Date() })
      .where(eq(issues.id, issue.id));
    return comment;
  });

  // Comment first, then its events, then the issue row — the order every
  // subscriber already expects from createComment and updateIssue.
  events.push(...commandEvents, {
    entity: "issue",
    id: issue.id,
    action: "updated",
    issue_number: issueNumber,
  });
  for (const e of events) ctx.bus.publish(project.id, e);
  if (commentRow !== null) {
    await recordCrossReferences(
      ctx,
      actor,
      project,
      { issueNumber, commentId: commentRow.id },
      crossTargets,
      agentContext,
    );
  }

  const after = await db.select().from(issues).where(eq(issues.id, issue.id));
  const row = after[0];
  if (!row) throw new NotFoundError("issue not found");
  const bundle = (await bundleIssues(ctx, db, project.id, [row]))[0];
  if (!bundle) throw new Error("bundle missing");

  let comment: TimelineComment | null = null;
  if (commentRow !== null) comment = await toTimelineComment(ctx, commentRow);
  return { comment, issue: toIssue(bundle) };
}
