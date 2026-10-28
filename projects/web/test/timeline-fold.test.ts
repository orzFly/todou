import type {
  AgentContext,
  TimelineEvent,
  TimelineItem,
  UserRef,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { foldTimeline } from "../src/components/timeline/fold-events.ts";
import {
  groupTimeline,
  MERGE_WINDOW_MS,
  type RenderUnit,
} from "../src/components/timeline/group-events.ts";

const bot: UserRef = {
  id: 2,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine",
  avatar_url: null,
  owner: { id: 1, login: "alice" },
};

const alice: UserRef = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const sessionA: AgentContext = {
  agent: "claude-code",
  model: "model-alpha",
  session_id: "session-a",
};
const sessionB: AgentContext = { ...sessionA, session_id: "session-b" };

/** This card's own project; card 5 and friends live here too. */
const HERE = 1;
const EPOCH = Date.parse("2026-10-27T04:00:00.000Z");

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
    payload: {},
    created_at: new Date(EPOCH + atMs).toISOString(),
    agent_context: sessionA,
    ...rest,
  };
}

const block = (
  type: "block_added" | "block_removed",
  other: number,
  atMs: number,
  overrides: Partial<TimelineEvent> & { edge?: number; role?: string } = {},
) => {
  const { edge = 9000 + other, role = "blocked", ...rest } = overrides;
  return event({
    event_type: type,
    payload: {
      edge_id: edge,
      role,
      other_project_id: HERE,
      other_number: other,
    },
    atMs,
    ...rest,
  });
};

/** A reference from card `by` in this project, spelled the way a local
    reference is stored: no project field at all. */
const ref = (
  by: number,
  atMs: number,
  overrides: Partial<TimelineEvent> & {
    payload?: Record<string, unknown>;
  } = {},
) =>
  event({
    event_type: "referenced",
    payload: { by_issue: by },
    atMs,
    ...overrides,
  });

const ids = (items: TimelineItem[]) => items.map((i) => i.id);
const kinds = (units: RenderUnit[]) =>
  units.map((u) =>
    u.kind === "group" ? `${u.family}:${u.events.length}` : "item",
  );

describe("foldTimeline · R2, an edge added and dropped again", () => {
  it("cancels into a host that follows it", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000);
    const host = block("block_added", 8, 2000);
    const result = foldTimeline([add, remove, host]);
    expect(ids(result.items)).toEqual([host.id]);
    expect(result.folds.get(host.id)?.undone).toEqual([add, remove]);
  });

  it("cancels into a host that precedes it", () => {
    const host = block("block_added", 8, 0);
    const add = block("block_added", 7, 1000);
    const remove = block("block_removed", 7, 2000);
    const result = foldTimeline([host, add, remove]);
    expect(ids(result.items)).toEqual([host.id]);
    expect(result.folds.get(host.id)?.undone).toEqual([add, remove]);
  });

  it("prefers the host after it over the one before", () => {
    const before = block("block_added", 8, 0);
    const add = block("block_added", 7, 1000);
    const remove = block("block_removed", 7, 2000);
    const after = block("block_added", 9, 3000);
    const result = foldTimeline([before, add, remove, after]);
    expect(result.folds.get(after.id)?.undone).toHaveLength(2);
    expect(result.folds.has(before.id)).toBe(false);
  });

  it("keeps the add of a round trip with no host, and says what undid it", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000);
    const result = foldTimeline([add, remove]);
    expect(ids(result.items)).toEqual([add.id]);
    expect(result.folds.size).toBe(0);
    expect(result.hostOf.size).toBe(0);
    expect(result.roundTrips).toEqual(new Map([[add.id, remove]]));
  });

  it("keeps every add of an operation that was all round trips", () => {
    const add7 = block("block_added", 7, 0);
    const add8 = block("block_added", 8, 100);
    const remove8 = block("block_removed", 8, 10_000);
    const remove7 = block("block_removed", 7, 10_100);
    const result = foldTimeline([add7, add8, remove8, remove7]);
    expect(ids(result.items)).toEqual([add7.id, add8.id]);
    expect(result.roundTrips.get(add7.id)).toBe(remove7);
    expect(result.roundTrips.get(add8.id)).toBe(remove8);
  });

  it("takes no round trip where a host absorbs the pair", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000);
    const host = block("block_added", 8, 2000);
    expect(foldTimeline([add, remove, host]).roundTrips.size).toBe(0);
  });

  it("leaves a lone add or a lone remove alone", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 8, 1000);
    const result = foldTimeline([add, remove]);
    expect(ids(result.items)).toEqual([add.id, remove.id]);
    expect(result.roundTrips.size).toBe(0);
  });

  it("does not pair different edges", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000, { edge: 1 });
    const host = block("block_added", 8, 2000);
    expect(foldTimeline([add, remove, host]).folds.size).toBe(0);
  });

  it("does not pair across sessions", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000, {
      agent_context: sessionB,
    });
    const host = block("block_added", 8, 2000);
    expect(foldTimeline([add, remove, host]).folds.size).toBe(0);
  });

  it("does not pair past the window", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, MERGE_WINDOW_MS + 1);
    const host = block("block_added", 8, MERGE_WINDOW_MS + 2);
    expect(foldTimeline([add, remove, host]).folds.size).toBe(0);
  });

  it("needs its host in the same session", () => {
    const add = block("block_added", 7, 0);
    const remove = block("block_removed", 7, 1000);
    const host = block("block_added", 8, 2000, { agent_context: sessionB });
    expect(foldTimeline([add, remove, host]).folds.size).toBe(0);
  });
});

