import type {
  AgentContext,
  TimelineComment,
  TimelineEvent,
  UserRef,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  familyOf,
  groupKey,
  groupTimeline,
  MERGE_WINDOW_MS,
  netStatusChain,
} from "../src/components/timeline/group-events.ts";

const human: UserRef = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const bot: UserRef = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
};

const sessionA: AgentContext = {
  agent: "claude-code",
  model: "model-alpha",
  session_id: "session-a",
};
const sessionB: AgentContext = {
  agent: "claude-code",
  model: "model-alpha",
  session_id: "session-b",
};

const EPOCH = Date.parse("2026-08-13T12:00:00.000Z");

let nextId = 1;
function event(
  overrides: Partial<TimelineEvent> & { atMs?: number },
): TimelineEvent {
  const { atMs = 0, ...rest } = overrides;
  return {
    type: "event",
    id: nextId++,
    event_type: "label_added",
    actor: bot,
    payload: { label: { id: 1, name: "bug", color: "#f00" } },
    created_at: new Date(EPOCH + atMs).toISOString(),
    agent_context: sessionA,
    ...rest,
  };
}

function comment(atMs: number): TimelineComment {
  return {
    type: "comment",
    id: nextId++,
    author: bot,
    body: "hi",
    component: null,
    created_at: new Date(EPOCH + atMs).toISOString(),
    edited_at: null,
    resolved_at: null,
    agent_context: sessionA,
  };
}

const kinds = (units: ReturnType<typeof groupTimeline>) =>
  units.map((u) => (u.kind === "group" ? `group:${u.events.length}` : "item"));

describe("familyOf", () => {
  it("maps the mergeable vocabulary and nothing else", () => {
    expect(familyOf("status_changed")).toBe("status");
    expect(familyOf("label_added")).toBe("labels");
    expect(familyOf("label_removed")).toBe("labels");
    expect(familyOf("referenced")).toBe("referenced");
    expect(familyOf("attachment_added")).toBe("attachments");
    for (const standalone of [
      "opened",
      "closed",
      "reopened",
      "title_changed",
      "assigned",
      "unassigned",
      "question_answered",
      "spec_pushed",
      "spec_review",
      "spec_comments_resolved",
    ] as const) {
      expect(familyOf(standalone)).toBeNull();
    }
  });
});

describe("groupKey", () => {
  it("distinguishes sessions of the same account", () => {
    expect(groupKey(event({ agent_context: sessionA }))).not.toBe(
      groupKey(event({ agent_context: sessionB })),
    );
  });

  it("distinguishes a null context from a partial one", () => {
    expect(groupKey(event({ agent_context: null }))).not.toBe(
      groupKey(event({ agent_context: { agent: "claude-code" } })),
    );
  });

  it("matches context-less events of the same actor", () => {
    expect(groupKey(event({ actor: human, agent_context: null }))).toBe(
      groupKey(event({ actor: human, agent_context: null })),
    );
  });
});

