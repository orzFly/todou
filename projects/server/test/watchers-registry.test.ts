import type { ChangeEvent } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events/bus.ts";
import {
  type WatcherClock,
  type WatcherRegistration,
  WatcherRegistry,
} from "../src/events/watchers.ts";

/** Timers that only fire when the test says so. */
function fakeClock() {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: WatcherClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function setup() {
  const bus = new EventBus();
  const published: Array<[number, ChangeEvent]> = [];
  bus.subscribe((projectId, event) => published.push([projectId, event]));
  const time = fakeClock();
  const registry = new WatcherRegistry(bus, { clock: time.clock });
  return { registry, published, time };
}

function reg(over: Partial<WatcherRegistration> = {}): WatcherRegistration {
  return {
    userId: 1,
    agentContext: { agent: "claude-code", session_id: "s1" },
    kind: "watch",
    connectionId: "c1",
    scopes: { projects: [10], issues: [] },
    ...over,
  };
}

describe("WatcherRegistry (T-540)", () => {
  it("lists a registration and publishes once per touched project", () => {
    const { registry, published } = setup();
    registry.register(
      reg({
        scopes: {
          projects: [10],
          issues: [
            [10, 3],
            [20, 5],
          ],
        },
      }),
    );
    expect(registry.projectWatchers(10).map((w) => w.scope)).toEqual([
      "project",
    ]);
    expect([...registry.issueWatchers(10).keys()]).toEqual([3]);
    expect([...registry.issueWatchers(20).keys()]).toEqual([5]);
    // Project 10 holds a project-level scope, so its event is project-wide;
    // project 20 only one card, so the event names it.
    expect(published).toEqual([
      [10, { entity: "watchers", action: "updated", id: 10 }],
      [20, { entity: "watchers", action: "updated", id: 20, issue_number: 5 }],
    ]);
  });

  it("keeps a released watcher for the linger, then removes it and publishes", () => {
    const { registry, published, time } = setup();
    const handle = registry.register(reg());
    published.length = 0;
    handle.release();
    time.advance(14_999);
    expect(registry.projectWatchers(10)).toHaveLength(1);
    expect(published).toEqual([]);
    time.advance(1);
    expect(registry.projectWatchers(10)).toEqual([]);
    expect(published).toEqual([
      [10, { entity: "watchers", action: "updated", id: 10 }],
    ]);
  });

  it("publishes an expiry once for every project the entry touched", () => {
    const { registry, published, time } = setup();
    registry
      .register(
        reg({
          scopes: {
            projects: [10, 20],
            issues: [[30, 1]],
          },
        }),
      )
      .release();
    published.length = 0;
    time.advance(15_000);
    expect(published.map(([id]) => id).sort()).toEqual([10, 20, 30]);
  });

  it("lets a reconnect inside the linger take over, keeping since and staying quiet", () => {
    const { registry, published, time } = setup();
    const first = registry.register(reg({ connectionId: "c1" }));
    const since = registry.projectWatchers(10)[0]?.since;
    first.release();
    time.advance(5_000);
    published.length = 0;
    registry.register(reg({ connectionId: "c2" }));
    time.advance(60_000);
    expect(published).toEqual([]);
    expect(registry.projectWatchers(10).map((w) => w.since)).toEqual([since]);
    expect(time.pending()).toBe(0);
  });

  it("collapses two live connections that share all five fields", () => {
    const { registry, published, time } = setup();
    const a = registry.register(reg({ connectionId: "c1" }));
    const b = registry.register(reg({ connectionId: "c2" }));
    expect(registry.projectWatchers(10)).toHaveLength(1);
    expect(published).toHaveLength(1);
    a.release();
    time.advance(60_000);
    expect(registry.projectWatchers(10)).toHaveLength(1);
    b.release();
    time.advance(15_000);
    expect(registry.projectWatchers(10)).toEqual([]);
  });

  it("keeps connections apart when any field differs", () => {
    const { registry } = setup();
    registry.register(reg());
    registry.register(reg({ kind: "spec_wait" }));
    registry.register(
      reg({ agentContext: { agent: "claude-code", session_id: "s2" } }),
    );
    registry.register(reg({ userId: 2 }));
    registry.register(reg({ scopes: { projects: [10, 11], issues: [] } }));
    expect(registry.projectWatchers(10)).toHaveLength(5);
  });

  it("uses the connection as the session when the harness reported none", () => {
    const { registry } = setup();
    const agentContext = { agent: "codex" };
    registry.register(reg({ agentContext, connectionId: "c1" }));
    registry.register(reg({ agentContext, connectionId: "c2" }));
    expect(registry.projectWatchers(10)).toHaveLength(2);
  });

  it("orders by since, then user id", () => {
    const { registry, time } = setup();
    registry.register(reg({ userId: 5 }));
    registry.register(reg({ userId: 3 }));
    time.advance(1);
    registry.register(reg({ userId: 1 }));
    expect(registry.projectWatchers(10).map((w) => w.userId)).toEqual([
      3, 5, 1,
    ]);
  });

  it("follows an all-projects entry's visible map, publishing what moved", () => {
    const { registry, published } = setup();
    const visible = new Map<number, unknown>([
      [10, {}],
      [20, {}],
    ]);
    const handle = registry.register(reg({ scopes: { all: visible } }));
    expect(published.map(([id]) => id)).toEqual([10, 20]);
    expect(registry.projectWatchers(20).map((w) => w.scope)).toEqual([
      "all_projects",
    ]);
    expect(registry.issueWatchers(20).size).toBe(0);

    published.length = 0;
    visible.delete(20);
    visible.set(30, {});
    handle.touch();
    expect(published.map(([id]) => id).sort()).toEqual([20, 30]);
    expect(registry.projectWatchers(20)).toEqual([]);
    expect(registry.projectWatchers(30)).toHaveLength(1);

    published.length = 0;
    handle.touch();
    expect(published).toEqual([]);
  });

  it("publishes a changed account to every project its watchers touch (T-571)", () => {
    const { registry, published } = setup();
    registry.register(reg({ scopes: { projects: [10], issues: [] } }));
    registry.register(
      reg({ connectionId: "c2", scopes: { projects: [], issues: [[20, 4]] } }),
    );
    registry.register(
      reg({ userId: 2, scopes: { projects: [30], issues: [] } }),
    );
    // A lingering entry is still listed, so it still has to be redrawn.
    registry
      .register(
        reg({ kind: "spec_wait", scopes: { projects: [40], issues: [] } }),
      )
      .release();
    published.length = 0;

    registry.userChanged(1);
    expect(published.map(([id]) => id).sort()).toEqual([10, 20, 40]);
    expect(published.find(([id]) => id === 20)?.[1]).toEqual({
      entity: "watchers",
      action: "updated",
      id: 20,
      issue_number: 4,
    });

    published.length = 0;
    registry.userChanged(99);
    expect(published).toEqual([]);
  });

  it("clears pending lingers on dispose and drops later releases at once", () => {
    const { registry, time } = setup();
    registry.register(reg()).release();
    const live = registry.register(reg({ userId: 2 }));
    expect(time.pending()).toBe(1);
    registry.dispose();
    expect(time.pending()).toBe(0);
    expect(registry.size()).toBe(1);
    live.release();
    expect(time.pending()).toBe(0);
    expect(registry.size()).toBe(0);
  });
});