describe("foldTimeline · R1, a reference the block covers", () => {
  it("folds a reference written just before the block", () => {
    const r = ref(5, 0);
    const b = block("block_added", 5, 1000);
    const result = foldTimeline([r, b], { projectId: HERE });
    expect(ids(result.items)).toEqual([b.id]);
    expect(result.folds.get(b.id)?.references).toEqual([r]);
  });

  it("folds a reference written just after the block", () => {
    const b = block("block_added", 5, 0);
    const r = ref(5, 1000);
    const result = foldTimeline([b, r], { projectId: HERE });
    expect(ids(result.items)).toEqual([b.id]);
  });

  it("matches the actor and not the session", () => {
    const r = ref(5, 0, { agent_context: sessionB });
    const b = block("block_added", 5, 1000);
    expect(foldTimeline([r, b], { projectId: HERE }).hostOf.get(r.id)).toBe(
      b.id,
    );
  });

  it("leaves another actor's reference alone", () => {
    const r = ref(5, 0, { actor: alice, agent_context: null });
    const b = block("block_added", 5, 1000);
    expect(foldTimeline([r, b], { projectId: HERE }).folds.size).toBe(0);
  });

  it("leaves a reference past the window alone", () => {
    const r = ref(5, 0);
    const b = block("block_added", 5, MERGE_WINDOW_MS + 1);
    expect(foldTimeline([r, b], { projectId: HERE }).folds.size).toBe(0);
  });

  it("leaves it alone when the only match was undone", () => {
    const r = ref(5, 0);
    const add = block("block_added", 5, 1000);
    const remove = block("block_removed", 5, 2000);
    const host = block("block_added", 8, 3000);
    const result = foldTimeline([r, add, remove, host], { projectId: HERE });
    expect(result.hostOf.has(r.id)).toBe(false);
    expect(result.folds.get(host.id)?.undone).toEqual([add, remove]);
    expect(ids(result.items)).toEqual([r.id, host.id]);
  });

  it("leaves it alone when the only match was a round trip", () => {
    const r = ref(5, 0);
    const add = block("block_added", 5, 1000);
    const remove = block("block_removed", 5, 2000);
    const result = foldTimeline([r, add, remove], { projectId: HERE });
    expect(result.hostOf.has(r.id)).toBe(false);
    expect(ids(result.items)).toEqual([r.id, add.id]);
  });

  it("does not fold under a removal", () => {
    const r = ref(5, 0);
    const b = block("block_removed", 5, 1000);
    expect(foldTimeline([r, b], { projectId: HERE }).folds.size).toBe(0);
  });

  it("does not fold a slug-only reference", () => {
    const r = ref(5, 0, { payload: { by_project: "todou", by_issue: 5 } });
    const b = block("block_added", 5, 1000);
    expect(foldTimeline([r, b], { projectId: HERE }).folds.size).toBe(0);
  });

  it("matches a local reference only once the project id is known", () => {
    const r = ref(5, 0);
    const b = block("block_added", 5, 1000);
    expect(foldTimeline([r, b]).folds.size).toBe(0);
    expect(foldTimeline([r, b], { projectId: HERE }).folds.size).toBe(1);
  });

  it("matches a cross-project reference by its project id", () => {
    const r = event({
      event_type: "cross_referenced",
      payload: { by_project: "mirror", by_project_id: 2, by_issue: 3 },
      atMs: 0,
    });
    const b = event({
      event_type: "block_added",
      payload: {
        edge_id: 1,
        role: "blocker",
        other_project_id: 2,
        other_number: 3,
      },
      atMs: 1000,
    });
    const result = foldTimeline([r, b], { projectId: HERE });
    expect(result.hostOf.get(r.id)).toBe(b.id);
  });

  it("folds a reference from a comment as well", () => {
    const r = ref(5, 0, { payload: { by_issue: 5, by_comment: 77 } });
    const b = block("block_added", 5, 1000);
    expect(foldTimeline([r, b], { projectId: HERE }).hostOf.get(r.id)).toBe(
      b.id,
    );
  });

  it("takes the nearest of several hosts", () => {
    const far = block("block_added", 5, 0, { edge: 1 });
    const r = ref(5, 60_000);
    const near = block("block_added", 5, 70_000, { edge: 2 });
    const result = foldTimeline([far, r, near], { projectId: HERE });
    expect(result.hostOf.get(r.id)).toBe(near.id);
  });

  it("drops a reference group that was folded whole", () => {
    const refs = [ref(5, 0), ref(6, 100)];
    const blocks = [
      block("block_added", 5, 1000),
      block("block_added", 6, 1100),
    ];
    const result = foldTimeline([...refs, ...blocks], { projectId: HERE });
    expect(kinds(groupTimeline(result.items))).toEqual(["block_added:2"]);
  });

  it("keeps the rest of a reference group that was folded in part", () => {
    const refs = [ref(5, 0), ref(6, 100), ref(42, 200)];
    const b = block("block_added", 5, 1000);
    const result = foldTimeline([...refs, b], { projectId: HERE });
    expect(kinds(groupTimeline(result.items))).toEqual([
      "referenced:2",
      "block_added:1",
    ]);
  });
});

