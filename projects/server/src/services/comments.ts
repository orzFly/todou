import type {
  AgentContext,
  ChangeEvent,
  CommentComponent,
  CommentCreateInput,
  CommentCreateResult,
  CommentHideInput,
  CommentHideResult,
  CommentLocation,
  CommentUpdateInput,
  SettledByHide,
  TimelineComment,
} from "@todou/shared";
import { formatRef, QuestionAnsweredPayload } from "@todou/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import {
  type ProjectRow,
  projectForRead,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import { loadReferenceInputs } from "./cross-references.ts";
import { encodeTimelineCursor } from "./cursor.ts";
import {
  answerEventFor,
  canonicalizeComponent,
  questionCount,
} from "./questions.ts";
import { refPrefixAt } from "./references.ts";
import { throwIfCommentAliased } from "./relocation.ts";
import {
  recordCrossReferences,
  recordLocalReferences,
  resolveContent,
} from "./resolve-pass.ts";
import { deleteRevisionsFor, recordRevision } from "./revisions.ts";
import { microIso } from "./timeline.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

export type CommentRow = typeof comments.$inferSelect;

/**
 * `opts.elideHidden` has no default on purpose (T-281). Whether a response
 * carries a hidden comment's body is the whole of the feature, so every
 * caller has to say which side of the rule it is on rather than inherit an
 * answer — and asking for one comment by id is always the "not elided" side.
 */
export async function toTimelineComment(
  ctx: AppContext,
  row: CommentRow,
  opts: { elideHidden: boolean },
): Promise<TimelineComment> {
  const refs = await getUserRefs(ctx.router.system(), [row.authorId]);
  const author = refs.get(row.authorId);
  if (!author) throw new Error("author ref missing");
  return {
    type: "comment",
    id: row.id,
    author,
    body: opts.elideHidden && row.hiddenAt !== null ? "" : row.body,
    component: row.component ?? null,
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt?.toISOString() ?? null,
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    hidden_at: row.hiddenAt?.toISOString() ?? null,
    agent_context: row.agentContext ?? null,
  };
}

