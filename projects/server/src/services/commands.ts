import type {
  AgentContext,
  ChangeEvent,
  CommandInput,
  CommandSubmitInput,
  CommandSubmitResult,
  IssueBulkInput,
  IssueBulkResult,
  IssueListRow,
  TimelineComment,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
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
import { announceBlockChanges, evaluateBlockerStatus } from "./blocks.ts";
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
  const { statusById, labelById, userIds } = await validateFieldCommands(
    ctx,
    db,
    project.id,
    input.commands,
  );
  const hideIds = input.commands.flatMap((command) =>
    command.type === "comments_hide" ? command.comment_ids : [],
  );
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

  const body =
    input.body.trim() === ""
      ? null
      : input.kind === "action"
        ? input.body.trim()
        : input.body;
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

    let comment: CommentRow | null = null;
    if (resolved !== null) {
      const result = await insertCommentInTx(tx, {
        project,
        issue: { id: issue.id, number: issueNumber },
        actorId: actor.id,
        body: resolved.storedText,
        localRefs: resolved.local,
        mentions: resolved.mentions,
        kind: input.kind,
        agentContext,
      });
      comment = result.comment;
      crossTargets = resolved.cross;
      events.push(...result.timeline);
    }

    const fields = await readFieldState(tx, issue.id);
    const statusBefore = fields.statusId;
    const target = {
      tx,
      projectId: project.id,
      issue: { id: issue.id, number: issueNumber },
      actorId: actor.id,
      agentContext,
      statusById,
      labelById,
      userRefs,
      events: commandEvents,
    };
    for (const command of input.commands) {
      if (command.type !== "comments_hide") {
        await applyFieldCommand(target, fields, command);
        continue;
      }
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
    }
    const { statusId, labeled, assigned } = fields;

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
    return { comment, hide, statusChanged: statusId !== statusBefore };
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

  // A `/status` moves the card without passing through `updateIssue`, so the
  // block verdict has to be re-decided from here too (T-377) — otherwise
  // every clearing done by slash command goes unannounced.
  if (applied.statusChanged) {
    const changes = await evaluateBlockerStatus(ctx, project, db, [
      issueNumber,
    ]);
    await announceBlockChanges(ctx, changes, actor.id, agentContext);
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

type FieldCommand = Exclude<CommandInput, { type: "comments_hide" }>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Checks the ids the field commands name and loads what applying them needs.
 * Run before the transaction opens: the membership lookup is a system query,
 * which deadlocks a project transaction under shared placement.
 */
async function validateFieldCommands(
  ctx: AppContext,
  db: Db,
  projectId: number,
  commands: readonly CommandInput[],
) {
  const statusById = new Map(
    (
      await db.select().from(statuses).where(eq(statuses.projectId, projectId))
    ).map((row) => [row.id, row]),
  );
  const labelById = new Map(
    (await db.select().from(labels).where(eq(labels.projectId, projectId))).map(
      (row) => [row.id, row],
    ),
  );
  const userIds = new Set<number>();
  for (const [i, command] of commands.entries()) {
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
              eq(projectMembers.projectId, projectId),
              inArray(projectMembers.userId, [...userIds]),
            ),
          )
      ).map((row) => row.userId),
    );
    for (const [i, command] of commands.entries()) {
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
  return { statusById, labelById, userIds };
}

type FieldState = {
  statusId: number;
  labeled: Set<number>;
  assigned: Set<number>;
};

/**
 * Read inside the transaction, and diffed against as commands apply: the
 * point of incremental semantics is that a concurrent edit by someone else
 * survives this submission.
 */
async function readFieldState(tx: Tx, issueId: number): Promise<FieldState> {
  const rows = await tx
    .select({ statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.id, issueId));
  const statusId = rows[0]?.statusId;
  if (statusId === undefined) throw new NotFoundError("issue not found");
  const assigned = new Set(
    (
      await tx
        .select({ userId: issueAssignees.userId })
        .from(issueAssignees)
        .where(eq(issueAssignees.issueId, issueId))
    ).map((row) => row.userId),
  );
  const labeled = new Set(
    (
      await tx
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .where(eq(issueLabels.issueId, issueId))
    ).map((row) => row.labelId),
  );
  return { statusId, labeled, assigned };
}

type FieldTarget = {
  tx: Tx;
  projectId: number;
  issue: { id: number; number: number };
  actorId: number;
  agentContext: AgentContext | null;
  statusById: Map<number, StatusRow>;
  labelById: Map<number, typeof labels.$inferSelect>;
  userRefs: Map<number, { login: string }>;
  /** Receives one timeline change event per event written. */
  events: ChangeEvent[];
};

