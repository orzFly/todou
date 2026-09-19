import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/** Only these persisted events are evidence. New event kinds stay excluded. */
export const ACTIVITY_EVENT_TYPES = [
  "opened",
  "closed",
  "reopened",
  "status_changed",
  "title_changed",
  "label_added",
  "label_removed",
  "assigned",
  "unassigned",
  "attachment_added",
  "question_answered",
  "spec_pushed",
  "spec_review",
  "spec_comments_resolved",
  "block_added",
  "block_removed",
] as const;

const field = (value: SQLWrapper, key: string) => sql`(${value} -> ${key})`;
const text = (value: SQLWrapper) => sql`(${value} #>> '{}')`;
const object = (value: SQLWrapper) => sql`jsonb_typeof(${value}) = 'object'`;
const string = (value: SQLWrapper) => sql`jsonb_typeof(${value}) = 'string'`;
const nonempty = (value: SQLWrapper) =>
  sql`(${string(value)} AND length(${text(value)}) > 0)`;
const nullableString = (value: SQLWrapper) =>
  sql`(${string(value)} OR ${value} = 'null'::jsonb)`;

// CASE, not AND, guards casts and set-returning JSON functions: PostgreSQL may
// reorder boolean expressions. Malformed historical payloads must never throw.
function integer(value: SQLWrapper, minimum = 1): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'number' THEN
    (${text(value)})::numeric BETWEEN ${minimum} AND 9007199254740991
    AND trunc((${text(value)})::numeric) = (${text(value)})::numeric
    ELSE false END)`;
}

function array(value: SQLWrapper): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'array'
    THEN ${value} ELSE '[]'::jsonb END)`;
}

function onlyKeys(value: SQLWrapper, keys: string[]): SQL {
  return sql`(CASE WHEN ${object(value)} THEN
    ${value} - ARRAY[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[] = '{}'::jsonb
    ELSE false END)`;
}

function arrayOf(
  value: SQLWrapper,
  valid: (item: SQLWrapper) => SQL,
  nonEmpty = false,
): SQL {
  const item = sql`activity_item.value`;
  return sql`(jsonb_typeof(${value}) = 'array'
    ${nonEmpty ? sql`AND jsonb_array_length(${array(value)}) > 0` : sql``}
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${array(value)}) AS activity_item(value)
      WHERE (${valid(item)}) IS NOT TRUE
    ))`;
}

function questionPredicate(payload: SQLWrapper, validityOnly: boolean): SQL {
  const answers = field(payload, "answers");
  const via = field(payload, "via");
  const validAnswers = arrayOf(
    answers,
    (answer) => {
      const selected = field(answer, "selected");
      const other = field(answer, "other");
      const declined = field(answer, "declined");
      return sql`(${onlyKeys(answer, ["key", "selected", "other", "declined"])}
        AND ${string(field(answer, "key"))}
        AND ${text(field(answer, "key"))} ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$'
        AND ${arrayOf(
          selected,
          (selection) => sql`(
          ${onlyKeys(selection, ["index", "label"])}
          AND ${integer(field(selection, "index"), 0)}
          AND ${string(field(selection, "label"))}
        )`,
        )}
        AND (${other} = 'null'::jsonb OR ${nonempty(other)})
        AND jsonb_typeof(${declined}) = 'boolean'
        AND CASE WHEN ${declined} = 'true'::jsonb
          THEN jsonb_array_length(${array(selected)}) = 0
          ELSE jsonb_array_length(${array(selected)}) > 0 OR ${nonempty(other)} END
      )`;
    },
    true,
  );
  const marker = validityOnly
    ? sql`(NOT (${payload} ? 'via') OR ${via} IN ('"answer"'::jsonb, '"hide"'::jsonb))`
    : sql`(
      ${via} = '"answer"'::jsonb
      OR (NOT (${payload} ? 'via') AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(${array(answers)}) AS activity_answer(value)
        WHERE activity_answer.value -> 'declined' = 'false'::jsonb
      ))
    )`;
  return sql`(${onlyKeys(payload, ["comment_id", "answers", "via"])}
    AND ${integer(field(payload, "comment_id"))}
    AND ${validAnswers} AND ${marker})`;
}

/**
 * A SQL predicate over issue_events.type/payload, suitable for the common
 * evidence CTE used by both counts and selections. This never joins comments:
 * independently surviving question/spec events remain evidence after deletion.
 * Unknown kinds and unrecognizable payloads evaluate to false, never SQL NULL.
 * Malformed diagnostics use activityMalformedEventPredicate, so intentional
 * exclusions (hide, legacy declines, no-ops) do not generate warnings.
 */
export function activityEventPredicate(columns: {
  type: SQLWrapper;
  payload: SQLWrapper;
}): SQL {
  return eventPredicate(columns, false);
}

/** Batch/group this predicate by event type; never log the payload itself. */
export function activityMalformedEventPredicate(columns: {
  type: SQLWrapper;
  payload: SQLWrapper;
}): SQL {
  return sql`(${columns.type} IN (${sql.join(
    ACTIVITY_EVENT_TYPES.map((kind) => sql`${kind}`),
    sql`, `,
  )}) AND NOT ${eventPredicate(columns, true)})`;
}

