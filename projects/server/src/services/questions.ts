import type {
  AgentContext,
  AnswersSubmitInput,
  ChangeEvent,
  CommentComponent,
  CommentComponentInput,
  IssueQuestions,
  IssueQuestionsItem,
  QuestionAnswer,
  QuestionsComponent,
  QuestionWithdrawInput,
  QuestionWithdrawResult,
  TimelineEvent,
} from "@todou/shared";
import {
  can,
  minRoleOf,
  QuestionAnsweredPayload,
  QuestionWithdrawnPayload,
} from "@todou/shared";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { projectForRead, requireCapability, routeInfoOf } from "./access.ts";
import { encodeTimelineCursor } from "./cursor.ts";
import { microIso } from "./timeline.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

/**
 * Input → stored form: every question gets a key. Auto-keys count q1…qN by
 * position so a mixed payload (some keyed, some not) stays predictable; a
 * positional key colliding with an explicit one is rejected rather than
 * renamed, because answers reference keys and silent renames would misdirect
 * them.
 */
export function canonicalizeComponent(
  input: CommentComponentInput,
): CommentComponent {
  const taken = new Set<string>();
  for (const q of input.questions) {
    if (q.key === undefined) continue;
    if (taken.has(q.key)) {
      throw new ValidationFailedError(`duplicate question key "${q.key}"`);
    }
    taken.add(q.key);
  }
  const questions = input.questions.map((q, i) => {
    let key = q.key;
    if (key === undefined) {
      key = `q${i + 1}`;
      if (taken.has(key)) {
        throw new ValidationFailedError(
          `question ${i + 1} needs an explicit key: the default "${key}" is already taken`,
        );
      }
      taken.add(key);
    }
    return { ...q, key };
  });
  return { type: "questions", questions };
}

/** How many questions a component carries (0 for non-question components). */
export function questionCount(
  component: CommentComponent | null | undefined,
): number {
  return component?.type === "questions" ? component.questions.length : 0;
}

/**
 * Validate one atomic submission against the component and stamp label
 * snapshots. Errors name the question key — these travel to CLI users
 * verbatim.
 */