/** Applies one command to `state`; one whose effect already holds writes nothing. */
async function applyFieldCommand(
  target: FieldTarget,
  state: FieldState,
  command: FieldCommand,
): Promise<void> {
  const { tx, issue, labelById, userRefs } = target;
  const addEvent = async (
    type: (typeof issueEvents.$inferInsert)["type"],
    payload: Record<string, unknown>,
  ) => {
    const inserted = await tx
      .insert(issueEvents)
      .values({
        projectId: target.projectId,
        issueId: issue.id,
        actorId: target.actorId,
        type,
        payload,
        agentContext: target.agentContext,
      })
      .returning({ id: issueEvents.id });
    const id = inserted[0]?.id;
    if (id !== undefined) {
      target.events.push({
        entity: "timeline",
        id,
        action: "created",
        issue_number: issue.number,
      });
    }
  };
  const labelPayload = (labelId: number) => {
    const label = labelById.get(labelId);
    return {
      label: label
        ? { id: label.id, name: label.name, color: label.color }
        : { id: labelId },
    };
  };
  const userPayload = (userId: number) => ({
    user: { id: userId, login: userRefs.get(userId)?.login ?? "ghost" },
  });

  switch (command.type) {
    case "status": {
      if (command.status_id === state.statusId) return;
      const to = target.statusById.get(command.status_id) as StatusRow;
      const { type, payload } = statusEventOf(
        target.statusById.get(state.statusId),
        to,
      );
      await addEvent(type, payload);
      state.statusId = command.status_id;
      return;
    }
    case "label_add": {
      if (state.labeled.has(command.label_id)) return;
      await tx
        .insert(issueLabels)
        .values({ issueId: issue.id, labelId: command.label_id });
      state.labeled.add(command.label_id);
      await addEvent("label_added", labelPayload(command.label_id));
      return;
    }
    case "label_remove": {
      if (!state.labeled.has(command.label_id)) return;
      await tx
        .delete(issueLabels)
        .where(
          and(
            eq(issueLabels.issueId, issue.id),
            eq(issueLabels.labelId, command.label_id),
          ),
        );
      state.labeled.delete(command.label_id);
      await addEvent("label_removed", labelPayload(command.label_id));
      return;
    }
    case "assign": {
      if (state.assigned.has(command.user_id)) return;
      await tx
        .insert(issueAssignees)
        .values({ issueId: issue.id, userId: command.user_id });
      state.assigned.add(command.user_id);
      await addEvent("assigned", userPayload(command.user_id));
      return;
    }
    case "unassign": {
      if (!state.assigned.has(command.user_id)) return;
      await tx
        .delete(issueAssignees)
        .where(
          and(
            eq(issueAssignees.issueId, issue.id),
            eq(issueAssignees.userId, command.user_id),
          ),
        );
      state.assigned.delete(command.user_id);
      await addEvent("unassigned", userPayload(command.user_id));
      return;
    }
  }
}

/**
 * The same field commands on several cards (T-775), in one transaction:
 * either every card takes them or none does. Behind `issue.triage`, so the
 * only card a caller can be refused is one that is gone or in the trash —
 * a stale selection, better refused whole and refetched than half-applied.
 */
export async function executeBulkCommands(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: IssueBulkInput,
  agentContext: AgentContext | null = null,
): Promise<IssueBulkResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.triage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const numbers = [...new Set(input.numbers)];
  const rows = await db
    .select({ ...gateColumns })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), inArray(issues.number, numbers)),
    );
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const missing = numbers.filter((n) => !byNumber.has(n));
  if (missing.length > 0) {
    throw new NotFoundError(`issues not found: ${missing.join(", ")}`);
  }
  for (const row of rows) assertIssueWritable(row, actor, role);

  const { statusById, labelById, userIds } = await validateFieldCommands(
    ctx,
    db,
    project.id,
    input.commands,
  );
  const userRefs = await getUserRefs(ctx.router.system(), [...userIds]);

  // Ascending, so two bulk requests over overlapping cards take the row
  // locks in one order and cannot deadlock each other on real postgres.
  const ordered = [...rows].sort((a, b) => a.number - b.number);
  const perCard: {
    id: number;
    number: number;
    events: ChangeEvent[];
    listRow: IssueListRow;
  }[] = [];
  const moved: number[] = [];
  await db.transaction(async (tx) => {
    const now = new Date();
    for (const row of ordered) {
      const state = await readFieldState(tx, row.id);
      const statusBefore = state.statusId;
      const events: ChangeEvent[] = [];
      const target: FieldTarget = {
        tx,
        projectId: project.id,
        issue: { id: row.id, number: row.number },
        actorId: actor.id,
        agentContext,
        statusById,
        labelById,
        userRefs,
        events,
      };
      for (const command of input.commands) {
        await applyFieldCommand(target, state, command);
      }
      await tx
        .update(issues)
        .set({ statusId: state.statusId, updatedAt: now })
        .where(eq(issues.id, row.id));
      if (state.statusId !== statusBefore) moved.push(row.number);
      perCard.push({
        id: row.id,
        number: row.number,
        events,
        listRow: {
          kind: "fields",
          status_id: state.statusId,
          label_ids: [...state.labeled],
          assignee_ids: [...state.assigned],
        },
      });
    }
  });

  // Each card's events, then its row: the order `executeCommands` publishes.
  for (const card of perCard) {
    for (const e of card.events) ctx.bus.publish(project.id, e);
    ctx.bus.publish(project.id, {
      entity: "issue",
      id: card.id,
      action: "updated",
      issue_number: card.number,
      list_row: card.listRow,
    });
  }

  if (moved.length > 0) {
    const changes = await evaluateBlockerStatus(ctx, project, db, moved);
    await announceBlockChanges(ctx, changes, actor.id, agentContext);
  }

  const after = await db
    .select()
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), inArray(issues.number, numbers)),
    );
  const bundles = await bundleIssues(ctx, db, [project.id], after, actor);
  const byNumberAfter = new Map(
    bundles.map((bundle) => [bundle.row.number, bundle]),
  );
  return {
    issues: numbers.flatMap((n) => {
      const bundle = byNumberAfter.get(n);
      if (!bundle) return [];
      const { body: _body, ...item } = toIssue(bundle);
      return [item];
    }),
  };
}
