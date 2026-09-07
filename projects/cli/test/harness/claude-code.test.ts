import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/config.ts";
import { detectPermissionMode } from "../../src/harness/claude-code.ts";
import {
  detectAgentContext,
  liveSessionIdReader,
} from "../../src/harness/index.ts";
import type { ProcessTreeIo } from "../../src/harness/process-tree.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";
import { noTree, procTree, scratchDir } from "./proc-fixture.ts";

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

  it("scans past a single line larger than one chunk (T-42 shape)", () => {
    // An image Read appends a ~400 KB base64 tool_result line; when the
    // current turn's assistant entry is not yet flushed, that line is the
    // effective tail and must not shield older assistant entries.
    const hugeToolResult = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "A".repeat(400 * 1024) }],
      },
    });
    writeTranscript("-proj-a", [
      assistantLine("claude-fable-5"),
      hugeToolResult,
      JSON.stringify({ type: "last-prompt" }),
      JSON.stringify({ type: "ai-title" }),
      JSON.stringify({ type: "permission-mode" }),
    ]);
    expect(
      detectAgentContext({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID }, home)
        ?.model,
    ).toBe("claude-fable-5");
  });

  it("reassembles an assistant line that spans chunk boundaries", () => {
    // Multi-byte characters straddle the 256 KB boundaries; decoding per
    // chunk instead of per line would corrupt them and lose the entry.
    const hugeAssistant = JSON.stringify({
      type: "assistant",
      message: { model: "claude-fable-5", content: "模".repeat(220 * 1024) },
    });
    writeTranscript("-proj-a", [
      userLine,
      hugeAssistant,
      '{"type":"assistant","message":{"model":',
    ]);
    expect(
      detectAgentContext({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID }, home)
        ?.model,
    ).toBe("claude-fable-5");
  });

  it("skips <synthetic> placeholder entries from API-error turns", () => {
    writeTranscript("-proj-a", [
      assistantLine("claude-fable-5"),
      userLine,
      assistantLine("<synthetic>"),
    ]);
    expect(
      detectAgentContext({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID }, home)
        ?.model,
    ).toBe("claude-fable-5");

    writeTranscript("-proj-a", [userLine, assistantLine("<synthetic>")]);
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
        home,
      ),
    ).toEqual({ agent: "claude-code", session_id: SID });
    expect(
      detectAgentContext(
        {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: SID,
          CLAUDE_MODEL: "claude-from-env",
        },
        home,
      )?.model,
    ).toBe("claude-from-env");
  });

  it("gives up past the 16 MB scan cap and falls back to CLAUDE_MODEL", () => {
    const padding = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(1024) },
    });
    writeTranscript("-proj-a", [
      assistantLine("claude-buried"),
      ...Array.from({ length: 17 * 1024 }, () => padding),
    ]);
    expect(
      detectAgentContext(
        {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: SID,
          CLAUDE_MODEL: "claude-from-env",
        },
        home,
      )?.model,
    ).toBe("claude-from-env");
  });

  it("survives an empty transcript and a lone half-written line", () => {
    writeTranscript("-proj-a", [""]);
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
        home,
      ),
    ).toEqual({ agent: "claude-code", session_id: SID });

    writeTranscript("-proj-a", ['{"type":"assistant","message":{"model":"tru']);
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
        home,
      ),
    ).toEqual({ agent: "claude-code", session_id: SID });
  });

  it("finds a model on the very first line of a small transcript", () => {
    writeTranscript("-proj-a", [assistantLine("claude-first"), userLine]);
    expect(
      detectAgentContext({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID }, home)
        ?.model,
    ).toBe("claude-first");
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

describe("detectPermissionMode (T-252)", () => {
  const modeLine = (mode: string) =>
    JSON.stringify({ type: "permission-mode", permissionMode: mode });

  it("maps every mode a push may attest to", () => {
    writeTranscript("-proj-a", [userLine, modeLine("bypassPermissions")]);
    expect(detectPermissionMode(SID, home)).toBe("bypass");

    writeTranscript("-proj-a", [userLine, modeLine("default")]);
    expect(detectPermissionMode(SID, home)).toBe("prompting");

    writeTranscript("-proj-a", [userLine, modeLine("acceptEdits")]);
    expect(detectPermissionMode(SID, home)).toBe("prompting");
  });

  it("reads the mode off an ordinary user entry too", () => {
    // The field rides along on every user turn, not only on the record
    // written when the mode changes.
    writeTranscript("-proj-a", [
      JSON.stringify({
        type: "user",
        message: { role: "user" },
        permissionMode: "acceptEdits",
      }),
    ]);
    expect(detectPermissionMode(SID, home)).toBe("prompting");
  });

  it("attests nothing at all once plan mode is the newest word", () => {
    // Not "keep looking for something translatable": the receiver decides
    // what plan normalizes to by a flag the transcript never records, and
    // an older bypass line describes a mode already left behind. Attesting
    // the wrong mode is held outright, which is worse than not attesting.
    writeTranscript("-proj-a", [
      modeLine("bypassPermissions"),
      userLine,
      modeLine("plan"),
    ]);
    expect(detectPermissionMode(SID, home)).toBeUndefined();
  });

  it("degrades quietly with no session, no transcript, no shape", () => {
    expect(detectPermissionMode(undefined, home)).toBeUndefined();
    expect(
      detectPermissionMode("99999999-aaaa-bbbb-cccc-dddddddddddd", home),
    ).toBeUndefined();
    expect(detectPermissionMode("../../etc/passwd", home)).toBeUndefined();

    writeTranscript("-proj-a", ['{"permissionMode":"bypassPer']);
    expect(detectPermissionMode(SID, home)).toBeUndefined();
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

describe("liveSessionId (T-289)", () => {
  /* A home of its own: half of these cases turn on which pid file is
     absent, and the transcript fixtures above share theirs. */
  const liveHome = scratchDir("todou-live-home-");
  const socks = scratchDir("todou-cc-socks-");
  const LIVE = "3856e246-aaaa-bbbb-cccc-000000000001";
  const sock = (pid: number) => join(socks, `${pid}.sock`);
  const sessionFile = (pid: number) =>
    join(liveHome, ".claude", "sessions", `${pid}.json`);

  function writeRecord(pid: number, body: unknown): void {
    mkdirSync(join(liveHome, ".claude", "sessions"), { recursive: true });
    writeFileSync(
      sessionFile(pid),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  const record = (pid: number, sessionId: unknown) => ({
    pid,
    sessionId,
    messagingSocketPath: sock(pid),
  });

  const read = (env: Env, io: Partial<ProcessTreeIo> = noTree()) =>
    liveSessionIdReader({
      env: { CLAUDECODE: "1", ...env },
      home: liveHome,
      io,
    })();

  it("reads the id from the record the socket's pid names", () => {
    // The only record this home holds, so an implementation reaching for the
    // reading process's own `process.pid` — the watch's, one fork below the
    // claude process — finds nothing and fails here. This case is the card.
    writeRecord(4046359, record(4046359, LIVE));
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(4046359) })).toEqual({
      id: LIVE,
    });
  });

  it("says nothing with no socket and no process tree", () => {
    expect(read({})).toEqual({});
  });

  it("says nothing when the socket's name is not a pid", () => {
    expect(
      read({ CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/agent.sock" }),
    ).toEqual({});
  });

  it("names the path it tried once a pid has resolved", () => {
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(1234567) })).toEqual({
      unreadable: sessionFile(1234567),
    });
  });

  it("treats a malformed record as unreadable, never as an error", () => {
    writeRecord(700001, '{"pid":700001,"sessionId":');
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700001) })).toEqual({
      unreadable: sessionFile(700001),
    });
  });

  it("refuses a record whose pid disagrees with the one asked for", () => {
    // Pids are reused and records outlive the processes they name: taking
    // this one would start hiding a stranger's writes instead.
    writeRecord(700002, { ...record(700002, LIVE), pid: 700099 });
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700002) })).toEqual({
      unreadable: sessionFile(700002),
    });
  });

  it("refuses a record naming a different messaging socket", () => {
    writeRecord(700003, {
      ...record(700003, LIVE),
      messagingSocketPath: sock(700004),
    });
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700003) })).toEqual({
      unreadable: sessionFile(700003),
    });
  });

  it("refuses a session id that is path-shaped, over-long or not a string", () => {
    writeRecord(700005, record(700005, "../../etc/passwd"));
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700005) })).toEqual({
      unreadable: sessionFile(700005),
    });

    writeRecord(700006, record(700006, "a".repeat(201)));
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700006) })).toEqual({
      unreadable: sessionFile(700006),
    });

    writeRecord(700007, record(700007, 12345));
    expect(read({ CLAUDE_CODE_MESSAGING_SOCKET: sock(700007) })).toEqual({
      unreadable: sessionFile(700007),
    });
  });

  it("falls back to the process tree when the socket is unset", () => {
    // The real shape: the marker is introduced *for* claude's children, so
    // the ancestor carrying CLAUDECODE=1 is a child of claude, and it is
    // claude's own pid that indexes the sessions directory.
    writeRecord(800002, { pid: 800002, sessionId: LIVE });
    const tree = procTree([
      { pid: 800001, ppid: 800002, env: { CLAUDECODE: "1" } },
      { pid: 800002, ppid: 1, env: {} },
    ]);
    expect(read({}, tree)).toEqual({ id: LIVE });
  });

  it("answers afresh on every call, which is the whole point", () => {
    writeRecord(900001, record(900001, LIVE));
    const reader = liveSessionIdReader({
      env: {
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_SOCKET: sock(900001),
      },
      home: liveHome,
      io: noTree(),
    });
    expect(reader()).toEqual({ id: LIVE });
    const rotated = "884c574a-aaaa-bbbb-cccc-000000000002";
    writeRecord(900001, record(900001, rotated));
    expect(reader()).toEqual({ id: rotated });
  });

  it("stays quiet for a harness with no answer of its own", () => {
    // Pointed at a home that does hold a valid record, and at the socket
    // naming it: a harness without the member must return nothing rather
    // than fall through to Claude Code's file.
    writeRecord(900002, record(900002, LIVE));
    const env = { CLAUDE_CODE_MESSAGING_SOCKET: sock(900002) };
    for (const marker of [
      { CODEX_THREAD_ID: "00000000-0000-7000-8000-000000000001" },
      { HERMES_REAL_HOME: "/home/todou" },
      { PI_CODING_AGENT: "true" },
    ]) {
      expect(
        liveSessionIdReader({
          env: { ...env, ...marker },
          home: liveHome,
          io: noTree(),
        })(),
      ).toEqual({});
    }
  });
});
