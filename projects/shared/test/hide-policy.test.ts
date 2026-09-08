import type { CommentComponent, HidePolicy, TimelineItem } from "@todou/shared";
import { selectHidable } from "@todou/shared";
import { describe, expect, it } from "vitest";

const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (
  id: number,
  over: {
    hidden?: boolean;
    component?: CommentComponent;
    resolved_at?: string | null;
  } = {},
): TimelineItem => ({
  type: "comment",
  id,
  author: actor,
  body: `body ${id}`,
  component: over.component ?? null,
  created_at: "2026-09-08T12:00:00.000Z",
  edited_at: null,
  resolved_at: over.resolved_at ?? null,
  hidden_at: over.hidden ? "2026-09-08T13:00:00.000Z" : null,
  agent_context: null,
});

const event = (id: number): TimelineItem => ({
  type: "event",
  id,
  event_type: "status_changed",
  actor,
  payload: {},
  created_at: "2026-09-08T12:00:00.000Z",
  agent_context: null,
});

const answered = (id: number, commentId: number): TimelineItem => ({
  type: "event",
  id,
  event_type: "question_answered",
  actor,
  payload: { comment_id: commentId, answers: [] },
  created_at: "2026-09-08T12:00:00.000Z",
  agent_context: null,
});

const questions: CommentComponent = {
  type: "questions",
  questions: [
    {
      key: "q1",
      multiple: false,
      question: "Where?",
      options: [{ label: "here" }, { label: "there" }],
    },
  ],
};

const anchor: CommentComponent = {
  type: "spec_comment",
  anchor: {
    path: "design.md",
    version: 1,
    line_start: 4,
    line_end: 4,
    col_start: null,
    col_end: null,
    quote: "a sentence",
  },
};

const hide = { hidden: true };
const unhide = { hidden: false };

const reasons = (skip: Array<{ id: number; reason: string }>) =>
  Object.fromEntries(skip.map((entry) => [entry.id, entry.reason]));

/**
 * Every case also has to hold the shape invariant, because a selector that
 * quietly dropped a candidate would look like a correct answer with a
 * shorter list: nothing in `pick` may also be in `skip`, and between them
 * they must account for every id the policy considered.
 */
const accountsFor = (
  result: { pick: number[]; skip: Array<{ id: number; reason: string }> },
  candidates: number[],
) => {
  const skipped = result.skip.map((entry) => entry.id);
  expect(result.pick.filter((id) => skipped.includes(id))).toEqual([]);
  expect([...result.pick, ...skipped].sort()).toEqual([...candidates].sort());
  for (const entry of result.skip) expect(entry.reason).toBeTruthy();
};

describe("selectHidable by ids", () => {
  it("skips only what is already hidden or is no comment", () => {
    const items = [
      comment(1),
      comment(2, { hidden: true }),
      // Both exemptions and the tail rule would cover these under a
      // selector; naming an id is the operator saying they know.
      comment(3, { component: questions }),
      comment(4, { component: anchor }),
      event(99),
    ];
    const policy: HidePolicy = { by: "ids", ids: [1, 2, 3, 4, 99, 1] };
    const result = selectHidable(items, policy, hide);

    expect(result.pick).toEqual([1, 3, 4]);
    expect(reasons(result.skip)).toEqual({ 2: "already", 99: "not_a_comment" });
    // The duplicated 1 is one candidate, not two.
    accountsFor(result, [1, 2, 3, 4, 99]);
  });

  it("picks an answered questions comment named by id", () => {
    const items = [comment(1, { component: questions }), answered(50, 1)];
    const result = selectHidable(items, { by: "ids", ids: [1] }, hide);
    expect(result.pick).toEqual([1]);
  });
});