describe("groupTimeline", () => {
  it("merges an adjacent same-family run and leaves singles plain", () => {
    const units = groupTimeline([
      event({ event_type: "opened", payload: {}, atMs: 0 }),
      event({ atMs: 1000 }),
      event({ atMs: 2000 }),
      event({ atMs: 3000 }),
    ]);
    expect(kinds(units)).toEqual(["item", "group:3"]);
  });

  it("merges exactly at the window bound and splits just past it", () => {
    const merged = groupTimeline([
      event({ atMs: 0 }),
      event({ atMs: MERGE_WINDOW_MS }),
    ]);
    expect(kinds(merged)).toEqual(["group:2"]);

    const split = groupTimeline([
      event({ atMs: 0 }),
      event({ atMs: MERGE_WINDOW_MS + 1 }),
    ]);
    expect(kinds(split)).toEqual(["item", "item"]);
  });

  it("windows against the previous event, not the run start", () => {
    const units = groupTimeline([
      event({ atMs: 0 }),
      event({ atMs: MERGE_WINDOW_MS - 1000 }),
      event({ atMs: 2 * MERGE_WINDOW_MS - 2000 }),
    ]);
    expect(kinds(units)).toEqual(["group:3"]);
  });

  it("merges adjacent references regardless of the window (T-99)", () => {
    const HOURS = 3_600_000;
    const units = groupTimeline([
      event({ event_type: "referenced", payload: { by_issue: 7 }, atMs: 0 }),
      event({
        event_type: "referenced",
        payload: { by_issue: 8 },
        atMs: 3 * HOURS,
      }),
      event({
        event_type: "referenced",
        payload: { by_issue: 9 },
        atMs: 9 * HOURS,
      }),
    ]);
    expect(kinds(units)).toEqual(["group:3"]);
  });

  it("still splits windowless references on an interleaved comment", () => {
    const units = groupTimeline([
      event({ event_type: "referenced", payload: { by_issue: 7 }, atMs: 0 }),
      comment(1000),
      event({ event_type: "referenced", payload: { by_issue: 8 }, atMs: 2000 }),
    ]);
    expect(kinds(units)).toEqual(["group:1", "item", "group:1"]);
  });

  it("still splits windowless references on a session boundary", () => {
    const units = groupTimeline([
      event({
        event_type: "referenced",
        payload: { by_issue: 7 },
        agent_context: sessionA,
        atMs: 0,
      }),
      event({
        event_type: "referenced",
        payload: { by_issue: 8 },
        agent_context: sessionB,
        atMs: 1000,
      }),
    ]);
    expect(kinds(units)).toEqual(["group:1", "group:1"]);
  });

  it("emits a lone referenced event as a group, unlike other families", () => {
    const lone = groupTimeline([
      event({ event_type: "referenced", payload: { by_issue: 7 }, atMs: 0 }),
    ]);
    expect(kinds(lone)).toEqual(["group:1"]);

    const loneLabel = groupTimeline([event({ atMs: 0 })]);
    expect(kinds(loneLabel)).toEqual(["item"]);
  });

  it("splits runs on a session boundary", () => {
    const units = groupTimeline([
      event({ agent_context: sessionA, atMs: 0 }),
      event({ agent_context: sessionB, atMs: 1000 }),
    ]);
    expect(kinds(units)).toEqual(["item", "item"]);
  });

  it("mixes label_added and label_removed into one labels group", () => {
    const units = groupTimeline([
      event({ event_type: "label_added", atMs: 0 }),
      event({ event_type: "label_removed", atMs: 1000 }),
    ]);
    expect(kinds(units)).toEqual(["group:2"]);
  });

  it("never merges across families", () => {
    const units = groupTimeline([
      event({ event_type: "label_added", atMs: 0 }),
      event({
        event_type: "status_changed",
        payload: {
          from: { id: 1, name: "Todo" },
          to: { id: 2, name: "Next" },
        },
        atMs: 1000,
      }),
      event({ event_type: "label_added", atMs: 2000 }),
    ]);
    expect(kinds(units)).toEqual(["item", "item", "item"]);
  });

  it("splits runs on an interleaved comment", () => {
    const units = groupTimeline([
      event({ atMs: 0 }),
      comment(1000),
      event({ atMs: 2000 }),
    ]);
    expect(kinds(units)).toEqual(["item", "item", "item"]);
  });

  it("keeps standalone types out of groups", () => {
    const units = groupTimeline([
      event({ event_type: "spec_pushed", payload: { version: 1 }, atMs: 0 }),
      event({ event_type: "spec_pushed", payload: { version: 2 }, atMs: 1000 }),
    ]);
    expect(kinds(units)).toEqual(["item", "item"]);
  });

  it("preserves timeline order across units", () => {
    const a = event({ atMs: 0 });
    const c = comment(1000);
    const b1 = event({ atMs: 2000 });
    const b2 = event({ atMs: 3000 });
    const units = groupTimeline([a, c, b1, b2]);
    expect(units[0]).toEqual({ kind: "item", item: a });
    expect(units[1]).toEqual({ kind: "item", item: c });
    expect(units[2]).toEqual({
      kind: "group",
      family: "labels",
      events: [b1, b2],
    });
  });
});

describe("netStatusChain", () => {
  const move = (
    from: [number, string],
    to: [number, string],
    atMs: number,
  ): TimelineEvent =>
    event({
      event_type: "status_changed",
      payload: {
        from: { id: from[0], name: from[1] },
        to: { id: to[0], name: to[1] },
      },
      atMs,
    });

  it("collapses a transitive chain to its net transition", () => {
    const chain = netStatusChain([
      move([1, "Todo"], [2, "Next"], 0),
      move([2, "Next"], [3, "In Progress"], 1000),
    ]);
    expect(chain.net).toEqual({ from: "Todo", to: "In Progress" });
    expect(chain.isNoop).toBe(false);
    expect(chain.hops).toEqual([
      { from: "Todo", to: "Next" },
      { from: "Next", to: "In Progress" },
    ]);
  });

  it("flags a round trip as noop by id", () => {
    const chain = netStatusChain([
      move([1, "Todo"], [2, "Next"], 0),
      move([2, "Next"], [1, "Todo"], 1000),
    ]);
    expect(chain.isNoop).toBe(true);
    expect(chain.hops).toHaveLength(2);
  });

  it("falls back to name comparison when ids are missing", () => {
    const chain = netStatusChain([
      event({
        event_type: "status_changed",
        payload: { from: { name: "Todo" }, to: { name: "Next" } },
        atMs: 0,
      }),
      event({
        event_type: "status_changed",
        payload: { from: { name: "Next" }, to: { name: "Todo" } },
        atMs: 1000,
      }),
    ]);
    expect(chain.isNoop).toBe(true);
  });

  it("tolerates malformed payloads with ? placeholders", () => {
    const chain = netStatusChain([
      event({ event_type: "status_changed", payload: {}, atMs: 0 }),
    ]);
    expect(chain.net).toEqual({ from: "?", to: "?" });
  });
});
