import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fakeFetch,
  loggedInEnv,
  runCli,
  sseStub,
  virtualClock,
} from "./harness.ts";

/**
 * T-289 end to end: a resident watch must filter on the session id its
 * claude process holds *now*. `/clear` gives a live process a new id while
 * its pid — and therefore its messaging socket and its record — stay put, so
 * the environment variable the watch was spawned with is a snapshot, and a
 * watch that keeps sending it starts being woken by its own session.
 */

const HOST_PID = 4046359;
/* What the environment says, and what a watch used to be stuck with. */
const EXPIRED = "e330bf5f-1111-2222-3333-444444444444";
const CURRENT = "884c574a-5555-6666-7777-888888888888";
const ROTATED = "3856e246-9999-aaaa-bbbb-cccccccccccc";

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const author = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};
const page = (items: unknown[], cursor: string | null) => ({
  items,
  next_cursor: cursor,
});

const home = mkdtempSync(join(tmpdir(), "todou-rotation-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const socket = join(home, `${HOST_PID}.sock`);

function writeSession(sessionId: string): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${HOST_PID}.json`),
    JSON.stringify({
      pid: HOST_PID,
      sessionId,
      messagingSocketPath: socket,
      cwd: "/home/todou",
    }),
  );
}

/** Every `exclude_agent_session` the watch asked with, in order. */
const filtered = (urls: string[]): (string | null)[] =>
  urls
    .filter((url) => url.includes("/activity"))
    .map((url) => new URL(url).searchParams.get("exclude_agent_session"));

describe("a resident watch follows its session id (T-289)", () => {
  it("filters on the record's id, and follows it when it rotates", async () => {
    writeSession(CURRENT);
    const clock = virtualClock();
    const sse = sseStub();
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        () => {
          drains += 1;
          // Between the two drains, the way a `/clear` does it: the record
          // is rewritten under a process that never restarted.
          if (drains === 1) {
            writeSession(ROTATED);
            return page([], null);
          }
          return page(
            [
              {
                type: "comment",
                id: 9,
                author,
                body: "comment 9",
                created_at: clock.iso(),
                edited_at: null,
                issue_number: 3,
              },
            ],
            // One page per drain: a non-null cursor would have the paginator
            // ask again inside the same drain, with the same filter.
            null,
          );
        },
      ],
    ]);

    const result = await runCli(
      ["watch", "-p", "todou", "--since", "a0", "--json"],
      {
        fetchImpl,
        clock,
        home,
        env: {
          ...loggedInEnv(),
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: EXPIRED,
          CLAUDE_CODE_MESSAGING_SOCKET: socket,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    // The card, in one assertion: the environment said EXPIRED and the file
    // said CURRENT, and the request carried the file's answer.
    expect(filtered(calls.map((c) => c.url))).toEqual([CURRENT, ROTATED]);
    expect(result.stderr).toContain(
      `session id rotated ${CURRENT} → ${ROTATED}; self-filter follows`,
    );
    expect(
      result.stderr.split("\n").filter((l) => l.includes("session id rotated")),
    ).toHaveLength(1);
  });

  it("keeps the startup id, and says so, when the record cannot be read", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        () =>
          page(
            [
              {
                type: "comment",
                id: 9,
                author,
                body: "comment 9",
                created_at: clock.iso(),
                edited_at: null,
                issue_number: 3,
              },
            ],
            null,
          ),
      ],
    ]);

    const result = await runCli(
      ["watch", "-p", "todou", "--since", "a0", "--json"],
      {
        fetchImpl,
        clock,
        home: "/nonexistent-todou-home",
        env: {
          ...loggedInEnv(),
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: EXPIRED,
          CLAUDE_CODE_MESSAGING_SOCKET: socket,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(filtered(calls.map((c) => c.url))).toEqual([EXPIRED]);
    // Degrading to the startup value is exactly the behaviour being fixed,
    // so it may not happen quietly.
    expect(result.stderr).toContain(
      `/nonexistent-todou-home/.claude/sessions/${HOST_PID}.json`,
    );
    expect(result.stderr).toContain("will not follow a /clear");
  });
});