describe("selectHidable by up_to", () => {
  it("includes the watermark itself", () => {
    const items = [comment(1), comment(2), comment(3), comment(4)];
    const result = selectHidable(
      items,
      { by: "up_to", comment_id: 3, keep_last: 0 },
      hide,
    );
    expect(result.pick).toEqual([1, 2, 3]);
    accountsFor(result, [1, 2, 3]);
  });

  it("reports a watermark that names no comment", () => {
    const items = [comment(1), comment(2)];
    const result = selectHidable(
      items,
      { by: "up_to", comment_id: 77, keep_last: 0 },
      hide,
    );
    expect(result.pick).toEqual([]);
    expect(reasons(result.skip)).toEqual({ 77: "not_a_comment" });
  });

  it("still holds back the tail the whole card ends with", () => {
    const items = [comment(1), comment(2), comment(3)];
    const result = selectHidable(
      items,
      { by: "up_to", comment_id: 3, keep_last: 2 },
      hide,
    );
    expect(result.pick).toEqual([1]);
    expect(reasons(result.skip)).toEqual({ 2: "kept_tail", 3: "kept_tail" });
  });
});

describe("selectHidable by all", () => {
  it("counts keep_last in comments, not timeline entries", () => {
    const items = [
      comment(1),
      comment(2),
      comment(3),
      event(91),
      event(92),
      event(93),
      event(94),
      event(95),
    ];
    const result = selectHidable(items, { by: "all", keep_last: 1 }, hide);

    expect(result.pick).toEqual([1, 2]);
    expect(reasons(result.skip)).toEqual({ 3: "kept_tail" });
    accountsFor(result, [1, 2, 3]);
  });

  it("keeps every comment when keep_last outruns the card", () => {
    const items = [comment(1), comment(2)];
    const result = selectHidable(items, { by: "all", keep_last: 5 }, hide);
    expect(result.pick).toEqual([]);
    expect(reasons(result.skip)).toEqual({ 1: "kept_tail", 2: "kept_tail" });
  });
});

describe("selectHidable exemptions", () => {
  it("turns on an unanswered questions comment and off once answered", () => {
    const withoutAnswer = [comment(1, { component: questions }), comment(2)];
    const withAnswer = [...withoutAnswer, answered(50, 1)];
    const policy: HidePolicy = { by: "all", keep_last: 0 };

    expect(selectHidable(withoutAnswer, policy, hide).pick).toEqual([2]);
    expect(reasons(selectHidable(withoutAnswer, policy, hide).skip)).toEqual({
      1: "open_question",
    });
    expect(selectHidable(withAnswer, policy, hide).pick).toEqual([1, 2]);
  });

  it("turns on an unresolved anchor and off once resolved", () => {
    const policy: HidePolicy = { by: "all", keep_last: 0 };
    const open = [comment(1, { component: anchor, resolved_at: null })];
    const settled = [
      comment(1, {
        component: anchor,
        resolved_at: "2026-09-08T14:00:00.000Z",
      }),
    ];

    expect(selectHidable(open, policy, hide).pick).toEqual([]);
    expect(reasons(selectHidable(open, policy, hide).skip)).toEqual({
      1: "unresolved_anchor",
    });
    expect(selectHidable(settled, policy, hide).pick).toEqual([1]);
  });

  it("answers with the tail before the exemption when both apply", () => {
    const items = [comment(1, { component: questions })];
    const result = selectHidable(items, { by: "all", keep_last: 3 }, hide);
    expect(reasons(result.skip)).toEqual({ 1: "kept_tail" });
  });
});

describe("selectHidable unhiding", () => {
  it("picks exactly what is hidden now, whatever would exempt it", () => {
    const items = [
      comment(1, { hidden: true }),
      comment(2),
      // Hidden despite an open question, which is possible by id: unhiding
      // has nothing to protect, so no exemption may hold it down there.
      comment(3, { hidden: true, component: questions }),
    ];
    const result = selectHidable(items, { by: "all", keep_last: 3 }, unhide);

    expect(result.pick).toEqual([1, 3]);
    expect(reasons(result.skip)).toEqual({ 2: "already" });
    accountsFor(result, [1, 2, 3]);
  });

  it("reads already against the target state, not against hidden", () => {
    const items = [comment(1, { hidden: true })];
    expect(selectHidable(items, { by: "ids", ids: [1] }, hide).pick).toEqual(
      [],
    );
    expect(selectHidable(items, { by: "ids", ids: [1] }, unhide).pick).toEqual([
      1,
    ]);
  });
});