async function loadIssue(db: Db, projectId: number, number: number) {
  const rows = await db
    .select({
      ...gateColumns,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row;
}

/**
 * Insert a comment row inside an open transaction: the row itself, the
 * issue's `updated_at` (plus the open-question counter), the local reference
 * events and the timeline ChangeEvents it produces. Shared by `createComment`
 * and the atomic command endpoint (T-161), which needs a comment and a set of
 * field changes to land or roll back together.
 *
 * `body` arrives already resolved and `localRefs` comes from the same pass,
 * because resolving reads the system database and other projects' — which a
 * project transaction must not hold a second connection for.
 */
export async function insertCommentInTx(
  tx: Db,
  args: {
    project: ProjectRow;
    issue: { id: number; number: number };
    actorId: number;
    body: string;
    localRefs: number[];
    component?: CommentComponent | null;
    agentContext: AgentContext | null;
  },
): Promise<{
  comment: CommentRow;
  /** Publish after commit; the comment leads, subscribers pin that. */
  timeline: ChangeEvent[];
}> {
  const { project, issue, actorId, body, agentContext, localRefs } = args;
  const component = args.component ?? null;
  const issueNumber = issue.number;

  const inserted = await tx
    .insert(comments)
    .values({
      projectId: project.id,
      issueId: issue.id,
      authorId: actorId,
      body,
      component,
      agentContext,
    })
    .returning();
  const comment = inserted[0];
  if (!comment) throw new Error("comment insert returned no row");

  const asked = questionCount(component);
  await tx
    .update(issues)
    .set(
      asked > 0
        ? {
            openQuestions: sql`${issues.openQuestions} + ${asked}`,
            updatedAt: new Date(),
          }
        : { updatedAt: new Date() },
    )
    .where(eq(issues.id, issue.id));

  const timeline: ChangeEvent[] = [
    {
      entity: "timeline",
      id: comment.id,
      action: "created",
      issue_number: issueNumber,
    },
  ];

  const refs = await recordLocalReferences(
    tx,
    project,
    actorId,
    { issueNumber, commentId: comment.id },
    localRefs,
    agentContext,
  );
  for (const ref of refs) {
    timeline.push({
      entity: "timeline",
      id: ref.eventId,
      action: "created",
      issue_number: ref.issueNumber,
    });
  }
  return { comment, timeline };
}

export async function createComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: CommentCreateInput,
  agentContext: AgentContext | null = null,
): Promise<CommentCreateResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "comment.create",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const component =
    input.component === undefined
      ? null
      : canonicalizeComponent(input.component);

  const refInputs = await loadReferenceInputs(ctx, db, project.id);
  const resolved = await resolveContent({
    ctx,
    db,
    project,
    actor,
    inputs: refInputs,
    text: input.body,
    self: { projectId: project.id, number: issueNumber },
  });
  const events: ChangeEvent[] = [];
  const { row, ts } = await db.transaction(async (tx) => {
    const result = await insertCommentInTx(tx, {
      project,
      issue: { id: issue.id, number: issueNumber },
      actorId: actor.id,
      body: resolved.storedText,
      localRefs: resolved.local,
      component,
      agentContext,
    });
    events.push(...result.timeline);
    // updated_at moved (and maybe the counter) → issue list ordering and
    // badges must refresh.
    events.push({
      entity: "issue",
      id: issue.id,
      action: "updated",
      issue_number: issueNumber,
      list_row: { kind: "activity" },
    });
    // Read back at µs precision rather than reusing the row's Date, which
    // holds milliseconds: a cursor that cannot separate two entries of the
    // same millisecond either repeats one or drops one.
    const [position] = await tx
      .select({ ts: microIso(comments.createdAt) })
      .from(comments)
      .where(eq(comments.id, result.comment.id));
    if (!position) throw new Error("comment row vanished mid-insert");
    return { row: result.comment, ts: position.ts };
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  await recordCrossReferences(
    ctx,
    actor,
    project,
    { issueNumber, commentId: row.id },
    resolved.cross,
    agentContext,
  );
  return {
    ...(await toTimelineComment(ctx, row, { elideHidden: false })),
    // The comment's own position: what follows it is the answer to it,
    // and the comment itself is already in the caller's hands (T-182).
    cursor: encodeTimelineCursor({ t: ts, k: 0, i: row.id }),
  };
}

/** Fetch one comment by id, scoped to its issue (permalink resolution). */
export async function getComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<TimelineComment> {
  // A permalink is written down and followed later, so it answers to
  // whoever can read where the comment is now (T-242).
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  // Asked before the card's own gate, which would answer for the card and
  // leave the comment behind: this address names a comment, and only the
  // alias knows the id it carries now (T-245). A comment id that was never
  // here falls through to the card's marker, as it did before.
  if (issue.movedAt !== null) {
    await throwIfCommentAliased(ctx, project.id, commentId, role !== null);
  }
  assertIssueReadable(issue, actor, role);

  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const row = rows[0];
  if (!row)
    await throwIfCommentAliased(ctx, project.id, commentId, role !== null);
  if (!row) throw new NotFoundError("comment not found");
  return toTimelineComment(ctx, row, { elideHidden: false });
}

/**
 * Resolve a comment without knowing which issue carries it — the entry
 * point for a bare `#comment-M` reference (T-150), where the id is all the
 * author wrote.
 */
export async function locateComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  commentId: number,
): Promise<CommentLocation> {
  // Same as getComment: a bare `#comment-M` outlives the move that carried
  // the comment away, so the destination decides who may follow it (T-242).
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select({
      comment: comments,
      ...gateColumns,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(and(eq(comments.projectId, project.id), eq(comments.id, commentId)));
  const row = rows[0];
  if (!row)
    await throwIfCommentAliased(ctx, project.id, commentId, role !== null);
  if (!row) throw new NotFoundError("comment not found");
  // This endpoint reaches a comment by id alone, so the issue's own gate
  // never ran: without this, a bare `#comment-M` would hand out the body of
  // a comment on a deleted card.
  assertIssueReadable(row, actor, role);
  // The ref is a label for the reader, so it is spelled in the format in
  // force now — not the one the comment was written under (T-80).
  const prefix = await refPrefixAt(db, project.id, new Date());
  return {
    issue_number: row.number,
    issue_ref: formatRef(prefix, row.number),
    comment: await toTimelineComment(ctx, row.comment, {
      elideHidden: false,
    }),
  };
}

async function loadCommentForWrite(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<{ project: ProjectRow; db: Db; row: CommentRow }> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "comment.modify",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const row = rows[0];
  if (!row) throw new NotFoundError("comment not found");
  if (row.authorId !== actor.id && role !== "admin") {
    throw new ForbiddenError("only the author or a project admin may modify");
  }
  return { project, db, row };
}

export async function updateComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
  input: CommentUpdateInput,
  // The comment row keeps its original provenance; only the referenced
  // events born from this edit carry the editing request's context.
  agentContext: AgentContext | null = null,
): Promise<TimelineComment> {
  const { project, db, row } = await loadCommentForWrite(
    ctx,
    actor,
    slug,
    issueNumber,
    commentId,
  );
  // No-op saves succeed but record nothing: no revision, no edited_at
  // bump, no SSE, no reference re-scan.
  if (input.body === row.body)
    return toTimelineComment(ctx, row, { elideHidden: false });

  const projectId = project.id;
  const refInputs = await loadReferenceInputs(ctx, db, projectId);
  const resolved = await resolveContent({
    ctx,
    db,
    project,
    actor,
    inputs: refInputs,
    text: input.body,
    self: { projectId, number: issueNumber },
  });
  // Storing the resolved text is what makes this a no-op the second time
  // round: an unchanged body reaches the guard above and stops there.
  if (resolved.storedText === row.body)
    return toTimelineComment(ctx, row, { elideHidden: false });

  const { after, refs } = await db.transaction(async (tx) => {
    const updated = await tx
      .update(comments)
      .set({ body: resolved.storedText, editedAt: new Date() })
      .where(eq(comments.id, row.id))
      .returning();
    const after = updated[0];
    if (!after) throw new Error("comment update returned no row");

    await recordRevision(tx, {
      projectId,
      subjectType: "comment",
      subjectId: row.id,
      body: row.body,
      actorId: actor.id,
      agentContext,
    });

    const refs = await recordLocalReferences(
      tx,
      project,
      actor.id,
      { issueNumber, commentId: row.id },
      resolved.local,
      agentContext,
    );
    return { after, refs };
  });
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: row.id,
    action: "updated",
    issue_number: issueNumber,
  });
  for (const ref of refs) {
    ctx.bus.publish(projectId, {
      entity: "timeline",
      id: ref.eventId,
      action: "created",
      issue_number: ref.issueNumber,
    });
  }
  await recordCrossReferences(
    ctx,
    actor,
    project,
    { issueNumber, commentId: row.id },
    resolved.cross,
    agentContext,
  );
  return toTimelineComment(ctx, after, { elideHidden: false });
}