describe("foldTimeline · expansion", () => {
  /** Five references, four of them covered, and a round trip on the side. */
  function operation() {
    const refs = [
      ref(5, 0),
      ref(6, 100),
      ref(7, 200),
      ref(8, 300),
      ref(42, 400),
    ];
    const blocks = [5, 6, 7, 8].map((n, i) =>
      block("block_added", n, 1000 + i * 100),
    );
    const add = block("block_added", 9, 1500);
    const remove = block("block_removed", 9, 1600);
    return { items: [...refs, ...blocks, add, remove], blocks };
  }

  it("puts everything back where it was for an opened host", () => {
    const { items, blocks } = operation();
    const result = foldTimeline(items, {
      projectId: HERE,
      isExpanded: () => true,
    });
    expect(result.items).toEqual(items);
    expect(kinds(groupTimeline(result.items))).toEqual([
      "referenced:5",
      "block_added:5",
      "block_removed:1",
    ]);
    // Opening changes what is on the page, not what each host absorbs.
    const collapsed = foldTimeline(items, { projectId: HERE });
    expect(result.folds).toEqual(collapsed.folds);
    expect(result.hostOf).toEqual(collapsed.hostOf);
    expect(result.folds.get(blocks[3]?.id ?? 0)?.undone).toHaveLength(2);
  });

  it("brings back only what the opened host absorbed", () => {
    const { items, blocks } = operation();
    const opened = blocks[0]?.id;
    const result = foldTimeline(items, {
      projectId: HERE,
      isExpanded: (id) => id === opened,
    });
    expect(kinds(groupTimeline(result.items))).toEqual([
      "referenced:2",
      "block_added:4",
    ]);
  });

  it("names every absorbed event's host, and only those", () => {
    const { items } = operation();
    const { folds, hostOf } = foldTimeline(items, { projectId: HERE });
    const fromFolds = new Map<number, number>();
    for (const [host, fold] of folds) {
      for (const e of [...fold.references, ...fold.undone]) {
        fromFolds.set(e.id, host);
      }
    }
    expect(fromFolds).toEqual(hostOf);
    expect(hostOf.size).toBe(6);
  });
});