function toAnswerRecords(
  component: QuestionsComponent,
  input: AnswersSubmitInput,
): QuestionAnswer[] {
  const byKey = new Map(component.questions.map((q) => [q.key, q]));
  const records = new Map<string, QuestionAnswer>();
  for (const a of input.answers) {
    const q = byKey.get(a.key);
    if (!q) {
      throw new ValidationFailedError(
        `unknown question key "${a.key}" (this comment has: ${[...byKey.keys()].join(", ")})`,
      );
    }
    if (records.has(a.key)) {
      throw new ValidationFailedError(
        `duplicate answer for question "${a.key}"`,
      );
    }
    const other = a.other ?? null;
    if (a.declined && a.selected.length > 0) {
      throw new ValidationFailedError(
        `question "${a.key}": declining is exclusive — drop the selected options`,
      );
    }
    if (!a.declined && a.selected.length === 0 && other === null) {
      throw new ValidationFailedError(
        `question "${a.key}": select at least one option, write other text, or decline`,
      );
    }
    if (!q.multiple && a.selected.length > 1) {
      throw new ValidationFailedError(
        `question "${a.key}" is single-select, got ${a.selected.length} options`,
      );
    }
    if (new Set(a.selected).size !== a.selected.length) {
      throw new ValidationFailedError(
        `question "${a.key}": duplicate option indexes`,
      );
    }
    const selected = a.selected.map((index) => {
      const option = q.options[index];
      if (!option) {
        throw new ValidationFailedError(
          `question "${a.key}": option index ${index} is out of range (0-${q.options.length - 1})`,
        );
      }
      return { index, label: option.label };
    });
    records.set(a.key, { key: a.key, selected, other, declined: a.declined });
  }
  const missing = component.questions
    .map((q) => q.key)
    .filter((key) => !records.has(key));
  if (missing.length > 0) {
    throw new ValidationFailedError(
      `missing answers for: ${missing.join(", ")} — all questions of a comment are answered together`,
    );
  }
  // Stored in component order regardless of submission order.
  return component.questions.map((q) => {
    const record = records.get(q.key);
    if (!record) throw new Error("record missing after completeness check");
    return record;
  });
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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EventRow = typeof issueEvents.$inferSelect;

/**
 * The events that settle a question comment. Every reader asking whether a
 * comment still waits for an answer reads them through `settlingEvents` and
 * `settlementFor`, so none of them can miss a kind of settlement the others
 * know about.
 */
export const SETTLING_EVENT_TYPES = [
  "question_answered",
  "question_withdrawn",
] as const;

/** Every settling event on one issue, oldest first. */
export function settlingEvents(db: Db | Tx, issueId: number) {
  return db
    .select()
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issueId),
        inArray(issueEvents.type, [...SETTLING_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(issueEvents.id));
}

export type Settlement =
  | { kind: "answered"; row: EventRow; payload: QuestionAnsweredPayload }
  | { kind: "withdrawn"; row: EventRow; payload: QuestionWithdrawnPayload };

/**
 * How a comment was settled, if it was: the first settling event that names
 * it. Payloads are append-only, and a comment is settled once.
 */
export function settlementFor(
  rows: EventRow[],
  commentId: number,
): Settlement | undefined {
  for (const row of rows) {
    if (row.type === "question_answered") {
      const parsed = QuestionAnsweredPayload.safeParse(row.payload);
      if (parsed.success && parsed.data.comment_id === commentId) {
        return { kind: "answered", row, payload: parsed.data };
      }
    } else if (row.type === "question_withdrawn") {
      const parsed = QuestionWithdrawnPayload.safeParse(row.payload);
      if (parsed.success && parsed.data.comment_id === commentId) {
        return { kind: "withdrawn", row, payload: parsed.data };
      }
    }
  }
  return undefined;
}

export async function submitAnswers(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
  input: AnswersSubmitInput,
  agentContext: AgentContext | null = null,
): Promise<TimelineEvent> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "question.answer",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const commentRows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const comment = commentRows[0];
  if (!comment) throw new NotFoundError("comment not found");
  const component = comment.component;
  if (component?.type !== "questions") {
    throw new ValidationFailedError(
      `comment ${commentId} carries no questions`,
    );
  }
  const answers = toAnswerRecords(component, input);

  const row = await db.transaction(async (tx) => {
    // The card before the comment: writes to one card then queue on the
    // card, and never wait on each other in opposite orders.
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .for("no key update");
    // Answer-once is comment-level and atomic: lock the comment row so two
    // concurrent submissions serialize, then the loser sees the winner's
    // event and conflicts instead of double-inserting. A delete that won the
    // lock leaves no row: answering it would refund the counter again.
    const [locked] = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.id, commentId))
      .for("update");
    if (!locked) throw new NotFoundError("comment not found");
    const existing = settlementFor(
      await settlingEvents(tx, issue.id),
      commentId,
    );
    if (existing?.kind === "withdrawn") {
      throw new ConflictError(
        `comment ${commentId} was withdrawn at ${existing.row.createdAt.toISOString()} — it takes no answers`,
      );
    }
    if (existing) {
      throw new ConflictError(
        `comment ${commentId} was already answered at ${existing.row.createdAt.toISOString()} — answers cannot be changed`,
      );
    }
    const inserted = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "question_answered",
        payload: { comment_id: commentId, answers, via: "answer" },
        agentContext,
      })
      .returning();
    const event = inserted[0];
    if (!event) throw new Error("event insert returned no row");
    await tx
      .update(issues)
      .set({
        openQuestions: sql`greatest(${issues.openQuestions} - ${answers.length}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));
    return event;
  });

  ctx.bus.publish(project.id, {
    entity: "timeline",
    id: row.id,
    action: "created",
    issue_number: issueNumber,
  });
  // The open_questions counter changed; issue list badges must refresh.
  ctx.bus.publish(project.id, {
    entity: "issue",
    id: issue.id,
    action: "updated",
    issue_number: issueNumber,
    list_row: { kind: "activity" },
  });

  const refs = await getUserRefs(ctx.router.system(), [row.actorId]);
  const actorRef = refs.get(row.actorId);
  if (!actorRef) throw new Error("actor ref missing");
  return {
    type: "event",
    id: row.id,
    event_type: row.type,
    actor: actorRef,
    payload: row.payload as Record<string, unknown>,
    created_at: row.createdAt.toISOString(),
    agent_context: row.agentContext ?? null,
  };
}

/**
 * Withdraw a question comment nobody has answered: the asker's way of
 * settling it, recorded as `question_withdrawn`. It settles the way an
 * answer does — under the comment's row lock, once, giving its count back
 * to `open_questions` — and a repeat returns the first withdrawal's cursor
 * without touching its reason.
 */
export async function withdrawQuestions(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  commentId: number,
  input: QuestionWithdrawInput,
  agentContext: AgentContext | null = null,
): Promise<QuestionWithdrawResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "question.withdraw",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueWritable(issue, actor, role);

  const commentRows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.issueId, issue.id)));
  const comment = commentRows[0];
  if (!comment) throw new NotFoundError("comment not found");
  const asked = questionCount(comment.component);
  if (asked === 0) {
    throw new ValidationFailedError(
      `comment ${commentId} carries no questions`,
    );
  }
  if (comment.authorId !== actor.id && !can(role, "question.withdraw_any")) {
    throw new ForbiddenError(
      `only the asker or a ${minRoleOf("question.withdraw_any")} may withdraw these questions`,
    );
  }

  const events: ChangeEvent[] = [];
  const result = await db.transaction(
    async (tx): Promise<QuestionWithdrawResult> => {
      // The card first, as answering and deleting take it, with the gate
      // asked again under its lock: a cross-database move that froze the
      // card after the check above copies it without this withdrawal and
      // then empties the source, so the withdrawal would vanish behind a 200.
      const [card] = await tx
        .select(gateColumns)
        .from(issues)
        .where(eq(issues.id, issue.id))
        .for("no key update");
      if (!card) throw new NotFoundError("issue not found");
      assertIssueWritable(card, actor, role);
      // The lock answering and deleting take too: whichever comes second
      // sees the first one's settlement, or finds the comment gone.
      const [locked] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.id, commentId))
        .for("update");
      if (!locked) throw new NotFoundError("comment not found");
      const existing = settlementFor(
        await settlingEvents(tx, issue.id),
        commentId,
      );
      if (existing?.kind === "withdrawn") {
        // `createdAt` above is a Date, cut to milliseconds; the cursor
        // needs the column's own microseconds.
        const [event] = await tx
          .select({ id: issueEvents.id, ts: microIso(issueEvents.createdAt) })
          .from(issueEvents)
          .where(eq(issueEvents.id, existing.row.id));
        if (!event) throw new Error("withdrawal event vanished under lock");
        return {
          comment_id: commentId,
          unchanged: true,
          cursor: encodeTimelineCursor({ t: event.ts, k: 1, i: event.id }),
        };
      }
      if (existing) {
        throw new ConflictError(
          `comment ${commentId} was already answered at ${existing.row.createdAt.toISOString()} — answered questions cannot be withdrawn`,
        );
      }
      const [event] = await tx
        .insert(issueEvents)
        .values({
          projectId: project.id,
          issueId: issue.id,
          actorId: actor.id,
          type: "question_withdrawn",
          payload: { comment_id: commentId, reason: input.reason ?? null },
          agentContext,
        })
        .returning({ id: issueEvents.id, ts: microIso(issueEvents.createdAt) });
      if (!event) throw new Error("event insert returned no row");
      await tx
        .update(issues)
        .set({
          openQuestions: sql`greatest(${issues.openQuestions} - ${asked}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));
      events.push(
        {
          entity: "timeline",
          id: event.id,
          action: "created",
          issue_number: issueNumber,
        },
        // The open_questions counter changed; issue list badges must refresh.
        {
          entity: "issue",
          id: issue.id,
          action: "updated",
          issue_number: issueNumber,
          list_row: { kind: "activity" },
        },
      );
      return {
        comment_id: commentId,
        unchanged: false,
        cursor: encodeTimelineCursor({ t: event.ts, k: 1, i: event.id }),
      };
    },
  );
  for (const event of events) ctx.bus.publish(project.id, event);
  return result;
}

