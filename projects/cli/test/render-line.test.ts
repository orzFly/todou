import type { TimelineComment, TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type ActivityLineContext,
  renderActivityLine,
  renderTimelineItem,
} from "../src/commands/issue.ts";
import type { Painter } from "../src/format.ts";

/**
 * T-175: a watch prints one line per entry, and a comment's line has to
 * show what was said. These are the wordings a sentinel reads.
 */

/** Colors are noise here; the line's text is the whole subject. */
const paint: Painter = (_style, text) => text;

const author = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const ctx: ActivityLineContext = {
  refLabel: "T-146",
  issueNumber: 146,
  refPrefix: "T",
  summaryChars: 120,
};

const comment = (over: Partial<TimelineComment> = {}): TimelineComment => ({
  type: "comment",
  id: 757,
  author,
  body: "hello",
  component: null,
  created_at: "2026-08-11T12:00:00.000Z",
  edited_at: null,
  resolved_at: null,
  agent_context: null,
  ...over,
});

const event = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  type: "event",
  id: 901,
  event_type: "status_changed",
  actor: author,
  payload: { from: { name: "Todo" }, to: { name: "Next" } },
  created_at: "2026-08-11T12:00:00.000Z",
  agent_context: null,
  ...over,
});

describe("renderActivityLine", () => {
  it("shows the start of a comment body — the point of the exercise", () => {
    const line = renderActivityLine(
      comment({ body: "要在 dogfood 上开——先把 CLI 发布到镜像里" }),
      paint,
      ctx,
    );
    expect(line).toMatch(
      /^T-146 User commented .+: 要在 dogfood 上开——先把 CLI 发布到镜像里$/,
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  it("folds a multi-paragraph body onto its one line", () => {
    const line = renderActivityLine(
      comment({ body: "first\n\n  second\tthird  " }),
      paint,
      ctx,
    );
    expect(line.endsWith(": first second third")).toBe(true);
  });

  it("truncates by code point, not by byte", () => {
    const line = renderActivityLine(
      comment({ body: "这是一段很长的中文正文，需要被截断" }),
      paint,
      { ...ctx, summaryChars: 6 },
    );
    expect(line.endsWith(": 这是一段很长…")).toBe(true);
  });

  it("marks an edited comment", () => {
    expect(
      renderActivityLine(
        comment({ edited_at: "2026-08-11T12:30:00.000Z" }),
        paint,
        ctx,
      ),
    ).toContain("commented (edited)");
  });

  it("badges a comment carrying questions with how many there are", () => {
    const line = renderActivityLine(
      comment({
        body: "两个问题",
        component: {
          type: "questions",
          questions: [
            {
              key: "storage",
              question: "Where should X live?",
              options: [{ label: "Reuse A" }, { label: "New entity" }],
              multiple: false,
            },
            {
              key: "rollout",
              question: "When?",
              options: [{ label: "Now" }, { label: "Later" }],
              multiple: false,
            },
          ],
        },
      }),
      paint,
      ctx,
    );
    expect(line).toContain("[questions ×2]: 两个问题");
  });

  it("anchors a spec annotation to its file, lines, version and state", () => {
    const line = renderActivityLine(
      comment({
        body: "这里应该用 mktemp",
        resolved_at: null,
        component: {
          type: "spec_comment",
          anchor: {
            path: "plan.md",
            version: 2,
            line_start: 3,
            line_end: 5,
            col_start: null,
            col_end: null,
            quote: "固定 /tmp 路径",
          },
        },
      }),
      paint,
      ctx,
    );
    expect(line).toContain("commented on plan.md:L3-5 (v2, unresolved) ");
    expect(line).toContain(": 这里应该用 mktemp");
  });

  it("folds an answered-questions event into one line", () => {
    const line = renderActivityLine(
      event({
        event_type: "question_answered",
        payload: {
          comment_id: 757,
          answers: [
            {
              key: "storage",
              selected: [{ index: 0, label: "Reuse mechanism A" }],
              other: null,
              declined: false,
            },
            {
              key: "rollout",
              selected: [],
              other: "next week",
              declined: false,
            },
          ],
        },
      }),
      paint,
      ctx,
    );
    expect(line).toMatch(
      /^T-146 User answered comment 757 .+: storage=Reuse mechanism A; rollout=next week$/,
    );
  });

  /**
   * The two renderers share `eventDetail` precisely so a status change
   * cannot come out worded one way in a watch and another in `issue view`.
   */
  it("words an event exactly as the full timeline renderer does", () => {
    const item = event();
    expect(renderActivityLine(item, paint, ctx)).toBe(
      `T-146 ${renderTimelineItem(item, paint, ctx)}`,
    );
  });

  it("spells a rename inside the parenthetical instead of dumping scalars", () => {
    const line = renderActivityLine(
      event({
        event_type: "title_changed",
        payload: { from: "old title", to: "new title" },
      }),
      paint,
      ctx,
    );
    expect(line).toContain('title_changed ("old title" → "new title")');
  });

  it("uses the ref label it is handed, whatever the stream spells", () => {
    expect(
      renderActivityLine(comment(), paint, { ...ctx, refLabel: "backend/7" }),
    ).toMatch(/^backend\/7 User commented /);
  });
});
