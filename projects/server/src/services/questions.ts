import type {
  AgentContext,
  AnswersSubmitInput,
  CommentComponent,
  CommentComponentInput,
  IssueQuestions,
  IssueQuestionsItem,
  QuestionAnswer,
  QuestionsComponent,
  TimelineEvent,
} from "@todou/shared";
import { QuestionAnsweredPayload } from "@todou/shared";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { projectForRead, requireCapability, routeInfoOf } from "./access.ts";
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

/** The one answer event for a comment, if any (payloads are append-only). */
function answerEventFor(
  rows: Array<typeof issueEvents.$inferSelect>,
  commentId: number,
) {
  return rows.find((row) => {
    const parsed = QuestionAnsweredPayload.safeParse(row.payload);
    return parsed.success && parsed.data.comment_id === commentId;
  });
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
    // Answer-once is comment-level and atomic: lock the comment row so two
    // concurrent submissions serialize, then the loser sees the winner's
    // event and conflicts instead of double-inserting.
    await tx
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.id, commentId))
      .for("update");
    const existing = answerEventFor(
      await tx
        .select()
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, issue.id),
            eq(issueEvents.type, "question_answered"),
          ),
        ),
      commentId,
    );
    if (existing) {
      throw new ConflictError(
        `comment ${commentId} was already answered at ${existing.createdAt.toISOString()} — answers cannot be changed`,
      );
    }
    const inserted = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "question_answered",
        payload: { comment_id: commentId, answers },
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
  const eventRows = await db
    .select()
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issue.id),
        eq(issueEvents.type, "question_answered"),
      ),
    );

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
    const event = answerEventFor(eventRows, comment.id);
    let answer: IssueQuestionsItem["answer"] = null;
    if (event) {
      const actorRef = refs.get(event.actorId);
      if (!actorRef) throw new Error("actor ref missing");
      answer = {
        event_id: event.id,
        actor: actorRef,
        created_at: event.createdAt.toISOString(),
        answers: QuestionAnsweredPayload.parse(event.payload).answers,
      };
    } else {
      open += comment.component.questions.length;
    }
    items.push({
      comment_id: comment.id,
      author,
      created_at: comment.createdAt.toISOString(),
      questions: comment.component.questions,
      answer,
    });
  }
  return { items, open };
}