export async function deleteComment(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
): Promise<void> {
  const { project, db, row } = await loadCommentForWrite(
    ctx,
    actor,
    slug,
    issueNumber,
    commentId,
  );
  const projectId = project.id;
  let counterChanged = false;
  await db.transaction(async (tx) => {
    // A still-unresolved spec comment gives its count back (T-23); a
    // resolved one already surrendered it at resolve time.
    if (row.component?.type === "spec_comment" && row.resolvedAt === null) {
      await tx
        .update(issues)
        .set({
          specUnresolvedComments: sql`greatest(${issues.specUnresolvedComments} - 1, 0)`,
        })
        .where(eq(issues.id, row.issueId));
      counterChanged = true;
    }
    // A still-unanswered question comment gives its count back; an answered
    // one already surrendered it when the answer landed.
    const asked = questionCount(row.component);
    if (asked > 0) {
      const answered = (
        await tx
          .select({ payload: issueEvents.payload })
          .from(issueEvents)
          .where(
            and(
              eq(issueEvents.issueId, row.issueId),
              eq(issueEvents.type, "question_answered"),
            ),
          )
      ).some((e) => {
        const parsed = QuestionAnsweredPayload.safeParse(e.payload);
        return parsed.success && parsed.data.comment_id === row.id;
      });
      if (!answered) {
        await tx
          .update(issues)
          .set({
            openQuestions: sql`greatest(${issues.openQuestions} - ${asked}, 0)`,
          })
          .where(eq(issues.id, row.issueId));
        counterChanged = true;
      }
    }
    await tx.delete(comments).where(eq(comments.id, row.id));
    await deleteRevisionsFor(tx, projectId, "comment", row.id);
  });
  ctx.bus.publish(projectId, {
    entity: "timeline",
    id: row.id,
    action: "deleted",
    issue_number: issueNumber,
  });
  if (counterChanged) {
    ctx.bus.publish(projectId, {
      entity: "issue",
      id: row.issueId,
      action: "updated",
      issue_number: issueNumber,
      list_row: { kind: "activity" },
    });
  }
}