function eventPredicate(
  columns: { type: SQLWrapper; payload: SQLWrapper },
  validityOnly: boolean,
): SQL {
  const p = columns.payload;
  const from = field(p, "from");
  const to = field(p, "to");
  const status = (value: SQLWrapper) => sql`(${object(value)}
    AND ${integer(field(value, "id"))} AND ${nonempty(field(value, "name"))})`;
  const label = field(p, "label");
  const user = field(p, "user");
  const attachment = field(p, "attachment");
  const changedFiles = ["added", "changed", "removed"].map((key) =>
    field(p, key),
  );
  const rules: Record<(typeof ACTIVITY_EVENT_TYPES)[number], SQL> = {
    opened: sql`${p} = '{}'::jsonb`,
    closed: sql`((${from} = 'null'::jsonb OR ${status(from)})
      AND ${status(to)} AND (${validityOnly} OR ${from} = 'null'::jsonb
        OR ${field(from, "id")} <> ${field(to, "id")}))`,
    reopened: sql`false`,
    status_changed: sql`false`,
    title_changed: sql`(${nonempty(from)} AND ${nonempty(to)} AND (${validityOnly} OR ${from} <> ${to}))`,
    label_added: sql`(${object(label)} AND ${integer(field(label, "id"))}
      AND (NOT (${label} ? 'name') OR ${nonempty(field(label, "name"))})
      AND (NOT (${label} ? 'color') OR ${string(field(label, "color"))}))`,
    label_removed: sql`false`,
    assigned: sql`(${object(user)} AND ${integer(field(user, "id"))}
      AND ${nonempty(field(user, "login"))})`,
    unassigned: sql`false`,
    attachment_added: sql`(${object(attachment)}
      AND ${integer(field(attachment, "id"))}
      AND ${nonempty(field(attachment, "filename"))}
      AND ${integer(field(attachment, "size"), 0)})`,
    question_answered: questionPredicate(p, validityOnly),
    spec_pushed: sql`(${onlyKeys(p, ["version", "message", "added", "changed", "removed"])}
      AND ${integer(field(p, "version"))} AND ${nullableString(field(p, "message"))}
      AND ${sql.join(
        changedFiles.map((value) => arrayOf(value, string)),
        sql` AND `,
      )}
      AND (${validityOnly} OR (${sql.join(
        changedFiles.map((value) => sql`jsonb_array_length(${array(value)})`),
        sql` + `,
      )}) > 0))`,
    spec_review: sql`(${onlyKeys(p, ["version", "verdict", "comment_id", "annotation_count"])}
      AND ${integer(field(p, "version"))}
      AND ${field(p, "verdict")} IN ('"approve"'::jsonb, '"request_changes"'::jsonb, '"comment"'::jsonb)
      AND (${field(p, "comment_id")} = 'null'::jsonb OR ${integer(field(p, "comment_id"))})
      AND ${integer(field(p, "annotation_count"), 0)})`,
    spec_comments_resolved: sql`(${arrayOf(field(p, "comment_ids"), (id) => integer(id), !validityOnly)}
      AND (NOT (${p} ? 'paths') OR ${arrayOf(field(p, "paths"), string)})
      AND (NOT (${p} ? 'via') OR (${validityOnly} AND ${field(p, "via")} = '"hide"'::jsonb)))`,
    block_added: sql`(${integer(field(p, "edge_id"))}
      AND ${field(p, "role")} IN ('"blocked"'::jsonb, '"blocker"'::jsonb)
      AND ${integer(field(p, "other_project_id"))}
      AND ${integer(field(p, "other_number"))})`,
    block_removed: sql`false`,
  };
  rules.reopened = rules.closed;
  rules.status_changed = rules.closed;
  rules.label_removed = rules.label_added;
  rules.unassigned = rules.assigned;
  rules.block_removed = rules.block_added;
  return sql`COALESCE((${object(p)} AND CASE ${columns.type}
    ${sql.join(
      ACTIVITY_EVENT_TYPES.map((kind) => sql`WHEN ${kind} THEN ${rules[kind]}`),
      sql` `,
    )}
    ELSE false END), false)`;
}

/** undefined is project scope; a person/machine is matched by its own id. */
export function activityActorPredicate(
  actor: SQLWrapper,
  actorId?: number,
): SQL {
  return actorId === undefined ? sql`true` : sql`${actor} = ${actorId}`;
}

/** Read creation evidence even for hidden comments; editedAt is not evidence. */
export function activityCommentEvidence(columns: {
  id: SQLWrapper;
  issueId: SQLWrapper;
  authorId: SQLWrapper;
  createdAt: SQLWrapper;
}) {
  return {
    id: columns.id,
    issueId: columns.issueId,
    actorId: columns.authorId,
    occurredAt: columns.createdAt,
  };
}

/**
 * Caller joins the existing comment to this same project/issue before supplying
 * commentId. A deleted comment cannot lend its revisions to another card.
 * The revision row itself proves a diff; neither body nor updatedAt is needed.
 */
export function activityRevisionEvidence(
  columns: {
    id: SQLWrapper;
    subjectType: SQLWrapper;
    subjectId: SQLWrapper;
    actorId: SQLWrapper;
    createdAt: SQLWrapper;
  },
  target: { issueId: SQLWrapper; commentId?: SQLWrapper },
) {
  return {
    id: columns.id,
    issueId: target.issueId,
    actorId: columns.actorId,
    occurredAt: columns.createdAt,
    predicate: sql`((${columns.subjectType} = 'issue_body' AND ${columns.subjectId} = ${target.issueId})
      OR (${columns.subjectType} = 'comment' AND ${columns.subjectId} = ${target.commentId ?? sql`NULL::bigint`}))`,
  };
}