export async function listIssueQuestions(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<IssueQuestions> {
  // The questions travel with the card, so an old address earns the redirect
  // before the reader's role here is known (T-245). `submitAnswers` above is
  // a write and keeps its own gate.
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);
  assertIssueReadable(issue, actor, role);

  const commentRows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issue.id), isNotNull(comments.component)))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const eventRows = await settlingEvents(db, issue.id);

  const refIds = [
    ...commentRows.map((c) => c.authorId),
    ...eventRows.map((e) => e.actorId),
  ];
  const refs = await getUserRefs(ctx.router.system(), refIds);

  const items: IssueQuestionsItem[] = [];
  let open = 0;
  for (const comment of commentRows) {
    if (comment.component?.type !== "questions") continue;
    const author = refs.get(comment.authorId);
    if (!author) throw new Error("author ref missing");
    const settlement = settlementFor(eventRows, comment.id);
    let answer: IssueQuestionsItem["answer"] = null;
    let withdrawal: IssueQuestionsItem["withdrawal"] = null;
    if (settlement) {
      const event = settlement.row;
      const actorRef = refs.get(event.actorId);
      if (!actorRef) throw new Error("actor ref missing");
      const settled = {
        event_id: event.id,
        actor: actorRef,
        created_at: event.createdAt.toISOString(),
      };
      if (settlement.kind === "answered") {
        answer = { ...settled, answers: settlement.payload.answers };
      } else {
        withdrawal = { ...settled, reason: settlement.payload.reason };
      }
    } else {
      open += comment.component.questions.length;
    }
    items.push({
      comment_id: comment.id,
      author,
      created_at: comment.createdAt.toISOString(),
      questions: comment.component.questions,
      answer,
      withdrawal,
    });
  }
  return { items, open };
}
