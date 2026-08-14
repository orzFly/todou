import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";

/* A home whose ~/.codex never exists: the no-rollout degradation baseline. */
const home = mkdtempSync(join(tmpdir(), "todou-codex-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const TID = "01900000-0000-7000-8000-000000000001";

const turnContextLine = (model: string) =>
  JSON.stringify({
    timestamp: "2026-01-02T03:04:05.000Z",
    type: "turn_context",
    payload: { turn_id: "01900000-0000-7000-8000-0000000000ff", model },
  });

/* Codex records no model in the session header — only in each turn. */
const sessionMetaLine = JSON.stringify({
  timestamp: "2026-01-02T03:04:05.000Z",
  type: "session_meta",
  payload: { session_id: TID, id: TID, cwd: "/w", model_provider: "openai" },
});

const responseLine = JSON.stringify({
  type: "response_item",
  payload: { type: "message", role: "assistant" },
});

/**
 * Writes a rollout under `base` the way codex files them, and returns the
 * $CODEX_HOME that contains it.
 */
function codexHome(
  lines?: string[],
  base = mkdtempSync(join(tmpdir(), "todou-codex-state-")),
): string {
  if (lines) {
    const dir = join(base, "sessions", "2026", "01", "02");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-01-02T03-04-05-${TID}.jsonl`),
      lines.join("\n"),
    );
  }
  return base;
}

describe("codex detection", () => {
  it("returns null without a thread id, and when it is bound empty", () => {
    expect(detectAgentContext({}, home)).toBeNull();
    expect(detectAgentContext({ CODEX_THREAD_ID: "" }, home)).toBeNull();
    // Neither of these accompanies every codex shell, so neither is a signal.
    expect(
      detectAgentContext({ CODEX_PERMISSION_PROFILE: ":workspace" }, home),
    ).toBeNull();
    expect(
      detectAgentContext({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }, home),
    ).toBeNull();
  });

  it("degrades to agent and thread id when no rollout is readable", () => {
    expect(detectAgentContext({ CODEX_THREAD_ID: TID }, home)).toEqual({
      agent: "codex",
      session_id: TID,
    });
  });

  it("reads the model from the newest turn_context", () => {
    const dir = codexHome([
      sessionMetaLine,
      turnContextLine("gpt-test-old"),
      responseLine,
      turnContextLine("gpt-test-model"),
      responseLine,
    ]);
    expect(
      detectAgentContext({ CODEX_THREAD_ID: TID, CODEX_HOME: dir }, home),
    ).toEqual({
      agent: "codex",
      session_id: TID,
      model: "gpt-test-model",
    });
  });

  it("falls back to ~/.codex when CODEX_HOME is bound empty", () => {
    // `??` would take that empty string for a chosen home and glob from the
    // filesystem root, so the model would never resolve (T-120).
    const own = mkdtempSync(join(tmpdir(), "todou-codex-ownhome-"));
    codexHome([turnContextLine("gpt-test-model")], join(own, ".codex"));
    expect(
      detectAgentContext({ CODEX_THREAD_ID: TID, CODEX_HOME: "" }, own)?.model,
    ).toBe("gpt-test-model");
    rmSync(own, { recursive: true, force: true });
  });

  it("skips foreign, unparseable and half-written lines", () => {
    const dir = codexHome([
      turnContextLine("gpt-test-model"),
      JSON.stringify({ type: "event_msg", payload: { turn_context: "junk" } }),
      responseLine,
      '{"type":"turn_context","payload":{"model":',
    ]);
    expect(
      detectAgentContext({ CODEX_THREAD_ID: TID, CODEX_HOME: dir }, home)
        ?.model,
    ).toBe("gpt-test-model");
  });

  it.each([
    ["a rollout with no turn yet", [sessionMetaLine]],
    ["an empty rollout", [""]],
    ["a turn_context with an empty model", [turnContextLine("")]],
    [
      "a turn_context whose model is not a string",
      [JSON.stringify({ type: "turn_context", payload: { model: 5 } })],
    ],
  ])("degrades to no model on %s", (_name, lines) => {
    const dir = codexHome(lines);
    expect(
      detectAgentContext({ CODEX_THREAD_ID: TID, CODEX_HOME: dir }, home),
    ).toEqual({ agent: "codex", session_id: TID });
  });

  it("rejects path-shaped thread ids but still reports them", () => {
    expect(
      detectAgentContext(
        { CODEX_THREAD_ID: "../../etc/passwd", CODEX_HOME: codexHome() },
        home,
      ),
    ).toEqual({ agent: "codex", session_id: "../../etc/passwd" });
  });

  it("claude-code wins when both harnesses signal", () => {
    // Pins the tie-break, not a truth: codex inherits CLAUDECODE from a claude
    // code shell exactly as claude code inherits CODEX_THREAD_ID from a codex
    // one, so this env is ambiguous and the registry order decides it.
    expect(
      detectAgentContext({ CLAUDECODE: "1", CODEX_THREAD_ID: TID }, home),
    ).toEqual({ agent: "claude-code" });
  });

  it("codex wins over the hermes gateway that launched it", () => {
    expect(
      detectAgentContext(
        {
          CODEX_THREAD_ID: TID,
          CODEX_HOME: codexHome(),
          HERMES_SESSION_KEY: "agent:main:telegram:dm:1000001",
        },
        home,
      ),
    ).toEqual({ agent: "codex", session_id: TID });
  });
});

describe("cli integration", () => {
  const me = {
    id: 2,
    login: "claude",
    display_name: "Claude",
    kind: "machine",
    owner: null,
  };

  it("whoami reports the detected session and model", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["whoami"], {
      fetchImpl,
      env: {
        ...loggedInEnv(),
        CODEX_THREAD_ID: TID,
        CODEX_HOME: codexHome([turnContextLine("gpt-test-model")]),
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `detected harness: codex (session ${TID}, model gpt-test-model)`,
    );
  });

  it("write commands carry the codex context", async () => {
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
        CODEX_THREAD_ID: TID,
        // Point at an empty fake home so the probe never sees a real
        // ~/.codex on the machine running the tests.
        CODEX_HOME: codexHome(),
      },
    });
    expect(result.exitCode).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(JSON.parse(headers["x-todou-agent-context"] as string)).toEqual({
      agent: "codex",
      session_id: TID,
    });
  });
});
