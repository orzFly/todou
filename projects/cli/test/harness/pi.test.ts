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
import {
  detectAgentContext,
  liveSessionIdReader,
} from "../../src/harness/index.ts";
import { piAgentDir, piHostAncestor } from "../../src/harness/pi.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";
import { procTree, scratchDir } from "./proc-fixture.ts";

/*
 * An unreadable tree pins these tests to what the environment alone can say.
 * Otherwise the detector would read the real cwd and argv of whatever ran the
 * suite. The host-driven paths below use fixture process trees.
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

/**
 * An mtime `secondsAgo` back, in the seconds `utimesSync` takes.
 *
 * Ordering fixtures may not use bare small numbers any more: those land in
 * 1970, and the detector now refuses a log too old to be the one the harness
 * is writing. A fixture that means "older than the other" has to say so
 * without also meaning "older than an hour".
 */
const recently = (secondsAgo: number) => Date.now() / 1000 - secondsAgo;

/* Fixture process trees and session directories, swept together at the end. */
const procRoots: string[] = [];
afterAll(() => {
  for (const dir of procRoots) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty $PI_CODING_AGENT_DIR, so tests never see each other. */
function agentDir(): string {
  return scratchDir("todou-pi-agent-");
}

const ENV = { PI_CODING_AGENT: "true" };

describe("pi agent directory", () => {
  it.each([undefined, ""])(
    "defaults for an unset or empty override (%s)",
    (value) => {
      expect(piAgentDir({ PI_CODING_AGENT_DIR: value }, home)).toEqual({
        dir: join(home, ".pi", "agent"),
        configRoot: join(home, ".pi"),
      });
    },
  );

  it.each([
    ["/custom/agent", "/custom/agent"],
    ["relative/agent", "relative/agent"],
    ["~", home],
    ["~/custom/agent", join(home, "custom", "agent")],
    ["~other/agent", "~other/agent"],
  ])("resolves native override %s", (value, dir) => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: value }, home)).toEqual({
      dir,
      configRoot: join(home, ".pi"),
    });
  });

  it("uses the expanded directory for session discovery", () => {
    const isolatedHome = scratchDir("todou-pi-home-");
    writeSession({
      agentDir: join(isolatedHome, "custom"),
      cwd: project,
      id: SID,
    });
    expect(
      detect(
        { ...ENV, PI_CODING_AGENT_DIR: "~/custom" },
        isolatedHome,
        project,
      ),
    ).toEqual({ agent: "pi", session_id: SID });
  });
});

