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
  groupTimelineSides,
  hiddenRunKey,
  MERGE_WINDOW_MS,
  netStatusChain,
  type RenderUnit,
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

function comment(atMs: number, hidden = false): TimelineComment {
  return {
    type: "comment",
    id: nextId++,
    author: bot,
    body: "hi",
    component: null,
    created_at: new Date(EPOCH + atMs).toISOString(),
    edited_at: null,
    resolved_at: null,
    hidden_at: hidden ? new Date(EPOCH + atMs).toISOString() : null,
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
    expect(familyOf("cross_referenced")).toBe("referenced");
    expect(familyOf("attachment_added")).toBe("attachments");
    // Every remaining type, so "nothing else" is a claim and not a sample —
    // cross_referenced sat outside both lists and merged nowhere for two
    // releases without a single test going red (T-256).
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
      "deleted",
      "restored",
      "moved_in",
      "moved_out",
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

  it("folds cross-project references into the same run (T-256)", () => {
    const HOURS = 3_600_000;
    const units = groupTimeline([
      event({ event_type: "referenced", payload: { by_issue: 7 }, atMs: 0 }),
      event({
        event_type: "cross_referenced",
        payload: { by_project: "mirror", by_issue: 3 },
        atMs: 4 * HOURS,
      }),
      event({
        event_type: "referenced",
        payload: { by_issue: 8 },
        atMs: 9 * HOURS,
      }),
      event({
        event_type: "cross_referenced",
        payload: { by_project: "mirror", by_issue: 4 },
        atMs: 20 * HOURS,
      }),
    ]);
    // Same family, so the hour-scale gaps windowMsFor exempts apply here too.
    expect(kinds(units)).toEqual(["group:4"]);
  });

  it("emits a lone cross-project reference as a group too (T-256)", () => {
    const units = groupTimeline([
      event({
        event_type: "cross_referenced",
        payload: { by_project: "mirror", by_issue: 3 },
        atMs: 0,
      }),
    ]);
    expect(kinds(units)).toEqual(["group:1"]);
  });

  it("splits a mixed reference run on an interleaved comment", () => {
    const units = groupTimeline([
      event({
        event_type: "cross_referenced",
        payload: { by_project: "mirror", by_issue: 3 },
        atMs: 0,
      }),
      comment(1000),
      event({ event_type: "referenced", payload: { by_issue: 8 }, atMs: 2000 }),
    ]);
    expect(kinds(units)).toEqual(["group:1", "item", "group:1"]);
  });

  it("emits a lone list-family event as a group, unlike other families", () => {
    const lone = groupTimeline([
      event({ event_type: "referenced", payload: { by_issue: 7 }, atMs: 0 }),
    ]);
    expect(kinds(lone)).toEqual(["group:1"]);

    // One file renders with the same header and row as many (T-369), which
    // takes a group to render at all.
    const loneFile = groupTimeline([
      event({
        event_type: "attachment_added",
        payload: { attachment: { id: 5, filename: "one.png" } },
        atMs: 0,
      }),
    ]);
    expect(kinds(loneFile)).toEqual(["group:1"]);

    // Still only those two families: the summary row is what a lone status
    // or label change is for.
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

/** Narrow a unit to one kind, failing the test rather than the type check. */
function unitOf<K extends RenderUnit["kind"]>(
  kind: K,
  unit: RenderUnit | undefined,
): Extract<RenderUnit, { kind: K }> {
  if (unit?.kind !== kind) {
    throw new Error(`expected a ${kind} unit, got ${unit?.kind ?? "none"}`);
  }
  return unit as Extract<RenderUnit, { kind: K }>;
}

describe("groupTimelineSides", () => {
  const file = (n: number, atMs: number, ctx: AgentContext = sessionA) =>
    event({
      event_type: "attachment_added",
      payload: { attachment: { id: n, filename: `seam-${n}.png` } },
      agent_context: ctx,
      atMs,
    });

  /** The shape the card reported: one six-file upload with two files on the
      head side of the seam and four on the tail side. */
  function uploadAcrossTheSeam() {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(i + 1, 47_000 + i * 1000),
    );
    return {
      above: [
        ...Array.from({ length: 47 }, (_, i) => comment(i * 1000)),
        ...files.slice(0, 2),
      ],
      below: [
        ...files.slice(2),
        ...Array.from({ length: 5 }, (_, i) => comment(60_000 + i * 1000)),
      ],
      ids: files.map((e) => e.id),
    };
  }

  it("merges an upload that straddles a closed seam (T-404)", () => {
    const { above, below, ids } = uploadAcrossTheSeam();
    const units = groupTimelineSides(above, below, { gap: false });
    expect(units.below.some((u) => u.kind === "group")).toBe(false);
    const merged = unitOf("group", units.above.at(-1));
    expect(merged.family).toBe("attachments");
    // The ids in order, not the length: six is also what three events
    // duplicated across the seam would come to.
    expect(merged.events.map((e) => e.id)).toEqual(ids);
  });

  it("leaves the sides apart while a fold block sits in the seam", () => {
    const { above, below } = uploadAcrossTheSeam();
    const units = groupTimelineSides(above, below, { gap: true });
    expect(unitOf("group", units.above.at(-1)).events).toHaveLength(2);
    expect(unitOf("group", units.below[0]).events).toHaveLength(4);
  });

  it("cuts at the head side's last item, straddling unit included", () => {
    const above = Array.from({ length: 50 }, (_, i) => comment(i * 1000));
    const below = [file(1, 50_000), file(2, 51_000), file(3, 52_000)];
    const units = groupTimelineSides(above, below, { gap: false });
    expect(units.above).toHaveLength(50);
    expect(unitOf("group", units.below[0]).events).toHaveLength(3);
  });

  it("merges a reference run across the seam, hours apart (T-99)", () => {
    const HOURS = 3_600_000;
    const ref = (byIssue: number, atMs: number) =>
      event({ event_type: "referenced", payload: { by_issue: byIssue }, atMs });
    const xref = (byIssue: number, atMs: number) =>
      event({
        event_type: "cross_referenced",
        payload: { by_project: "mirror", by_issue: byIssue },
        atMs,
      });
    const units = groupTimelineSides(
      [ref(7, 0), xref(3, 5 * HOURS)],
      [ref(8, 11 * HOURS), xref(4, 20 * HOURS)],
      { gap: false },
    );
    const merged = unitOf("group", units.above.at(-1));
    expect(merged.family).toBe("referenced");
    expect(merged.events).toHaveLength(4);
    expect(units.below).toEqual([]);
  });

  it("still splits on a session boundary that falls on the seam", () => {
    const units = groupTimelineSides(
      [file(1, 0, sessionA)],
      [file(2, 1000, sessionB)],
      { gap: false },
    );
    expect(kinds(units.above)).toEqual(["group:1"]);
    expect(kinds(units.below)).toEqual(["group:1"]);
  });

  it("applies the merge window to the seam as to anywhere else", () => {
    const split = groupTimelineSides(
      [file(1, 0)],
      [file(2, MERGE_WINDOW_MS + 1)],
      { gap: false },
    );
    expect(kinds(split.above)).toEqual(["group:1"]);
    expect(kinds(split.below)).toEqual(["group:1"]);

    const merged = groupTimelineSides(
      [file(3, 0)],
      [file(4, MERGE_WINDOW_MS)],
      {
        gap: false,
      },
    );
    expect(kinds(merged.above)).toEqual(["group:2"]);
    expect(merged.below).toEqual([]);
  });

  it("joins a hidden-comment run across the seam (T-281)", () => {
    const above = [comment(0, true), comment(1000, true)];
    const units = groupTimelineSides(
      above,
      [comment(2000, true), comment(3000, true)],
      { gap: false },
    );
    expect(units.below).toEqual([]);
    const run = unitOf("hidden", units.above.at(-1));
    expect(run.comments).toHaveLength(4);
    // The reveal is remembered under the run's first comment, which after
    // the join is the head side's, not the one the tail half started with.
    expect(hiddenRunKey(run)).toBe(`hidden-${above[0]?.id}`);
  });

  it("puts everything on the tail side while the head is still empty", () => {
    const below = [comment(0), file(1, 1000), file(2, 2000)];
    const units = groupTimelineSides([], below, { gap: false });
    expect(units.above).toEqual([]);
    expect(kinds(units.below)).toEqual(["item", "group:2"]);
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
    // Both ends keep their id so the summary can pill them (T-171).
    expect(chain.net).toEqual({
      from: { id: 1, name: "Todo" },
      to: { id: 3, name: "In Progress" },
    });
    expect(chain.isNoop).toBe(false);
    expect(chain.hops).toEqual([
      { from: { id: 1, name: "Todo" }, to: { id: 2, name: "Next" } },
      { from: { id: 2, name: "Next" }, to: { id: 3, name: "In Progress" } },
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
    expect(chain.net).toEqual({
      from: { id: null, name: "?" },
      to: { id: null, name: "?" },
    });
  });
});
