import { QuestionAnsweredPayload } from "./schemas/component.ts";
import type { TimelineComment, TimelineItem } from "./schemas/timeline.ts";

/**
 * Which comments a batch hide or unhide covers (T-281). The server takes an
 * explicit id list and validates no policy at all, so this is the whole of
 * it: swapping a rule here ships in a client, never in a release.
 */
export type HidePolicy =
  | { by: "ids"; ids: number[] }
  | { by: "up_to"; comment_id: number; keep_last: number }
  | { by: "all"; keep_last: number };

export type SkipReason =
  /** Carries questions nobody has answered yet. */
  | "open_question"
  /** A spec inline comment still waiting to be resolved. */
  | "unresolved_anchor"
  /** Inside the `keep_last` comments held back at the tail. */
  | "kept_tail"
  /** Already in the state this call would put it in. */
  | "already"
  /** The id names no comment on this card. */
  | "not_a_comment";

export type HideSelection = {
  pick: number[];
  skip: Array<{ id: number; reason: SkipReason }>;
};

/**
 * Whether one comment is hidden, the only place that question is answered.
 *
 * `undefined` is in the signature because responses are cast rather than
 * parsed: a server predating T-281 sends no such key, and `hidden_at !== null`
 * would read every one of its comments as hidden — which collapses a whole
 * timeline into placeholders and elides every body a watch prints.
 */
export function isHidden(comment: { hidden_at?: string | null }): boolean {
  return (comment.hidden_at ?? null) !== null;
}

/**
 * Split a card's timeline into the comments this call should write and the
 * ones it should leave alone, each with the reason a `--dry-run` prints.
 *
 * `opts.hidden` is the target state, the same value the request body carries:
 * unhiding runs the identical selectors, so `--to` and `--all` mean one thing
 * in both directions rather than two.
 *
 * The exemptions below only bite while hiding, and only under a selector.
 * They exist to keep unsettled discussion on screen, so revealing is never
 * something to protect against, and naming an id is the operator saying they
 * know — the card's own requirement is that keeping one good comment in the
 * middle stays possible.
 */
export function selectHidable(
  items: TimelineItem[],
  policy: HidePolicy,
  opts: { hidden: boolean },
): HideSelection {
  const comments = items.filter(
    (item): item is TimelineComment => item.type === "comment",
  );
  const byId = new Map(comments.map((comment) => [comment.id, comment]));

  const pick: number[] = [];
  const skip: HideSelection["skip"] = [];
  const guard =
    opts.hidden && policy.by !== "ids"
      ? {
          tail: keptTail(comments, policy.keep_last),
          answered: answeredIds(items),
        }
      : null;

  for (const id of candidates(comments, policy)) {
    const comment = byId.get(id);
    if (comment === undefined) {
      skip.push({ id, reason: "not_a_comment" });
      continue;
    }
    if (isHidden(comment) === opts.hidden) {
      skip.push({ id, reason: "already" });
      continue;
    }
    const reason = guard === null ? null : exemption(comment, guard);
    if (reason !== null) {
      skip.push({ id, reason });
      continue;
    }
    pick.push(id);
  }
  return { pick, skip };
}

/**
 * Candidate ids, deduplicated, in the order the result should report them:
 * request order for an explicit list, timeline order for a selector.
 *
 * An `up_to` watermark that names no comment yields itself as the single
 * candidate, so it comes back as `not_a_comment` — the alternative is hiding
 * nothing and saying nothing about why.
 */
function candidates(comments: TimelineComment[], policy: HidePolicy): number[] {
  if (policy.by === "ids") return [...new Set(policy.ids)];
  if (policy.by === "all") return comments.map((comment) => comment.id);
  const cut = comments.findIndex((comment) => comment.id === policy.comment_id);
  if (cut === -1) return [policy.comment_id];
  return comments.slice(0, cut + 1).map((comment) => comment.id);
}

type Guard = { tail: Set<number>; answered: Set<number> };

function exemption(comment: TimelineComment, guard: Guard): SkipReason | null {
  if (guard.tail.has(comment.id)) return "kept_tail";
  if (
    comment.component?.type === "questions" &&
    !guard.answered.has(comment.id)
  ) {
    return "open_question";
  }
  if (
    comment.component?.type === "spec_comment" &&
    comment.resolved_at === null
  ) {
    return "unresolved_anchor";
  }
  return null;
}

/**
 * Counted in comments, not timeline entries: a card whose tail is one comment
 * followed by five status changes must still keep that comment.
 */
function keptTail(comments: TimelineComment[], keepLast: number): Set<number> {
  const from = Math.max(0, comments.length - Math.max(0, keepLast));
  return new Set(comments.slice(from).map((comment) => comment.id));
}

function answeredIds(items: TimelineItem[]): Set<number> {
  const answered = new Set<number>();
  for (const item of items) {
    if (item.type !== "event" || item.event_type !== "question_answered") {
      continue;
    }
    const parsed = QuestionAnsweredPayload.safeParse(item.payload);
    if (parsed.success) answered.add(parsed.data.comment_id);
  }
  return answered;
}
