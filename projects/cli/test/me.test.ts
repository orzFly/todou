import type { TimelineComment } from "@todou/shared";
import { describe, expect, it } from "vitest";
import type { Painter } from "../src/format.ts";
import { renderActivityLine, renderTimelineItem } from "../src/timeline.ts";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

/** `/me` lines (T-575): `todou me` writes them, every renderer reads them. */

const paint: Painter = (_style, text) => text;

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  avatar_url: null,
  owner: null,
} as const;

const action = (over: Partial<TimelineComment> = {}): TimelineComment => ({
  type: "comment",
  id: 757,
  author: me,
  body: "is reviewing.",
  kind: "action",
  component: null,
  created_at: "2026-08-11T12:00:00.000Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
  ...over,
});

describe("todou me", () => {
  function postRoute(seen: { body?: Record<string, unknown> }) {
    return fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/7/comments",
        (init: RequestInit) => {
          seen.body = JSON.parse(String(init.body));
          return {
            ...action({ id: 31, body: String(seen.body?.body) }),
            cursor: "3:abc.0.1",
          };
        },
      ],
    ]);
  }

  it("joins the words into one action and echoes it as it reads", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { fetchImpl } = postRoute(seen);
    const result = await runCli(["me", "7", "is", "reviewing."], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(seen.body).toEqual({ body: "is reviewing.", kind: "action" });
    expect(result.stdout.split("\n")[0]).toBe(
      "#comment-31 on #7 · * Claude is reviewing.",
    );
    expect(result.stdout).toContain("cursor: 3:abc.0.1");
  });

  it("refuses an over-long line before writing anything", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { fetchImpl, calls } = postRoute(seen);
    const result = await runCli(["me", "7", "x".repeat(501)], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("at most 500 characters");
    expect(calls).toHaveLength(0);
  });

  it("needs some text", async () => {
    const { fetchImpl, calls } = postRoute({});
    const result = await runCli(["me", "7"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("rendering an action", () => {
  const ctx = {
    refLabel: "T-7",
    issueNumber: 7,
    refPrefix: "T",
    summaryChars: 0,
  };

  it("reads as one sentence in a timeline", () => {
    const line = renderTimelineItem(action(), paint, ctx);
    expect(line).toMatch(/^#comment-757 · \* Claude is reviewing\. \S/);
    expect(line).not.toContain("commented");
    expect(line).not.toContain("\n");
  });

  it("reads as one sentence on a watch line", () => {
    expect(renderActivityLine(action(), paint, ctx)).toMatch(
      /^T-7 #comment-757 \* Claude is reviewing\. \S/,
    );
  });

  it("is a comment when the kind is absent or unknown", () => {
    for (const kind of [undefined, "comment", "shout"]) {
      expect(renderTimelineItem(action({ kind }), paint, ctx)).toContain(
        "Claude commented",
      );
    }
  });
});
