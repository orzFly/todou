import { TodouClient } from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { LiveSession } from "../src/harness/types.ts";
import {
  fixedSelfFilter,
  type RetryOptions,
  resolveSelfFilter,
  type SessionSource,
} from "../src/watch-loop.ts";
import { fakeFetch } from "./harness.ts";

/**
 * T-289's unit half: a self-filter is a source asked per drain, not a value
 * captured at startup, because `/clear` rotates the session id under a live
 * process and a watch that kept the old one starts delivering its own
 * session's writes back to it.
 */

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};

const RETRY: RetryOptions = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

/** A reader handing out `answers` in order, repeating the last one. */
function reader(answers: LiveSession[]): () => LiveSession {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)] as LiveSession;
}

function source(
  answers: LiveSession[],
  startup: string | undefined = "startup-id",
): SessionSource {
  return { live: reader(answers), startup };
}

async function build(session: SessionSource) {
  const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
  const notes: string[] = [];
  const self = await resolveSelfFilter(
    new TodouClient({ fetch: fetchImpl }),
    session,
    RETRY,
    (line) => notes.push(line),
  );
  return { self, notes };
}

describe("resolveSelfFilter as a source (T-289)", () => {
  it("follows a rotation, and says so once", async () => {
    const { self, notes } = await build(
      source([{ id: "first" }, { id: "second" }]),
    );

    expect(self.params()).toEqual({
      excludeActor: 2,
      excludeAgentSession: "first",
    });
    expect(self.params()).toEqual({
      excludeActor: 2,
      excludeAgentSession: "second",
    });
    expect(notes).toEqual([
      "session id rotated first → second; self-filter follows",
    ]);
    // The third call sees the same id as the second: a rotation is reported
    // per new value, not per drain.
    self.params();
    expect(notes).toHaveLength(1);
  });

  it("says nothing at all while the id holds still", async () => {
    const { self, notes } = await build(source([{ id: "steady" }]));
    for (let i = 0; i < 4; i++) {
      expect(self.params().excludeAgentSession).toBe("steady");
    }
    // Including on the first call, where the live value and the environment
    // are expected to agree.
    expect(notes).toEqual([]);
  });

  it("reports a lookup that never works, once, and keeps filtering", async () => {
    const path = "/home/todou/.claude/sessions/4046359.json";
    const { self, notes } = await build(source([{ unreadable: path }]));

    // Falling back to the startup value is today's behaviour and the bug
    // being fixed, so the fallback may not be silent: without this line a
    // lookup that never succeeds leaves the card looking closed.
    expect(self.params()).toEqual({
      excludeActor: 2,
      excludeAgentSession: "startup-id",
    });
    self.params();
    self.params();
    expect(notes).toEqual([
      `could not read ${path}: the self-filter stays on the session id this ` +
        "process started with, and will not follow a /clear",
    ]);
  });

  it("prefers the live id but never an empty one", async () => {
    const { self } = await build(source([{ id: "live" }], "startup-id"));
    expect(self.params().excludeAgentSession).toBe("live");

    // A harness may report an empty session id, which names nothing and the
    // server rejects as a query param.
    const empty = await build(source([{}], ""));
    expect(empty.self.params()).toEqual({
      excludeActor: 2,
      excludeAgentSession: undefined,
    });
  });

  it("leaves --any-actor and --exclude-actor alone", async () => {
    expect(fixedSelfFilter({}).params()).toEqual({});
    const named = fixedSelfFilter({ excludeActor: 7 });
    expect(named.params()).toEqual({ excludeActor: 7 });
    expect(named.params()).toEqual({ excludeActor: 7 });
  });
});
