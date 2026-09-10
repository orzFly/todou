import type { TimelineComment, TimelineEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import {
  type ActivityLineContext,
  BARE_SUMMARY_CHARS,
  renderActivityLine,
  renderTimelineItem,
} from "../src/timeline.ts";

/**
 * T-175: a watch prints one entry per block, and a comment's block has to
 * show what was said — whole, since T-283, with the truncated one-line
 * shape kept behind `--summary`. These are the wordings a sentinel reads.
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
  summaryChars: 0,
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
  hidden_at: null,
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
  it("shows a comment body — the point of the exercise", () => {
    const line = renderActivityLine(
      comment({ body: "要在 acme 上开——先把 CLI 发布到镜像里" }),
      paint,
      ctx,
    );
    expect(line).toMatch(
      /^T-146 #comment-757 User commented .+: 要在 acme 上开——先把 CLI 发布到镜像里$/,
    );
    expect(line.split("\n")).toHaveLength(1);
  });

  it("gives a multi-paragraph body its real newlines", () => {
    const line = renderActivityLine(
      comment({ body: "first\n\n  second\tthird  " }),
      paint,
      ctx,
    );
    const lines = line.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.endsWith(": first")).toBe(true);
    // A blank line stays blank rather than collecting the indent, so the
    // paragraph break survives a reader that trims nothing.
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("    second\tthird");
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
      /^T-146 User answered #comment-757 .+: storage=Reuse mechanism A; rollout=next week$/,
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
    ).toMatch(/^backend\/7 #comment-757 User commented /);
  });

  /**
   * The reason folding onto one line was rejected: a fence whose opening
   * and closing markers land on the same line leaves the model reading it
   * unable to tell where the code stops — and that reader is on the path
   * this card is fixing (`--follow=uds`).
   */
  it("leaves a fenced code block inside a body intact", () => {
    const line = renderActivityLine(
      comment({
        body: "环境变量：\n\n```bash\nHERMES_SESSION_PLATFORM=telegram\n```\n\n就这些。",
      }),
      paint,
      ctx,
    );
    const lines = line.split("\n");
    expect(lines.filter((l) => l === "  ```bash")).toHaveLength(1);
    expect(lines.filter((l) => l === "  ```")).toHaveLength(1);
    expect(lines).toContain("  HERMES_SESSION_PLATFORM=telegram");
  });

  it("gives an answer's free text whole, however long", () => {
    const other = "唉，".repeat(100);
    const line = renderActivityLine(
      event({
        event_type: "question_answered",
        payload: {
          comment_id: 757,
          answers: [{ key: "q1", selected: [], other, declined: false }],
        },
      }),
      paint,
      ctx,
    );
    expect(line).toContain(`q1=${other}`);
    expect(line).not.toContain("…");
  });

  it("expands a question comment's questions and option labels", () => {
    const line = renderActivityLine(
      comment({
        body: "两个问题",
        component: {
          type: "questions",
          questions: [
            {
              key: "storage",
              question: "Where should X live?",
              options: [
                { label: "Reuse A", description: "cheaper, but couples them" },
                { label: "New entity" },
              ],
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
    expect(line).toContain("Where should X live?");
    expect(line).toContain("1) Reuse A");
    expect(line).toContain("2) New entity");
    expect(line).toContain("When?");
    // Descriptions are what would multiply the length of an entry nobody
    // asked to read in full; the labels are enough to answer with.
    expect(line).not.toContain("cheaper, but couples them");
  });

  /**
   * T-286: the two lines that are about another card. Both read their titles
   * off `cardOf`, which the batch resolver fills in beside the drain — so
   * every case here is a pure rendering question, network kept out of it.
   */
  describe("cards the entry is about", () => {
    /** The card being read is `todou` (id 2); `acme` (id 7) is elsewhere. */
    const known: ActivityLineContext = {
      ...ctx,
      project: "todou",
      projectId: 2,
      slugOfProject: (id) => (id === 2 ? "todou" : id === 7 ? "acme" : null),
      cardOf: (slug, number) =>
        slug === "todou" && number === 281
          ? { title: "评论 collapse：把中间的探索讨论折叠掉", body: null }
          : slug === "acme" && number === 31
            ? { title: "T-286 probe: watch line shapes", body: null }
            : slug === "todou" && number === 146
              ? {
                  title: "读不到项目时给一条无差别提示",
                  body: "第一行\n第二行",
                }
              : undefined,
    };
    const referenced = (payload: Record<string, unknown>) =>
      event({ event_type: "referenced", payload });

    it("spells a reference from this project its own way, and names the card", () => {
      expect(
        renderActivityLine(
          referenced({ by_project_id: 2, by_issue: 281 }),
          paint,
          known,
        ),
      ).toContain(
        'referenced (by T-281 "评论 collapse：把中间的探索讨论折叠掉")',
      );
    });

    it("carries the project name on a reference from elsewhere", () => {
      expect(
        renderActivityLine(
          referenced({ by_project_id: 7, by_issue: 31 }),
          paint,
          known,
        ),
      ).toContain('referenced (by acme#31 "T-286 probe: watch line shapes")');
    });

    it("reads a pre-T-266 payload's slug, and still names the card", () => {
      expect(
        renderActivityLine(
          referenced({ by_project: "acme", by_issue: 31 }),
          paint,
          known,
        ),
      ).toContain('by acme#31 "T-286 probe: watch line shapes"');
    });

    it("appends the comment the mention was written in", () => {
      expect(
        renderActivityLine(
          referenced({ by_project_id: 7, by_issue: 31, by_comment: 4242 }),
          paint,
          known,
        ),
      ).toContain('by acme#31 "T-286 probe: watch line shapes" #comment-4242');
    });

    /**
     * A project id nobody can name is the one shape that never gets a title:
     * there is no slug to ask for the card under. The ref still pastes back —
     * the server reads an id wherever it reads a slug.
     */
    it("keeps the bare id spelling when no project here can name it", () => {
      expect(
        renderActivityLine(
          referenced({ by_project_id: 99, by_issue: 7 }),
          paint,
          known,
        ),
      ).toContain("referenced (by 99/7)");
    });

    it("loses only the title when the card could not be read", () => {
      expect(
        renderActivityLine(
          referenced({ by_project_id: 2, by_issue: 999 }),
          paint,
          known,
        ),
      ).toContain("referenced (by T-999)");
    });

    it("gives a title in full under --summary, header being no body", () => {
      const title = "长".repeat(88);
      const line = renderActivityLine(
        referenced({ by_project_id: 2, by_issue: 281 }),
        paint,
        {
          ...known,
          summaryChars: BARE_SUMMARY_CHARS,
          cardOf: () => ({ title, body: null }),
        },
      );
      expect(line).toContain(`by T-281 "${title}"`);
      expect(line.split("\n")).toHaveLength(1);
    });

    const opened = event({ event_type: "opened", payload: {} });

    it("gives an opened card its title on the header and its body below", () => {
      const lines = renderActivityLine(opened, paint, known).split("\n");
      expect(lines[0]).toMatch(
        /^T-146 User opened "读不到项目时给一条无差别提示" .+: 第一行$/,
      );
      expect(lines[1]).toBe("  第二行");
    });

    it("ends an empty-bodied card's line at the time, with no colon", () => {
      const line = renderActivityLine(opened, paint, {
        ...known,
        cardOf: () => ({ title: "空正文", body: "" }),
      });
      expect(line).toMatch(/^T-146 User opened "空正文" .+ ago$/);
      expect(line).not.toContain(":");
    });

    it("cuts the body under --summary and never the title", () => {
      const title = "长".repeat(88);
      const line = renderActivityLine(opened, paint, {
        ...known,
        summaryChars: BARE_SUMMARY_CHARS,
        cardOf: () => ({ title, body: `开头\n\n${"很长的正文。".repeat(40)}` }),
      });
      expect(line.split("\n")).toHaveLength(1);
      expect(line).toContain(`opened "${title}"`);
      expect(line.endsWith("…")).toBe(true);
    });

    it("leaves today's line alone when the card could not be resolved", () => {
      expect(
        renderActivityLine(opened, paint, {
          ...known,
          cardOf: () => undefined,
        }),
      ).toMatch(/^T-146 User opened .+ ago$/);
    });

    /**
     * Every caller that hands over no resolver at all — `issue view`'s
     * timeline among them — keeps the output it had.
     */
    it("leaves today's line alone when nobody passes a resolver", () => {
      expect(renderActivityLine(opened, paint, ctx)).toMatch(
        /^T-146 User opened .+ ago$/,
      );
      expect(
        renderActivityLine(
          referenced({ by_project_id: 2, by_issue: 281 }),
          paint,
          { ...ctx, projectId: 2 },
        ),
      ).toContain("referenced (by T-281)");
    });
  });

  describe("--summary", () => {
    const capped: ActivityLineContext = {
      ...ctx,
      summaryChars: BARE_SUMMARY_CHARS,
    };

    it("folds a multi-line body back onto exactly one line", () => {
      const line = renderActivityLine(
        comment({ body: `开头\n\n${"很长的中文正文。".repeat(30)}` }),
        paint,
        capped,
      );
      expect(line.split("\n")).toHaveLength(1);
      expect(line.endsWith("…")).toBe(true);
    });

    it("keeps the questions badge but drops the block it heads", () => {
      const line = renderActivityLine(
        comment({
          body: "一个问题",
          component: {
            type: "questions",
            questions: [
              {
                key: "storage",
                question: "Where should X live?",
                options: [{ label: "Reuse A" }],
                multiple: false,
              },
            ],
          },
        }),
        paint,
        capped,
      );
      expect(line).toContain("[questions ×1]: 一个问题");
      expect(line).not.toContain("Where should X live?");
      expect(line.split("\n")).toHaveLength(1);
    });
  });

  describe("agent provenance", () => {
    const context = {
      agent: "claude-code",
      session_id: "9de4032d-4325-4337-943f-f0f0c14cac9c",
    };

    it("names the harness and session of a comment an agent wrote", () => {
      expect(
        renderActivityLine(comment({ agent_context: context }), paint, ctx),
      ).toContain(
        "User (claude-code, 9de4032d-4325-4337-943f-f0f0c14cac9c) commented",
      );
    });

    it("names them on an event too", () => {
      expect(
        renderActivityLine(event({ agent_context: context }), paint, ctx),
      ).toContain(
        "User (claude-code, 9de4032d-4325-4337-943f-f0f0c14cac9c) status_changed",
      );
    });

    it("adds nothing at all for a write with no agent behind it", () => {
      expect(renderActivityLine(comment(), paint, ctx)).not.toContain("(");
      expect(renderActivityLine(event(), paint, ctx)).toContain(
        "User status_changed",
      );
    });

    it("prints the harness alone when no session came with it", () => {
      expect(
        renderActivityLine(
          comment({ agent_context: { agent: "hermes-agent" } }),
          paint,
          ctx,
        ),
      ).toContain("User (hermes-agent) commented");
    });
  });
});

describe("renderTimelineItem", () => {
  it("heads every comment with its id, asked for or not", () => {
    expect(renderTimelineItem(comment(), paint, ctx)).toMatch(
      /^#comment-757 · User commented /,
    );
  });

  it("names the agent behind a comment", () => {
    expect(
      renderTimelineItem(
        comment({ agent_context: { agent: "claude-code", session_id: "abc" } }),
        paint,
        ctx,
      ),
    ).toContain("User (claude-code, abc) commented");
  });

  it("spells an answered event's target as a pastable comment ref", () => {
    expect(
      renderTimelineItem(
        event({
          event_type: "question_answered",
          payload: {
            comment_id: 757,
            answers: [
              { key: "q1", selected: [], other: "yes", declined: false },
            ],
          },
        }),
        paint,
        ctx,
      ),
    ).toContain("answered #comment-757");
  });
});
