import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";

/*
 * pi is the one detector that asks for its host process, so every case here
 * would otherwise read the real process tree and take the cwd and argv of
 * whatever ran the suite as pi's own. An unreadable tree pins these tests to
 * what the environment alone can say; the host-driven paths are exercised
 * with a fixture tree in process-tree.test.ts (T-128).
 */
const NO_TREE = {
  platform: "linux" as const,
  procRoot: "/nonexistent",
  startPid: 0,
};
const detect: typeof detectAgentContext = (env, home, cwd) =>
  detectAgentContext(env, home, cwd, NO_TREE);

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

/* Fixture process trees and session directories, swept together at the end. */
const procRoots: string[] = [];
afterAll(() => {
  for (const dir of procRoots) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty $PI_CODING_AGENT_DIR, so tests never see each other. */
function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "todou-pi-agent-"));
}

const ENV = { PI_CODING_AGENT: "true" };

describe("pi detection", () => {
  it("returns null without the pi marker", () => {
    expect(detect({}, home, project)).toBeNull();
    expect(detect({ PI_CODING_AGENT: "false" }, home, project)).toBeNull();
    // pi sets exactly "true"; a truthy-looking value is somebody else's.
    expect(detect({ PI_CODING_AGENT: "1" }, home, project)).toBeNull();
  });

  it("degrades to agent-only when no session has been recorded", () => {
    expect(detect(ENV, home, project)).toEqual({ agent: "pi" });
  });

  it("reads the session id and model from the session log", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro"), userLine],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "pi",
        session_id: SID,
        model: "axonhub/deepseek-v4-pro",
      },
    );
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
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
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
      detect({ ...ENV, PI_CODING_AGENT_DIR: swapped }, home, project)?.model,
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
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
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
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi", session_id: SID, model: "axonhub/live-model" },
    );
  });

  it("finds pi's session when a tool runs us from a subdirectory", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "deepseek-v4-pro")],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, nested)).toEqual({
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
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi" },
    );
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
      detect({ ...ENV, PI_CODING_AGENT_SESSION_DIR: flat }, home, project),
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
      detect(
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

  it("falls back to the registry order with no readable process tree", () => {
    // Both harnesses mark their whole process tree, so this environment alone
    // cannot say which one is the direct host; the tree decides when it can
    // be read, and the registry order is what is left when it cannot.
    expect(
      detect({ CLAUDECODE: "1", PI_CODING_AGENT: "true" }, home, project),
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
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi" },
    );
  });

  it("keeps the session when the log carries no model yet", () => {
    const dir = agentDir();
    writeSession({ agentDir: dir, cwd: project, id: SID, lines: [userLine] });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi", session_id: SID },
    );
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
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("axonhub/deepseek-v4-pro");
  });
});

describe("pi session recovery through the host process", () => {
  /** A process tree in which pi itself is our host, carrying argv and cwd. */
  function piHost(opts: { argv?: string[]; cwd?: string }) {
    const root = mkdtempSync(join(tmpdir(), "todou-pi-proc-"));
    procRoots.push(root);
    const write = (
      pid: number,
      ppid: number,
      env: Record<string, string>,
      argv: string[],
      cwd?: string,
    ) => {
      const dir = join(root, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "stat"), `${pid} (proc) S ${ppid} 0 0 0 -1`);
      writeFileSync(
        join(dir, "environ"),
        `${Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\0")}\0`,
      );
      writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
      if (cwd) symlinkSync(cwd, join(dir, "cwd"));
    };
    // The shell pi spawned carries the marker; pi itself does not, which is
    // what identifies it as the host.
    write(100, 101, { PI_CODING_AGENT: "true" }, ["sh", "-c", "todou"]);
    write(
      101,
      0,
      {},
      opts.argv ?? ["node", "/opt/harness/pi/cli.js"],
      opts.cwd,
    );
    return { platform: "linux" as const, procRoot: root, startPid: 100 };
  }

  it("recovers a --session-dir that exists only on pi's command line", () => {
    // The flag is invisible from the environment, so this mode used to
    // degrade to no session and no model at all (T-108 limitation 2).
    const flat = mkdtempSync(join(tmpdir(), "todou-pi-flat-"));
    procRoots.push(flat);
    writeSession({
      dir: flat,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "recovered")],
    });
    expect(
      detectAgentContext(
        ENV,
        home,
        project,
        piHost({ argv: ["pi", "--session-dir", flat] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/recovered" });
  });

  it("lets pi's flag beat the environment variable", () => {
    const fromEnv = mkdtempSync(join(tmpdir(), "todou-pi-env-"));
    const fromFlag = mkdtempSync(join(tmpdir(), "todou-pi-flag-"));
    procRoots.push(fromEnv, fromFlag);
    writeSession({
      dir: fromEnv,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("axonhub", "from-env")],
    });
    writeSession({
      dir: fromFlag,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "from-flag")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_SESSION_DIR: fromEnv },
        home,
        project,
        piHost({ argv: ["pi", `--session-dir=${fromFlag}`] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/from-flag" });
  });

  it("claims pi's session when we run outside pi's own directory", () => {
    // A tool may hand us a cwd that is not under pi's; pi's real cwd is what
    // names its session directory and what the session header records.
    const dir = agentDir();
    const elsewhere = mkdtempSync(join(tmpdir(), "todou-pi-elsewhere-"));
    procRoots.push(elsewhere);
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "by-host-cwd")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        elsewhere,
        piHost({ cwd: project }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/by-host-cwd" });
  });

  it("takes a --session path from outside every scanned directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "todou-pi-outside-"));
    procRoots.push(outside);
    const path = writeSession({
      dir: outside,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "named")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: agentDir() },
        home,
        project,
        piHost({ argv: ["pi", "--session", path] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/named" });
  });

  it("lets a newer session beat the one named on the command line", () => {
    // `/resume` switches sessions from inside a running pi, which leaves the
    // argv naming a session pi has left; the live one is still the one being
    // appended to.
    const dir = agentDir();
    const outside = mkdtempSync(join(tmpdir(), "todou-pi-resumed-"));
    procRoots.push(outside);
    const started = writeSession({
      dir: outside,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("axonhub", "started-with")],
      mtime: 1_000_000,
    });
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("axonhub", "resumed-into")],
      mtime: 2_000_000,
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        piHost({ argv: ["pi", "--session", started], cwd: project }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "axonhub/resumed-into" });
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
