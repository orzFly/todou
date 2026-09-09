import type {
  AgentContext,
  ChangeEvent,
  CommandSubmitInput,
  CommandSubmitResult,
  IssueListRow,
  TimelineComment,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  comments,
  issueAssignees,
  issueEvents,
  issueLabels,
  issues,
  labels,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers } from "../db/system-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import {
  type CommentRow,
  type HideInTxResult,
  hideCommentsInTx,
  insertCommentInTx,
  requireSettleCapabilities,
  toTimelineComment,
} from "./comments.ts";
import { loadReferenceInputs } from "./cross-references.ts";
import {
  bundleIssues,
  type StatusRow,
  statusEventOf,
  toIssue,
} from "./issues.ts";
import {
  type ReferenceTarget,
  recordCrossReferences,
  resolveContent,
} from "./resolve-pass.ts";
import { assertIssueWritable, gateColumns } from "./trash.ts";
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
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "comment.commands",
  );
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
  const hideIds: number[] = [];
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
      case "comments_hide":
        hideIds.push(...command.comment_ids);
        break;
    }
  }
  if (hideIds.length > 0) {
    // Validated here rather than left to the transaction so a stale id fails
    // the whole submission before the comment is written. The hide endpoint
    // answers 404 for the same mistake; this one answers 422, as it does for
    // every other invalid id in a submission.
    const found = new Set(
      (
        await db
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              eq(comments.issueId, issue.id),
              inArray(comments.id, [...new Set(hideIds)]),
            ),
          )
      ).map((row) => row.id),
    );
    for (const [i, command] of input.commands.entries()) {
      if (command.type !== "comments_hide") continue;
      for (const id of command.comment_ids) {
        if (found.has(id)) continue;
        throw new ValidationFailedError(
          `command[${i}]: comment ${id} is not on this issue`,
        );
      }
      await requireCapability(ctx, actor, slug, "comment.hide");
      await requireSettleCapabilities(ctx, actor, slug, db, issue.id, command);
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
  const resolved =
    body === null
      ? null
      : await resolveContent({
          ctx,
          db,
          project,
          actor,
          inputs: refInputs,
          text: body,
          self: { projectId: project.id, number: issueNumber },
        });
  /**
   * A submission that is nothing but `/hide-all` leaves `updated_at` and the
   * card's place in "recently updated" alone (T-307), or the web command
   * would reorder a list that `todou comment hide` on the same card does
   * not. Counted as sent rather than as applied, because a `/label` naming a
   * label the card already carries bumps the card today and this is not the
   * card that changes that.
   */
  const touched =
    body !== null ||
    input.commands.some((command) => command.type !== "comments_hide");
  const events: ChangeEvent[] = [];
  const commandEvents: ChangeEvent[] = [];
  const hideEvents: ChangeEvent[] = [];
  let crossTargets: ReferenceTarget[] = [];
  /**
   * Where the card sits once the commands have applied (T-279). Filled in by
   * the transaction, because the sets it is read from live there and are
   * mutated as the commands run. Left unset only if the transaction never
   * finished, and then nothing is published at all — but an absent field is
   * the safe reading anyway, so this needs no other guard.
   */
  let listRow: IssueListRow | undefined;

  const applied = await db.transaction(async (tx) => {
    let hide: HideInTxResult | null = null;
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
    if (resolved !== null) {
      const result = await insertCommentInTx(tx, {
        project,
        issue: { id: issue.id, number: issueNumber },
        actorId: actor.id,
        body: resolved.storedText,
        localRefs: resolved.local,
        agentContext,
      });
      comment = result.comment;
      crossTargets = resolved.cross;
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
        case "comments_hide": {
          const result = await hideCommentsInTx(tx, {
            projectId: project.id,
            issueId: issue.id,
            issueNumber,
            actorId: actor.id,
            input: {
              hidden: command.hidden,
              comment_ids: command.comment_ids,
            },
            agentContext,
          });
          // Two of them in one submission apply in order, which is
          // well-defined; the later one's answer is the one to report.
          hide = result;
          hideEvents.push(...result.events);
          break;
        }
      }
    }

    await tx
      .update(issues)
      .set(touched ? { statusId, updatedAt: new Date() } : { statusId })
      .where(eq(issues.id, issue.id));
    if (touched) {
      listRow = {
        kind: "fields",
        status_id: statusId,
        label_ids: [...labeled],
        assignee_ids: [...assigned],
      };
    }
    return { comment, hide };
  });
  const commentRow: CommentRow | null = applied.comment;
  const hide = applied.hide;

  // Comment first, then its events, then the issue row — the order every
  // subscriber already expects from createComment and updateIssue. The hide's
  // own timeline event rides along whatever `touched` says: a hide does
  // change what a default timeline read returns.
  events.push(...commandEvents, ...hideEvents);
  if (touched) {
    events.push({
      entity: "issue",
      id: issue.id,
      action: "updated",
      issue_number: issueNumber,
      list_row: listRow,
    });
  }
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
  const bundle = (await bundleIssues(ctx, db, [project.id], [row], actor))[0];
  if (!bundle) throw new Error("bundle missing");

  let comment: TimelineComment | null = null;
  if (commentRow !== null) {
    comment = await toTimelineComment(ctx, commentRow, { elideHidden: false });
  }
  return {
    comment,
    issue: toIssue(bundle),
    ...(hide === null
      ? {}
      : {
          hide: {
            hidden: hide.hidden,
            unchanged: hide.unchanged,
            ...(hide.settled === null ? {} : { settled: hide.settled }),
          },
        }),
  };
}
