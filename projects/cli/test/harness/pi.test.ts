import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";

/* A home whose ~/.pi never exists: the no-session degradation baseline. */
const home = mkdtempSync(join(tmpdir(), "todou-pi-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/* A project tree to stand in for pi's cwd; sessions key off its real path. */
const project = mkdtempSync(join(tmpdir(), "todou-pi-project-"));
const nested = join(project, "projects", "cli");
mkdirSync(nested, { recursive: true });
afterAll(() => rmSync(project, { recursive: true, force: true }));

const SID = "01900000-0000-7000-8000-000000000001";
const OTHER_SID = "01900000-0000-7000-8000-000000000002";

const header = (id: string, cwd: string) =>
  JSON.stringify({ type: "session", version: 3, id, cwd });
const modelChange = (provider: string, modelId: string) =>
  JSON.stringify({ type: "model_change", provider, modelId });
const assistant = (provider: string, model: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", provider, model },
  });
const userLine = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

/** pi's own encoding of a cwd into one session directory name. */
function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Write a session log the way pi does, under `agentDir`. `mtime` orders
 * sessions against each other — recency is how the live one is picked.
 */
function writeSession(opts: {
  agentDir?: string;
  dir?: string;
  cwd: string;
  id: string;
  lines?: string[];
  mtime?: number;
}): string {
  const dir =
    opts.dir ??
    join(
      opts.agentDir ?? join(home, ".pi", "agent"),
      "sessions",
      sessionDirName(opts.cwd),
    );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-01-01T00-00-00-000Z_${opts.id}.jsonl`);
  writeFileSync(
    path,
    [header(opts.id, opts.cwd), ...(opts.lines ?? [])].join("\n"),
  );
  if (opts.mtime !== undefined) utimesSync(path, opts.mtime, opts.mtime);
  return path;
}

/** A fresh empty $PI_CODING_AGENT_DIR, so tests never see each other. */
function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "todou-pi-agent-"));
}

const ENV = { PI_CODING_AGENT: "true" };

describe("pi detection", () => {
  it("returns null without the pi marker", () => {
    expect(detectAgentContext({}, home, project)).toBeNull();
    expect(
      detectAgentContext({ PI_CODING_AGENT: "false" }, home, project),
    ).toBeNull();
    // pi sets exactly "true"; a truthy-looking value is somebody else's.
    expect(
      detectAgentContext({ PI_CODING_AGENT: "1" }, home, project),
    ).toBeNull();
  });

  it("degrades to agent-only when no session has been recorded", () => {
    expect(detectAgentContext(ENV, home, project)).toEqual({ agent: "pi" });
  });

  it("reads the session id and model from the session log", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro"), userLine],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "axonhub/deepseek-v4-pro",
    });
  });

  it("takes the newest of model_change and assistant message, either way round", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [
        modelChange("axonhub", "old-model"),
        assistant("axonhub", "answered-with"),
      ],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)
        ?.model,
    ).toBe("axonhub/answered-with");

    const swapped = agentDir();
    writeSession({
      agentDir: swapped,
      cwd: project,
      id: SID,
      lines: [
        assistant("axonhub", "old-model"),
        modelChange("openai", "switched-to"),
      ],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: swapped },
        home,
        project,
      )?.model,
    ).toBe("openai/switched-to");
  });

  it("falls back to a bare model id when no provider is recorded", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [JSON.stringify({ type: "model_change", modelId: "bare-model" })],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)
        ?.model,
    ).toBe("bare-model");
  });

  it("picks the most recently written session when several are open", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("axonhub", "stale-model")],
      mtime: 1_000_000,
    });
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "live-model")],
      mtime: 2_000_000,
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/live-model" });
  });

  it("finds pi's session when a tool runs us from a subdirectory", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro")],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, nested),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "axonhub/deepseek-v4-pro",
    });
  });

  it("ignores a session whose cwd does not contain ours", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: nested,
      id: SID,
      lines: [modelChange("axonhub", "deeper-model")],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project),
    ).toEqual({ agent: "pi" });
  });

  it("reads a flat --session-dir, filtering foreign projects by header cwd", () => {
    const flat = mkdtempSync(join(tmpdir(), "todou-pi-flat-"));
    // Under --session-dir every project lands in one directory, so the newest
    // file there is often somebody else's.
    writeSession({
      dir: flat,
      cwd: join(tmpdir(), "todou-pi-elsewhere"),
      id: OTHER_SID,
      lines: [modelChange("axonhub", "foreign-model")],
      mtime: 2_000_000,
    });
    writeSession({
      dir: flat,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "ours")],
      mtime: 1_000_000,
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_SESSION_DIR: flat },
        home,
        project,
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/ours" });
  });

  it("treats bound-but-empty pi directories as unset (T-120 shape)", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro")],
    });
    expect(
      detectAgentContext(
        {
          ...ENV,
          PI_CODING_AGENT_DIR: dir,
          PI_CODING_AGENT_SESSION_DIR: "",
        },
        home,
        project,
      )?.model,
    ).toBe("axonhub/deepseek-v4-pro");
  });

  it("claude-code wins when both harnesses signal", () => {
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", PI_CODING_AGENT: "true" },
        home,
        project,
      ),
    ).toEqual({ agent: "claude-code" });
  });

  it.each([
    ["a headerless file", ["not json at all"]],
    ["a half-written header", ['{"type":"session","id":"tru']],
    ["a foreign first entry", [JSON.stringify({ type: "message" })]],
    ["an empty file", [""]],
  ])("degrades to agent-only on %s", (_name, lines) => {
    const dir = agentDir();
    const target = join(dir, "sessions", sessionDirName(project));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `x_${SID}.jsonl`), lines.join("\n"));
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project),
    ).toEqual({ agent: "pi" });
  });

  it("keeps the session when the log carries no model yet", () => {
    const dir = agentDir();
    writeSession({ agentDir: dir, cwd: project, id: SID, lines: [userLine] });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project),
    ).toEqual({ agent: "pi", session_id: SID });
  });

  it("skips unparseable lines to reach the newest real entry", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [
        modelChange("axonhub", "deepseek-v4-pro"),
        JSON.stringify({ type: "note", text: 'mentions "model" but is junk' }),
        '{"type":"model_change","modelId":',
      ],
    });
    expect(
      detectAgentContext({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)
        ?.model,
    ).toBe("axonhub/deepseek-v4-pro");
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
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: process.cwd(),
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro")],
    });
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["whoami"], {
      fetchImpl,
      env: { ...loggedInEnv(), ...ENV, PI_CODING_AGENT_DIR: dir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `detected harness: pi (session ${SID}, model axonhub/deepseek-v4-pro)`,
    );
  });

  it("write commands carry the pi context", async () => {
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
      // Point at an empty agent dir so the probe never sees a real ~/.pi on
      // the machine running the tests.
      env: { ...loggedInEnv("todou"), ...ENV, PI_CODING_AGENT_DIR: agentDir() },
    });
    expect(result.exitCode).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(JSON.parse(headers["x-todou-agent-context"] as string)).toEqual({
      agent: "pi",
    });
  });
});