/**
 * Hide or unhide comments in one transaction (T-281).
 *
 * No policy is enforced here. Which comments deserve hiding is
 * `selectHidable`'s answer in the client, because hiding one answered
 * question by hand is a legitimate operation while a batch selector should
 * still skip it — a server-side exemption could not tell the two apart.
 *
 * The write is silent by design: no `issue_events` row, no `updated_at`
 * bump, and unread state is computed from `created_at` so it cannot move.
 * Only the timeline event is published, because hiding does change what a
 * default timeline read hands back and the web page has to hear about it.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A locked comment row, as much of it as the settling pass reads. */
export type SettleCandidate = {
  id: number;
  component: CommentComponent | null;
  resolvedAt: Date | null;
};

export type SettleHiddenOutcome = SettledByHide & { events: ChangeEvent[] };

/**
 * Settle what a hide buries, in the hide's own transaction (T-307): decline
 * the questions nobody answered, resolve the annotations nobody resolved.
 *
 * Both apply whoever wrote the comment. Hiding is a person saying the comment
 * no longer matters, and that judgement does not stop at authorship — a
 * declined question and a hidden question go together rather than one
 * happening without the other. So there is no authorship test and no refusal
 * path here; a hide that reaches an unsettled comment settles it.
 *
 * Neither half is reversible. `unhide` restores the body, never the answer
 * (answers cannot be edited, ever) and never the annotation's open state.
 *
 * The arithmetic and the event shapes are `submitAnswers` and
 * `resolveSpecComments` copied, down to which of them moves `updated_at`:
 * an answer is new activity, resolving an annotation is cleanup.
 */
