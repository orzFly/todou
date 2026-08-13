import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";

/* A home whose ~/.hermes never exists: the no-db degradation baseline. */
const home = mkdtempSync(join(tmpdir(), "todou-hermes-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const KEY = "agent:main:telegram:dm:1000001";
const SID = "20260101_000000_abcd1234";

const sqlite = process.getBuiltinModule("node:sqlite");

/** A fresh fake $HERMES_HOME; `rows` seeds state.db (absent = no db file). */
function hermesHome(rows?: {
  sessions?: [id: string, model: string][];
  routing?: [key: string, entryJson: string, updatedAt: number][];
  bare?: boolean;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "todou-hermes-state-"));
  mkdirSync(dir, { recursive: true });
  if (rows) {
    const db = new sqlite.DatabaseSync(join(dir, "state.db"));
    if (!rows.bare) {
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT)");
      db.exec(
        "CREATE TABLE gateway_routing (scope TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL, entry_json TEXT NOT NULL, updated_at REAL NOT NULL)",
      );
      for (const [id, model] of rows.sessions ?? []) {
        db.prepare("INSERT INTO sessions (id, model) VALUES (?, ?)").run(
          id,
          model,
        );
      }
      for (const [key, entryJson, updatedAt] of rows.routing ?? []) {
        db.prepare(
          "INSERT INTO gateway_routing (session_key, entry_json, updated_at) VALUES (?, ?, ?)",
        ).run(key, entryJson, updatedAt);
      }
    }
    db.close();
  }
  return dir;
}

describe("hermes-agent detection", () => {
  it("returns null without hermes signals — HERMES_HOME alone is not one", () => {
    expect(detectAgentContext({}, home)).toBeNull();
    expect(detectAgentContext({ HERMES_HOME: "/somewhere" }, home)).toBeNull();
  });

  it("detects a gateway turn by session key", () => {
    expect(detectAgentContext({ HERMES_SESSION_KEY: KEY }, home)).toEqual({
      agent: "hermes-agent",
      session_id: KEY,
    });
  });

  it("detects a keyless gateway process by _HERMES_GATEWAY", () => {
    expect(detectAgentContext({ _HERMES_GATEWAY: "1" }, home)).toEqual({
      agent: "hermes-agent",
    });
  });

  it("claude-code wins when both harnesses signal", () => {
    expect(
      detectAgentContext({ CLAUDECODE: "1", HERMES_SESSION_KEY: KEY }, home),
    ).toEqual({ agent: "claude-code" });
  });

  it("reads the model via HERMES_SESSION_ID", () => {
    const dir = hermesHome({ sessions: [[SID, "hermes-test-model"]] });
    expect(
      detectAgentContext(
        { HERMES_SESSION_KEY: KEY, HERMES_SESSION_ID: SID, HERMES_HOME: dir },
        home,
      ),
    ).toEqual({
      agent: "hermes-agent",
      session_id: KEY,
      model: "hermes-test-model",
    });
  });

  it("resolves the session id through gateway_routing, newest row first", () => {
    const dir = hermesHome({
      sessions: [
        ["20250101_000000_00000000", "hermes-stale-model"],
        [SID, "hermes-test-model"],
      ],
      routing: [
        [KEY, JSON.stringify({ session_id: "20250101_000000_00000000" }), 1],
        [KEY, JSON.stringify({ session_id: SID }), 2],
      ],
    });
    expect(
      detectAgentContext({ HERMES_SESSION_KEY: KEY, HERMES_HOME: dir }, home)
        ?.model,
    ).toBe("hermes-test-model");
  });

  it.each([
    ["no state.db", () => hermesHome()],
    ["empty database", () => hermesHome({ bare: true })],
    ["no matching session row", () => hermesHome({ sessions: [] })],
    [
      "malformed entry_json",
      () => hermesHome({ routing: [[KEY, "not json", 1]] }),
    ],
    [
      "empty model column",
      () =>
        hermesHome({
          sessions: [[SID, ""]],
          routing: [[KEY, JSON.stringify({ session_id: SID }), 1]],
        }),
    ],
  ])("degrades to no model on %s", (_name, make) => {
    const dir = make();
    expect(
      detectAgentContext({ HERMES_SESSION_KEY: KEY, HERMES_HOME: dir }, home),
    ).toEqual({ agent: "hermes-agent", session_id: KEY });
  });
});

describe("header injection", () => {
  const me = {
    id: 2,
    login: "claude",
    display_name: "Claude",
    kind: "machine",
    owner: null,
  };

  it("write commands carry the hermes context", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/7/comments",
        {
          type: "comment",
          id: 1,
          author: me,
          body: "hi",
          created_at: "2026-08-11T12:00:00Z",
          edited_at: null,
          agent_context: null,
        },
      ],
    ]);
    const result = await runCli(["comment", "add", "7", "--body", "hi"], {
      fetchImpl,
      env: {
        ...loggedInEnv("todou"),
        HERMES_SESSION_KEY: KEY,
        // Point at an empty fake home so the probe never sees a real
        // ~/.hermes on the machine running the tests.
        HERMES_HOME: hermesHome(),
      },
    });
    expect(result.exitCode).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(JSON.parse(headers["x-todou-agent-context"] as string)).toEqual({
      agent: "hermes-agent",
      session_id: KEY,
    });
  });
});
