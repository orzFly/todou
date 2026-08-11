import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../src/agent-context.ts";
import { fakeFetch, loggedInEnv, runCli } from "./harness.ts";

const home = mkdtempSync(join(tmpdir(), "todou-agent-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const SID = "11111111-2222-3333-4444-555555555555";

function writeTranscript(name: string, lines: string[]): void {
  const dir = join(home, ".claude", "projects", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), lines.join("\n"));
}

const assistantLine = (model: string) =>
  JSON.stringify({ type: "assistant", message: { model, role: "assistant" } });
const userLine = JSON.stringify({ type: "user", message: { role: "user" } });

describe("detectAgentContext", () => {
  it("returns null outside Claude Code", () => {
    expect(detectAgentContext({}, home)).toBeNull();
    expect(detectAgentContext({ CLAUDECODE: "0" }, home)).toBeNull();
  });

  it("degrades to agent-only when nothing else is known", () => {
    expect(detectAgentContext({ CLAUDECODE: "1" }, home)).toEqual({
      agent: "claude-code",
    });
  });

  it("reads the model from the newest assistant transcript entry", () => {
    writeTranscript("-proj-a", [
      userLine,
      assistantLine("claude-old-model"),
      userLine,
      assistantLine("claude-fable-5"),
      JSON.stringify({ type: "progress", note: 'has "model" word but junk' }),
    ]);
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
        home,
      ),
    ).toEqual({
      agent: "claude-code",
      session_id: SID,
      model: "claude-fable-5",
    });
  });

  it("skips unparseable lines and survives a tail cut", () => {
    const padding = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(1024) },
    });
    writeTranscript("-proj-a", [
      ...Array.from({ length: 400 }, () => padding),
      assistantLine("claude-fable-5"),
      '{"type":"assistant","message":{"model":',
    ]);
    const ctx = detectAgentContext(
      { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
      home,
    );
    expect(ctx?.model).toBe("claude-fable-5");
  });

  it("transcript beats CLAUDE_MODEL; CLAUDE_MODEL is the fallback", () => {
    writeTranscript("-proj-a", [assistantLine("claude-from-transcript")]);
    expect(
      detectAgentContext(
        {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: SID,
          CLAUDE_MODEL: "claude-from-env",
        },
        home,
      )?.model,
    ).toBe("claude-from-transcript");

    expect(
      detectAgentContext(
        {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "99999999-aaaa-bbbb-cccc-dddddddddddd",
          CLAUDE_MODEL: "claude-from-env",
        },
        home,
      )?.model,
    ).toBe("claude-from-env");
  });

  it("rejects path-shaped session ids", () => {
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "../../etc/passwd" },
        home,
      ),
    ).toEqual({ agent: "claude-code", session_id: "../../etc/passwd" });
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

  it("write commands carry x-todou-agent-context under CLAUDECODE=1", async () => {
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
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "not-a-real-session",
        CLAUDE_MODEL: "claude-fable-5",
      },
    });
    expect(result.exitCode).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(JSON.parse(headers["x-todou-agent-context"] as string)).toEqual({
      agent: "claude-code",
      session_id: "not-a-real-session",
      model: "claude-fable-5",
    });
  });

  it("sends no header outside Claude Code", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    await runCli(["whoami"], { fetchImpl, env: loggedInEnv() });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-todou-agent-context"]).toBeUndefined();
  });
});