export async function settleHiddenInTx(
  tx: Tx,
  args: {
    projectId: number;
    issueId: number;
    issueNumber: number;
    actorId: number;
    rows: SettleCandidate[];
    agentContext: AgentContext | null;
  },
): Promise<SettleHiddenOutcome> {
  const declined: number[] = [];
  const resolved: number[] = [];
  const paths: string[] = [];
  const events: ChangeEvent[] = [];

  const withQuestions = args.rows.filter(
    (row) => row.component?.type === "questions",
  );
  if (withQuestions.length > 0) {
    const answerRows = await tx
      .select()
      .from(issueEvents)
      .where(
        and(
          eq(issueEvents.issueId, args.issueId),
          eq(issueEvents.type, "question_answered"),
        ),
      );
    let closed = 0;
    for (const row of withQuestions) {
      const component = row.component;
      if (component?.type !== "questions") continue;
      if (answerEventFor(answerRows, row.id) !== undefined) continue;
      const answers = component.questions.map((question) => ({
        key: question.key,
        selected: [],
        other: null,
        declined: true,
      }));
      const inserted = await tx
        .insert(issueEvents)
        .values({
          projectId: args.projectId,
          issueId: args.issueId,
          actorId: args.actorId,
          type: "question_answered",
          payload: { comment_id: row.id, answers },
          agentContext: args.agentContext,
        })
        .returning();
      const event = inserted[0];
      if (!event) throw new Error("event insert returned no row");
      declined.push(row.id);
      closed += answers.length;
      events.push({
        entity: "timeline",
        id: event.id,
        action: "created",
        issue_number: args.issueNumber,
      });
    }
    if (closed > 0) {
      await tx
        .update(issues)
        .set({
          openQuestions: sql`greatest(${issues.openQuestions} - ${closed}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, args.issueId));
    }
  }

  for (const row of args.rows) {
    const component = row.component;
    if (component?.type !== "spec_comment" || row.resolvedAt !== null) continue;
    resolved.push(row.id);
    paths.push(component.anchor.path);
  }
  if (resolved.length > 0) {
    await tx
      .update(comments)
      .set({ resolvedAt: new Date(), resolvedBy: args.actorId })
      .where(inArray(comments.id, resolved));
    const inserted = await tx
      .insert(issueEvents)
      .values({
        projectId: args.projectId,
        issueId: args.issueId,
        actorId: args.actorId,
        type: "spec_comments_resolved",
        // `via` is the whole audit trail: no reader discounts a
        // hide-resolved annotation, so without it a review round that
        // disappeared is indistinguishable from one that was answered.
        payload: { comment_ids: resolved, paths, via: "hide" },
        agentContext: args.agentContext,
      })
      .returning();
    const event = inserted[0];
    if (!event) throw new Error("event insert returned no row");
    await tx
      .update(issues)
      .set({
        specUnresolvedComments: sql`greatest(${issues.specUnresolvedComments} - ${resolved.length}, 0)`,
      })
      .where(eq(issues.id, args.issueId));
    events.push(
      {
        entity: "timeline",
        id: event.id,
        action: "created",
        issue_number: args.issueNumber,
      },
      {
        entity: "spec",
        id: args.issueId,
        action: "updated",
        issue_number: args.issueNumber,
      },
    );
  }

  // One row event however many counters moved: both of them badge the same
  // list row, and the second publish would only requeue the first's work.
  if (declined.length > 0 || resolved.length > 0) {
    events.push({
      entity: "issue",
      id: args.issueId,
      action: "updated",
      issue_number: args.issueNumber,
      list_row: { kind: "activity" },
    });
  }
  return {
    declined_questions: declined,
    resolved_annotations: resolved,
    events,
  };
}

/** The wire half of an outcome, or null when the hide settled nothing. */
export type HideInTxResult = Omit<CommentHideResult, "settled"> & {
  /** The ids this call actually moved; empty means nothing was written. */
  written: number[];
  settled: SettledByHide | null;
  /** Publish after commit, in order. */
  events: ChangeEvent[];
};

/**
 * Hide or unhide a list of comments inside an open transaction, settling
 * what a hide buries. Shared by the hide endpoint and the command endpoint
 * (T-307), which submits `/hide-all` together with the comment it posts —
 * two copies of this would be two hide policies waiting to disagree.
 *
 * The caller checks the capabilities (`settleScan` says which ones a hide
 * will need) and owns the `ChangeEvent`s until the transaction commits.
 */
export async function hideCommentsInTx(
  tx: Tx,
  args: {
    projectId: number;
    issueId: number;
    issueNumber: number;
    actorId: number;
    input: CommentHideInput;
    agentContext: AgentContext | null;
  },
): Promise<HideInTxResult> {
  const { input, issueNumber } = args;
  const rows = await tx
    .select({
      id: comments.id,
      hiddenAt: comments.hiddenAt,
      // Widened for the settling pass (T-307), which must read the same
      // locked rows the hide writes rather than a second, racier read.
      component: comments.component,
      resolvedAt: comments.resolvedAt,
    })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, args.issueId),
        inArray(comments.id, input.comment_ids),
      ),
    )
    .for("update");
  const byId = new Map(rows.map((r) => [r.id, r]));

  const written: number[] = [];
  for (const id of input.comment_ids) {
    const row = byId.get(id);
    // One foreign id fails the whole call: a client whose selection drifted
    // onto another card must not get half of it applied.
    if (!row) throw new NotFoundError(`comment ${id} not found`);
    if ((row.hiddenAt !== null) !== input.hidden) written.push(id);
  }
  const moved = new Set(written);
  const result: HideInTxResult = {
    hidden: input.comment_ids,
    unchanged: input.comment_ids.filter((id) => !moved.has(id)),
    written,
    settled: null,
    events: [],
  };
  if (written.length === 0) return result;

  await tx
    .update(comments)
    .set(
      input.hidden
        ? { hiddenAt: new Date(), hiddenBy: args.actorId }
        : { hiddenAt: null, hiddenBy: null },
    )
    .where(inArray(comments.id, written));

  // One event for the call, not one per comment: hiding 55 comments would
  // otherwise queue 55 inbox recomputations (T-275) that each conclude
  // nothing changed. `spec resolve` publishes a batch the same way.
  result.events.push({
    entity: "timeline",
    id: Math.max(...written),
    action: "updated",
    issue_number: issueNumber,
  });
  if (!input.hidden) return result;

  const outcome = await settleHiddenInTx(tx, {
    projectId: args.projectId,
    issueId: args.issueId,
    issueNumber,
    actorId: args.actorId,
    rows: written.map((id) => byId.get(id)).filter((row) => row !== undefined),
    agentContext: args.agentContext,
  });
  result.settled = settledOf(outcome);
  result.events.push(...outcome.events);
  return result;
}

/** The wire half of an outcome, or null when the hide settled nothing. */
export function settledOf(outcome: SettleHiddenOutcome): SettledByHide | null {
  const { declined_questions, resolved_annotations } = outcome;
  if (declined_questions.length === 0 && resolved_annotations.length === 0) {
    return null;
  }
  return { declined_questions, resolved_annotations };
}

/**
 * Which extra capabilities a hide over these ids will need, read before the
 * transaction so a caller who may not answer questions is refused rather
 * than rolled back. Conservative about the race: a comment settled between
 * this scan and the write costs one capability check nobody notices.
 */
async function settleScan(
  db: Db,
  issueId: number,
  ids: number[],
): Promise<{ questions: boolean; annotations: boolean }> {
  const rows = await db
    .select({
      id: comments.id,
      component: comments.component,
      resolvedAt: comments.resolvedAt,
    })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        inArray(comments.id, ids),
        isNull(comments.hiddenAt),
      ),
    );
  const annotations = rows.some(
    (row) => row.component?.type === "spec_comment" && row.resolvedAt === null,
  );
  const asked = rows.filter((row) => row.component?.type === "questions");
  if (asked.length === 0) return { questions: false, annotations };
  const answerRows = await db
    .select()
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issueId),
        eq(issueEvents.type, "question_answered"),
      ),
    );
  return {
    questions: asked.some(
      (row) => answerEventFor(answerRows, row.id) === undefined,
    ),
    annotations,
  };
}

/**
 * The extra capabilities a hide needs cleared before its transaction opens.
 * The settling rides on `comment.hide`, which the caller has already checked,
 * but the two capabilities it exercises are checked too and only when this
 * call would exercise them. All three are `writer` today, so no user sees a
 * difference; the check exists so a future divergence fails loudly instead of
 * letting `comment.hide` quietly grant the other two.
 */
export async function requireSettleCapabilities(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  db: Db,
  issueId: number,
  input: CommentHideInput,
): Promise<void> {
  if (!input.hidden) return;
  const scan = await settleScan(db, issueId, input.comment_ids);
  if (scan.questions) {
    await requireCapability(ctx, actor, slug, "question.answer");
  }
  if (scan.annotations) {
    await requireCapability(ctx, actor, slug, "spec.resolve");
  }
}

export async function setCommentsHidden(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: CommentHideInput,
  agentContext: AgentContext | null = null,
): Promise<CommentHideResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "comment.hide",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);
  await requireSettleCapabilities(ctx, actor, slug, db, issue.id, input);

  const result = await db.transaction((tx) =>
    hideCommentsInTx(tx, {
      projectId: project.id,
      issueId: issue.id,
      issueNumber,
      actorId: actor.id,
      input,
      agentContext,
    }),
  );

  for (const event of result.events) ctx.bus.publish(project.id, event);
  return {
    hidden: result.hidden,
    unchanged: result.unchanged,
    ...(result.settled === null ? {} : { settled: result.settled }),
  };
}