describe("pi authoritative session identity", () => {
  function published(agent: string | undefined = "pi") {
    const runtime = scratchDir("todou-pi-runtime-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir);
    const path = join(dir, `${process.pid}.json`);
    const record = (id: string, file?: string) =>
      writeFileSync(
        path,
        JSON.stringify({
          v: 1,
          pid: process.pid,
          agent,
          session_id: id,
          session_file: file,
        }),
      );
    record(SID);
    return { path, record, env: { XDG_RUNTIME_DIR: runtime } };
  }

  it("lets the published session beat a newer neighboring log and native snapshot", () => {
    const dir = agentDir();
    const ours = writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("provider", "ours")],
      mtime: recently(2),
    });
    writeSession({
      agentDir: dir,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("provider", "neighbor")],
      mtime: recently(1),
    });
    const state = published();
    state.record(SID, ours);
    expect(
      detect(
        {
          ...ENV,
          ...state.env,
          TODOU_PI_STATE: state.path,
          PI_CODING_AGENT_DIR: dir,
          PI_SESSION_ID: OTHER_SID,
          PI_PROVIDER: "provider",
          PI_MODEL: "stale",
        },
        home,
        project,
      ),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/ours",
    });
  });

  it("keeps a published id when its log is absent without borrowing another model", () => {
    const state = published();
    state.record(SID, join(home, "absent.jsonl"));
    expect(
      detect(
        {
          ...ENV,
          TODOU_PI_STATE: state.path,
          PI_SESSION_ID: OTHER_SID,
          PI_MODEL: "stale",
        },
        home,
        project,
      ),
    ).toEqual({ agent: "pi", session_id: SID });
  });

  it("retains the native model for a published ephemeral session with the same id", () => {
    const state = published();
    expect(
      detect(
        {
          ...ENV,
          TODOU_PI_STATE: state.path,
          PI_SESSION_ID: SID,
          PI_PROVIDER: "provider",
          PI_MODEL: "ephemeral",
        },
        home,
        project,
      ),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/ephemeral",
    });
  });

  it("uses native session and model variables before a log exists", () => {
    expect(
      detect(
        {
          ...ENV,
          PI_SESSION_ID: SID,
          PI_SESSION_FILE: join(home, `absent_${SID}.jsonl`),
          PI_PROVIDER: "provider",
          PI_MODEL: "native",
        },
        home,
        project,
      ),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/native",
    });
  });

  it("recognizes native model switches within the same session on each invocation", () => {
    const env = {
      ...ENV,
      PI_SESSION_ID: SID,
      PI_PROVIDER: "provider",
      PI_CODING_AGENT_DIR: agentDir(),
    };
    for (const model of ["first", "second", "first"]) {
      expect(detect({ ...env, PI_MODEL: model }, home, project)).toEqual({
        agent: "pi",
        session_id: SID,
        model: `provider/${model}`,
      });
    }
  });

  it("re-reads model switches from the published session's updated log", () => {
    const dir = agentDir();
    const file = writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("provider", "first")],
    });
    const state = published();
    state.record(SID, file);
    const env = {
      ...ENV,
      TODOU_PI_STATE: state.path,
      PI_CODING_AGENT_DIR: dir,
      PI_SESSION_ID: SID,
      PI_PROVIDER: "provider",
      PI_MODEL: "first",
    };
    expect(detect(env, home, project)).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/first",
    });
    for (const model of ["second", "first"]) {
      writeSession({
        agentDir: dir,
        cwd: project,
        id: SID,
        lines: [
          modelChange("provider", "first"),
          assistant("provider", "first"),
          modelChange("provider", model),
        ],
      });
      expect(detect(env, home, project)).toEqual({
        agent: "pi",
        session_id: SID,
        model: `provider/${model}`,
      });
    }
  });

  it("uses an ephemeral native session instead of an adjacent persisted log", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("provider", "neighbor")],
    });
    const env = {
      ...ENV,
      PI_CODING_AGENT_DIR: dir,
      PI_SESSION_ID: SID,
      PI_SESSION_FILE: "",
      PI_PROVIDER: "provider",
      PI_MODEL: "ephemeral",
    };
    const io = procTree([
      { pid: 424242, ppid: 424243, env },
      { pid: 424243, ppid: 0, argv: ["pi", "--no-session"], cwd: project },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/ephemeral",
    });
  });

  it("reads the native session file for a missing model without scanning neighbors", () => {
    const file = writeSession({
      agentDir: agentDir(),
      cwd: project,
      id: SID,
      lines: [modelChange("provider", "from-file")],
    });
    expect(
      detect(
        {
          ...ENV,
          PI_SESSION_ID: SID,
          PI_SESSION_FILE: file,
        },
        home,
        project,
      ),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/from-file",
    });
    expect(
      detect(
        {
          ...ENV,
          PI_SESSION_ID: OTHER_SID,
          PI_SESSION_FILE: file,
        },
        home,
        project,
      ),
    ).toEqual({ agent: "pi", session_id: OTHER_SID });
  });

  it("preserves legacy log recovery when native variables or state are unusable", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("provider", "legacy")],
    });
    const state = published();
    writeFileSync(state.path, "{");
    expect(
      detect(
        {
          ...ENV,
          PI_CODING_AGENT_DIR: dir,
          PI_SESSION_ID: "../invalid",
          TODOU_PI_STATE: state.path,
        },
        home,
        project,
      ),
    ).toEqual({
      agent: "pi",
      session_id: SID,
      model: "provider/legacy",
    });
  });

  it.each(["../bad", "bad/id", "x".repeat(201)])(
    "rejects native id %s",
    (id) => {
      expect(
        detect(
          {
            ...ENV,
            PI_CODING_AGENT_DIR: agentDir(),
            PI_SESSION_ID: id,
            PI_PROVIDER: "provider",
            PI_MODEL: "bad",
          },
          home,
          project,
        ),
      ).toEqual({ agent: "pi" });
    },
  );

  it("re-reads live state after switches and reports an unreadable file", () => {
    const state = published();
    const reader = liveSessionIdReader({
      env: { ...ENV, TODOU_PI_STATE: state.path, PI_SESSION_ID: SID },
      home,
      cwd: project,
      io: NO_TREE,
    });
    expect(reader()).toEqual({ id: SID });
    state.record(OTHER_SID);
    expect(reader()).toEqual({ id: OTHER_SID });
    writeFileSync(state.path, "{");
    expect(reader()).toEqual({ unreadable: state.path });
    rmSync(state.path);
    expect(reader()).toEqual({ unreadable: state.path });
  });

  it("never offers the native startup snapshot as a live session", () => {
    const reader = liveSessionIdReader({
      env: { ...ENV, PI_SESSION_ID: SID },
      home,
      cwd: project,
      io: NO_TREE,
    });
    expect(reader()).toEqual({});
  });

  it.each(["omp", undefined])("rejects a %s record as pi state", (agent) => {
    const state = published(agent);
    // Passing undefined to the fixture uses its default; explicitly omit the field.
    if (agent === undefined) {
      writeFileSync(
        state.path,
        JSON.stringify({
          v: 1,
          pid: process.pid,
          session_id: SID,
        }),
      );
    }
    const env = { ...ENV, TODOU_PI_STATE: state.path };
    expect(detect(env, home, project)).toEqual({ agent: "pi" });
    expect(liveSessionIdReader({ env, home, io: NO_TREE })()).toEqual({});
  });

  it("selects pi from an ancestor's published agent without any marker", () => {
    const state = published();
    const io = procTree([
      { pid: 424242, ppid: process.pid },
      { pid: process.pid, ppid: 0, argv: ["pi"] },
    ]);
    expect(detectAgentContext(state.env, home, project, io)).toEqual({
      agent: "pi",
      session_id: SID,
    });
    const reader = liveSessionIdReader({ env: state.env, home, io });
    expect(reader()).toEqual({ id: SID });
    state.record(OTHER_SID);
    expect(reader()).toEqual({ id: OTHER_SID });
    writeFileSync(state.path, "{");
    expect(reader()).toEqual({ unreadable: state.path });
  });

  it("accepts a nearer nested pi publisher inside the inherited marker boundary", () => {
    const state = published();
    const env = { ...ENV, ...state.env };
    const io = procTree([
      { pid: 424242, ppid: process.pid, env },
      { pid: process.pid, ppid: 424243, env: ENV, argv: ["pi"] },
      { pid: 424243, ppid: 0, argv: ["pi"] },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({
      agent: "pi",
      session_id: SID,
    });
    expect(liveSessionIdReader({ env, home, io })()).toEqual({ id: SID });
  });

  it.each([
    ["pi", "--no-extensions"],
    ["/opt/bin/pi", "--no-extensions"],
    ["node", "/opt/pi/cli.js", "--no-extensions"],
    ["node", "/opt/pi-coding-agent/dist/cli.js", "--no-extensions"],
    ["node", "/opt/pi-coding-agent/dist/bundle/cli.js", "--no-extensions"],
    ["bun", "/opt/bin/pi", "--no-extensions"],
  ])("bounds nested pi state at the executable invocation %j", (...argv) => {
    const state = published();
    const inherited = {
      ...ENV,
      ...state.env,
      TODOU_PI_STATE: state.path,
      PI_SESSION_ID: SID,
      PI_PROVIDER: "provider",
      PI_MODEL: "outer",
    };
    const env = {
      ...inherited,
      PI_SESSION_ID: OTHER_SID,
      PI_MODEL: "inner",
      PI_CODING_AGENT_DIR: agentDir(),
    };
    const io = procTree([
      { pid: 424242, ppid: 424243, env },
      { pid: 424243, ppid: process.pid, env: inherited, argv },
      { pid: process.pid, ppid: 0, argv: ["pi"] },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({
      agent: "pi",
      session_id: OTHER_SID,
      model: "provider/inner",
    });
    expect(liveSessionIdReader({ env, home, io })()).toEqual({});
  });

  it("lets an older nested pi use its log instead of inherited native identity", () => {
    const state = published();
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("provider", "legacy-inner")],
    });
    const env = {
      ...ENV,
      ...state.env,
      TODOU_PI_STATE: state.path,
      PI_CODING_AGENT_DIR: dir,
      PI_SESSION_ID: SID,
      PI_PROVIDER: "provider",
      PI_MODEL: "outer",
    };
    const io = procTree([
      { pid: 424242, ppid: 424243, env },
      { pid: 424243, ppid: process.pid, env, argv: ["pi", "--no-extensions"] },
      { pid: process.pid, ppid: 0, argv: ["pi"] },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({
      agent: "pi",
      session_id: OTHER_SID,
      model: "provider/legacy-inner",
    });
    expect(liveSessionIdReader({ env, home, io })()).toEqual({});
  });

  it("does not mistake shell command text or unrelated scripts for the pi executable", () => {
    for (const argv of [
      ["sh", "-c", "pi --no-extensions"],
      ["node", "/opt/unrelated/cli.js", "pi"],
      ["node", "-e", "pi"],
    ]) {
      const outer = { pid: 424243, uid: 1000, env: {}, argv: ["pi"] };
      expect(
        piHostAncestor([{ pid: 424242, uid: 1000, env: ENV, argv }, outer]),
      ).toBe(outer);
    }
  });

  it("prevents omp from reading a pi record even without a process tree", () => {
    const state = published();
    const env = { OMPCODE: "1", TODOU_OMP_STATE: state.path };
    expect(detect(env, home, project)).toEqual({ agent: "omp" });
    expect(liveSessionIdReader({ env, home, io: NO_TREE })()).toEqual({});
  });

  it("does not claim an outer pi record when omp is the actual host", () => {
    const state = published();
    const env = {
      ...ENV,
      ...state.env,
      OMPCODE: "1",
      TODOU_OMP_STATE: state.path,
      PI_SESSION_ID: SID,
      PI_CODING_AGENT_DIR: agentDir(),
    };
    const io = procTree([
      { pid: 424242, ppid: 424243, env },
      { pid: 424243, ppid: process.pid, env: ENV, argv: ["omp"] },
      { pid: process.pid, ppid: 0, argv: ["pi"] },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({
      agent: "omp",
    });
    expect(liveSessionIdReader({ env, home, io })()).toEqual({});
  });

  it("does not claim an outer omp record or inherited native variables from inner pi", () => {
    const state = published("omp");
    const inherited = {
      OMPCODE: "1",
      PI_SESSION_ID: SID,
      PI_SESSION_FILE: join(home, `outer_${SID}.jsonl`),
      PI_PROVIDER: "provider",
      PI_MODEL: "outer",
    };
    const env = {
      ...ENV,
      ...inherited,
      ...state.env,
      TODOU_PI_STATE: state.path,
      TODOU_OMP_STATE: state.path,
      PI_CODING_AGENT_DIR: agentDir(),
    };
    const io = procTree([
      { pid: 424242, ppid: 424243, env },
      { pid: 424243, ppid: process.pid, env: inherited, argv: ["pi"] },
      { pid: process.pid, ppid: 0, argv: ["omp"] },
    ]);
    expect(detectAgentContext(env, home, project, io)).toEqual({ agent: "pi" });
    expect(liveSessionIdReader({ env, home, io })()).toEqual({});
    expect(
      detectAgentContext(
        {
          ...env,
          PI_SESSION_ID: OTHER_SID,
          PI_MODEL: "inner",
        },
        home,
        project,
        io,
      ),
    ).toEqual({
      agent: "pi",
      session_id: OTHER_SID,
      model: "provider/inner",
    });
  });
});

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
      lines: [modelChange("llm-gw", "example-v4-pro"), userLine],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "pi",
        session_id: SID,
        model: "llm-gw/example-v4-pro",
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
        modelChange("llm-gw", "old-model"),
        assistant("llm-gw", "answered-with"),
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("llm-gw/answered-with");

    const swapped = agentDir();
    writeSession({
      agentDir: swapped,
      cwd: project,
      id: SID,
      lines: [
        assistant("llm-gw", "old-model"),
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
      lines: [modelChange("llm-gw", "stale-model")],
      mtime: recently(2),
    });
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "live-model")],
      mtime: recently(1),
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi", session_id: SID, model: "llm-gw/live-model" },
    );
  });

  it("refuses a session log too old to be the one being written", () => {
    const dir = agentDir();
    // pi has no integration to publish its id and does not opt into the
    // descriptor check, so this floor is the whole of what keeps a finished
    // session from being reported as the live one.
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "finished-yesterday")],
      mtime: recently(26 * 60 * 60),
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "pi" },
    );
  });

  it("finds pi's session when a tool runs us from a subdirectory", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "example-v4-pro")],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, nested)).toEqual({
      agent: "pi",
      session_id: SID,
      model: "llm-gw/example-v4-pro",
    });
  });

  it("ignores a session whose cwd does not contain ours", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: nested,
      id: SID,
      lines: [modelChange("llm-gw", "deeper-model")],
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
      lines: [modelChange("llm-gw", "foreign-model")],
      mtime: recently(1),
    });
    writeSession({
      dir: flat,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "ours")],
      mtime: recently(2),
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_SESSION_DIR: flat }, home, project),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/ours" });
  });

  it("treats bound-but-empty pi directories as unset (T-120 shape)", () => {
    const dir = agentDir();
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "example-v4-pro")],
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
    ).toBe("llm-gw/example-v4-pro");
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
        modelChange("llm-gw", "example-v4-pro"),
        JSON.stringify({ type: "note", text: 'mentions "model" but is junk' }),
        '{"type":"model_change","modelId":',
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("llm-gw/example-v4-pro");
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
      lines: [modelChange("llm-gw", "recovered")],
    });
    expect(
      detectAgentContext(
        ENV,
        home,
        project,
        piHost({ argv: ["pi", "--session-dir", flat] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/recovered" });
  });

  it("lets pi's flag beat the environment variable", () => {
    const fromEnv = mkdtempSync(join(tmpdir(), "todou-pi-env-"));
    const fromFlag = mkdtempSync(join(tmpdir(), "todou-pi-flag-"));
    procRoots.push(fromEnv, fromFlag);
    writeSession({
      dir: fromEnv,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw", "from-env")],
    });
    writeSession({
      dir: fromFlag,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "from-flag")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_SESSION_DIR: fromEnv },
        home,
        project,
        piHost({ argv: ["pi", `--session-dir=${fromFlag}`] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/from-flag" });
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
      lines: [modelChange("llm-gw", "by-host-cwd")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        elsewhere,
        piHost({ cwd: project }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/by-host-cwd" });
  });

  it("takes a --session path from outside every scanned directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "todou-pi-outside-"));
    procRoots.push(outside);
    const path = writeSession({
      dir: outside,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "named")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: agentDir() },
        home,
        project,
        piHost({ argv: ["pi", "--session", path] }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/named" });
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
      lines: [modelChange("llm-gw", "started-with")],
      mtime: recently(2),
    });
    writeSession({
      agentDir: dir,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw", "resumed-into")],
      mtime: recently(1),
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        piHost({ argv: ["pi", "--session", started], cwd: project }),
      ),
    ).toEqual({ agent: "pi", session_id: SID, model: "llm-gw/resumed-into" });
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
      lines: [modelChange("llm-gw", "example-v4-pro")],
    });
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["whoami"], {
      fetchImpl,
      env: { ...loggedInEnv(), ...ENV, PI_CODING_AGENT_DIR: dir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `detected harness: pi (session ${SID}, model llm-gw/example-v4-pro)`,
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
