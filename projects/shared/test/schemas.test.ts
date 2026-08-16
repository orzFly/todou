import { describe, expect, it } from "vitest";
import {
  ChangeEvent,
  IssueCreateInput,
  IssueListQuery,
  Label,
  LabelName,
  LabelUpdateInput,
  Login,
  ProjectSlug,
  TimelineComment,
  TimelineItem,
  TokenCreateInput,
} from "../src/index.ts";

describe("ProjectSlug", () => {
  it("accepts lowercase slugs", () => {
    expect(ProjectSlug.parse("todou-core")).toBe("todou-core");
  });

  it("rejects uppercase and leading dash", () => {
    expect(ProjectSlug.safeParse("Todou").success).toBe(false);
    expect(ProjectSlug.safeParse("-x").success).toBe(false);
  });
});

describe("Login", () => {
  it("accepts machine-style logins", () => {
    expect(Login.parse("review-bot")).toBe("review-bot");
  });
});

describe("IssueCreateInput", () => {
  it("defaults body and id arrays", () => {
    const parsed = IssueCreateInput.parse({ title: "Dig potatoes" });
    expect(parsed.body).toBe("");
    expect(parsed.assignee_ids).toEqual([]);
    expect(parsed.label_ids).toEqual([]);
  });

  it("rejects empty titles", () => {
    expect(IssueCreateInput.safeParse({ title: "" }).success).toBe(false);
  });
});

describe("IssueListQuery", () => {
  it("parses csv ids and coerces numbers from query strings", () => {
    const parsed = IssueListQuery.parse({
      status: "1,2,3",
      assignee: "7",
      limit: "50",
    });
    expect(parsed.status).toEqual([1, 2, 3]);
    expect(parsed.assignee).toBe(7);
    expect(parsed.limit).toBe(50);
    expect(parsed.sort).toBe("created");
    expect(parsed.order).toBe("desc");
  });

  it("rejects malformed csv", () => {
    expect(IssueListQuery.safeParse({ status: "1,x" }).success).toBe(false);
  });
});

describe("TimelineItem", () => {
  const author = {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  };

  it("discriminates comments from events", () => {
    const comment = TimelineItem.parse({
      type: "comment",
      id: 1,
      author,
      body: "hello",
      created_at: "2026-08-11T12:00:00Z",
      edited_at: null,
      agent_context: null,
    });
    expect(comment.type).toBe("comment");

    const event = TimelineItem.parse({
      type: "event",
      id: 2,
      event_type: "status_changed",
      actor: author,
      payload: { from: "Todo", to: "Done" },
      created_at: "2026-08-11T12:00:01Z",
      agent_context: null,
    });
    expect(event.type).toBe("event");
  });

  it("rejects unknown event types", () => {
    const bad = TimelineItem.safeParse({
      type: "event",
      id: 3,
      event_type: "exploded",
      actor: author,
      payload: {},
      created_at: "2026-08-11T12:00:00Z",
    });
    expect(bad.success).toBe(false);
  });
});

describe("TokenCreateInput", () => {
  it("accepts a name without expiry", () => {
    expect(TokenCreateInput.parse({ name: "ci" }).expires_at).toBeUndefined();
  });
});

describe("ChangeEvent", () => {
  it("parses pointer events", () => {
    const e = ChangeEvent.parse({
      entity: "timeline",
      id: 12,
      action: "created",
      issue_number: 42,
    });
    expect(e.issue_number).toBe(42);
  });
});

describe("AgentContext on timeline items", () => {
  const base = {
    type: "comment",
    id: 1,
    author: {
      id: 2,
      login: "claude",
      display_name: "Claude",
      kind: "machine",
      avatar_url: null,
      owner: null,
    },
    body: "hi",
    created_at: "2026-08-11T00:00:00Z",
    edited_at: null,
  };

  it("accepts null and populated agent_context, rejects missing", () => {
    // The server always emits the field; a missing one is a contract break.
    expect(TimelineComment.safeParse(base).success).toBe(false);
    expect(
      TimelineComment.safeParse({ ...base, agent_context: null }).success,
    ).toBe(true);
    const populated = TimelineComment.safeParse({
      ...base,
      agent_context: {
        agent: "claude-code",
        session_id: "s",
        model: "claude-fable-5",
      },
    });
    expect(populated.success).toBe(true);
  });

  it("rejects malformed agent_context", () => {
    expect(
      TimelineComment.safeParse({ ...base, agent_context: { agent: "" } })
        .success,
    ).toBe(false);
  });
});

describe("LabelName (T-136)", () => {
  it("canonicalizes whitespace", () => {
    expect(LabelName.parse("  area:   cli  ")).toBe("area: cli");
  });

  it("refuses commas and names that collapse to nothing", () => {
    expect(LabelName.safeParse("a,b").success).toBe(false);
    expect(LabelName.safeParse("   ").success).toBe(false);
    expect(LabelName.safeParse("x".repeat(61)).success).toBe(false);
  });

  it("measures the length after canonicalizing, not before", () => {
    expect(LabelName.parse(`  ${"x".repeat(60)}  `)).toHaveLength(60);
  });

  it("leaves the read schema permissive so old rows stay readable", () => {
    // A label stored before the rule existed must still list, and must
    // still be renameable to something legal.
    const stored = Label.parse({ id: 1, name: "a,b", color: "#3b82f6" });
    expect(stored.name).toBe("a,b");
    expect(LabelUpdateInput.parse({ name: "a b" }).name).toBe("a b");
  });
});
