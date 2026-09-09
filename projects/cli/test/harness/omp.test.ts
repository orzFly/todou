import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectAgentContext } from "../../src/harness/index.ts";
import { fakeFetch, loggedInEnv, runCli } from "../harness.ts";

/*
 * omp asks for its host process, so every case here would otherwise read the
 * real process tree and take the cwd and argv of whatever ran the suite as
 * omp's own. An unreadable tree pins these tests to what the environment
 * alone can say; the host-driven paths get a fixture tree further down.
 */
const NO_TREE = {
  platform: "linux" as const,
  procRoot: "/nonexistent",
  startPid: 0,
};
const detect: typeof detectAgentContext = (env, home, cwd) =>
  detectAgentContext(env, home, cwd, NO_TREE);

/* A home whose ~/.omp never exists: the no-session degradation baseline. */
const home = mkdtempSync(join(tmpdir(), "todou-omp-home-"));
/* A project tree to stand in for omp's cwd; sessions key off its real path. */
const project = mkdtempSync(join(tmpdir(), "todou-omp-project-"));
const nested = join(project, "projects", "cli");
mkdirSync(nested, { recursive: true });
/* And one under $HOME, which omp encodes differently from everywhere else. */
const homeProject = join(home, "work", "app");
mkdirSync(homeProject, { recursive: true });

const scratch: string[] = [home, project];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A fresh empty $PI_CODING_AGENT_DIR, so tests never see each other. */
function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "todou-omp-agent-"));
  scratch.push(dir);
  return dir;
}

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const SID = "01900000-0000-7000-8000-000000000001";
const OTHER_SID = "01900000-0000-7000-8000-000000000002";

/*
 * The temporary directory is named explicitly, because it is one of the three
 * roots omp measures a cwd against and the suite's own fixtures live under it:
 * leaving it to be guessed would make these tests pass or fail on whether
 * $TMPDIR happened to be set in the shell that ran them.
 */
const ENV = { OMPCODE: "1", TMPDIR: tmpdir() };
/* The same marker with both other roots out of reach: omp's absolute form. */
const ENV_ABS = { OMPCODE: "1", TMPDIR: "/nonexistent-tmp" };

/** omp opens every session file with a fixed-width slot for the title. */
const titleLine = JSON.stringify({
  type: "title",
  v: 1,
  title: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pad: " ".repeat(190),
});
const header = (id: string, cwd: string) =>
  JSON.stringify({ type: "session", version: 3, id, cwd });
/** omp spells the provider into the model_change itself, unlike pi. */
const modelChange = (model: string, role?: string) =>
  JSON.stringify({ type: "model_change", model, role });
const assistant = (provider: string, model: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", provider, model },
  });
const userLine = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

/**
 * omp's own encoding of a cwd into one session directory name: relative to
 * $HOME or to the temporary directory when it sits under either, and pi's
 * absolute form otherwise.
 */
function sessionDirName(cwd: string, roots: { home: string; tmp: string }) {
  const under = (rel: string) =>
    rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const prefixed = (prefix: string, rel: string) => {
    const tail = rel.replace(/[/\\:]/g, "-");
    if (!tail) return prefix;
    return prefix.endsWith("-") ? `${prefix}${tail}` : `${prefix}-${tail}`;
  };
  const fromHome = relative(roots.home, cwd);
  if (under(fromHome)) return prefixed("-", fromHome);
  const fromTmp = relative(roots.tmp, cwd);
  if (under(fromTmp)) return prefixed("-tmp", fromTmp);
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Write a session log the way omp does. `mtime` orders sessions against each
 * other — recency is how the live one is picked.
 */
function writeSession(opts: {
  sessionsRoot?: string;
  dir?: string;
  cwd: string;
  id: string;
  lines?: string[];
  mtime?: number;
  homeRoot?: string;
  tmpRoot?: string;
  omitTitle?: true;
}): string {
  const dir =
    opts.dir ??
    join(
      opts.sessionsRoot ?? join(home, ".omp", "agent", "sessions"),
      sessionDirName(opts.cwd, {
        home: opts.homeRoot ?? home,
        tmp: opts.tmpRoot ?? tmpdir(),
      }),
    );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-01-01T00-00-00-000Z_${opts.id}.jsonl`);
  writeFileSync(
    path,
    [
      ...(opts.omitTitle ? [] : [titleLine]),
      header(opts.id, opts.cwd),
      ...(opts.lines ?? []),
    ].join("\n"),
  );
  if (opts.mtime !== undefined) utimesSync(path, opts.mtime, opts.mtime);
  return path;
}

/** The sessions directory omp uses under a given $PI_CODING_AGENT_DIR. */
const sessionsIn = (dir: string) => join(dir, "sessions");

describe("omp detection", () => {
  it("returns null without the omp marker", () => {
    expect(detect({}, home, project)).toBeNull();
    expect(detect({ OMPCODE: "0" }, home, project)).toBeNull();
    // Sharing pi's variables is not being pi's fork at runtime: an ordinary
    // shell may export either of these permanently.
    expect(detect({ PI_CODING_AGENT_DIR: "/x" }, home, project)).toBeNull();
    expect(detect({ OMP_PROFILE: "work" }, home, project)).toBeNull();
  });

  it("wins the tie against the claude-code marker omp sets on purpose", () => {
    // omp puts CLAUDECODE=1 in its shell environment so that tools keyed on
    // Claude Code behave inside it. Both predicates therefore match every omp
    // shell, and with no tree to attribute them the registry order decides —
    // which is the whole reason omp leads it. Before T-109 this reported
    // claude-code, and with it the id of whatever claude session was outside.
    expect(
      detect(
        { ...ENV, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID },
        home,
        project,
      ),
    ).toEqual({ agent: "omp" });
  });

  it("degrades to agent-only when no session has been recorded", () => {
    expect(detect(ENV, home, project)).toEqual({ agent: "omp" });
  });

  it("reads the session id and model past omp's leading title slot", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/deepseek-v4-flash"), userLine],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
        session_id: SID,
        model: "llm-gw/deepseek-v4-flash",
      },
    );
  });

  it("takes the newest of model_change and assistant message, either way round", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [
        modelChange("llm-gw/old-model"),
        assistant("llm-gw", "answered-with"),
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("llm-gw/answered-with");

    const swapped = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(swapped),
      cwd: project,
      id: SID,
      lines: [assistant("llm-gw", "old-model"), modelChange("openai/switched")],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: swapped }, home, project)?.model,
    ).toBe("openai/switched");
  });

  it("reports a role-tagged model change, because it is still what answered", () => {
    // Every call site that records one has just made that model active —
    // including the retry fallback, which is the model the next turn runs on.
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [
        modelChange("llm-gw/first-choice"),
        modelChange("openai/stood-in", "fallback"),
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("openai/stood-in");
  });

  it("finds omp's session when a tool runs us from a subdirectory", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/deepseek-v4-flash")],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, nested)).toEqual({
      agent: "omp",
      session_id: SID,
      model: "llm-gw/deepseek-v4-flash",
    });
  });

  it("ignores a session whose cwd does not contain ours", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: nested,
      id: SID,
      lines: [modelChange("llm-gw/deeper-model")],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
      },
    );
  });

  it("picks the most recently written session when several are open", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/stale-model")],
      mtime: 1_000_000,
    });
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/live-model")],
      mtime: 2_000_000,
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
        session_id: SID,
        model: "llm-gw/live-model",
      },
    );
  });

  describe("where omp files a project's sessions", () => {
    it("encodes a cwd under $HOME relative to it", () => {
      const dir = agentDir();
      writeSession({
        sessionsRoot: sessionsIn(dir),
        cwd: homeProject,
        id: SID,
        lines: [modelChange("llm-gw/at-home")],
      });
      expect(
        detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, homeProject)?.model,
      ).toBe("llm-gw/at-home");
    });

    it("encodes a cwd under the temporary directory relative to it", () => {
      // The suite's own fixtures live there, so this is the branch every
      // other case above already runs through; asserting the name keeps it
      // from passing by accident when the encoding drifts.
      expect(sessionDirName(project, { home, tmp: tmpdir() })).toBe(
        `-tmp-${project.slice(tmpdir().length + 1)}`,
      );
    });

    it("falls back to pi's absolute form outside both", () => {
      const dir = agentDir();
      writeSession({
        sessionsRoot: sessionsIn(dir),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/absolute")],
        // A home and a temporary directory that contain nothing, so the cwd
        // is under neither and takes the third branch.
        homeRoot: "/nonexistent-home",
        tmpRoot: "/nonexistent-tmp",
      });
      expect(
        detect(
          { ...ENV_ABS, PI_CODING_AGENT_DIR: dir },
          "/nonexistent-home",
          project,
        )?.model,
      ).toBe("llm-gw/absolute");
    });

    it("follows a named profile when the variable did not reach us", () => {
      // omp exports PI_CODING_AGENT_DIR itself whenever a profile is active,
      // so this covers the environment arriving without it.
      writeSession({
        sessionsRoot: join(
          home,
          ".omp",
          "profiles",
          "work",
          "agent",
          "sessions",
        ),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/profiled")],
      });
      expect(
        detect({ ...ENV, OMP_PROFILE: "work" }, home, project)?.model,
      ).toBe("llm-gw/profiled");
    });

    it("follows PI_CONFIG_DIR", () => {
      writeSession({
        sessionsRoot: join(home, ".omp-alt", "agent", "sessions"),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/relocated")],
      });
      expect(
        detect({ ...ENV, PI_CONFIG_DIR: ".omp-alt" }, home, project)?.model,
      ).toBe("llm-gw/relocated");
    });

    it("follows the XDG data directory, and only while omp's own is in place", () => {
      const xdg = scratchDir("todou-omp-xdg-");
      writeSession({
        sessionsRoot: join(xdg, "omp", "sessions"),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/xdg")],
      });
      expect(detect({ ...ENV, XDG_DATA_HOME: xdg }, home, project)?.model).toBe(
        "llm-gw/xdg",
      );
      // A relocated agent directory takes its data with it, so the split no
      // longer applies and the session above is not ours to claim.
      expect(
        detect(
          { ...ENV, XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: agentDir() },
          home,
          project,
        ),
      ).toEqual({ agent: "omp" });
    });

    it("reads a flat session directory, filtering foreign projects by header cwd", () => {
      const flat = scratchDir("todou-omp-flat-");
      // Under one flat directory every project lands side by side, so the
      // newest file there is often somebody else's.
      writeSession({
        dir: flat,
        cwd: scratchDir("todou-omp-elsewhere-"),
        id: OTHER_SID,
        lines: [modelChange("llm-gw/foreign-model")],
        mtime: 2_000_000,
      });
      writeSession({
        dir: flat,
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/ours")],
        mtime: 1_000_000,
      });
      expect(
        detect({ ...ENV, PI_CODING_AGENT_SESSION_DIR: flat }, home, project),
      ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/ours" });
    });

    it("treats bound-but-empty omp directories as unset (T-120 shape)", () => {
      const dir = agentDir();
      writeSession({
        sessionsRoot: sessionsIn(dir),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/deepseek-v4-flash")],
      });
      expect(
        detect(
          {
            ...ENV,
            PI_CODING_AGENT_DIR: dir,
            PI_CODING_AGENT_SESSION_DIR: "",
            PI_CONFIG_DIR: "",
            OMP_PROFILE: "",
          },
          home,
          project,
        )?.model,
      ).toBe("llm-gw/deepseek-v4-flash");
    });
  });

  it.each([
    ["a headerless file", ["not json at all"]],
    ["a half-written header", ['{"type":"session","id":"tru']],
    ["a foreign opening entry", [JSON.stringify({ type: "message" })]],
    ["an empty file", [""]],
  ])("degrades to agent-only on %s", (_name, lines) => {
    const dir = agentDir();
    const target = join(
      sessionsIn(dir),
      sessionDirName(project, { home, tmp: tmpdir() }),
    );
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `x_${SID}.jsonl`), lines.join("\n"));
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
      },
    );
  });

  it("keeps the session when the log carries no model yet", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [userLine],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
        session_id: SID,
      },
    );
  });

  it("skips unparseable lines to reach the newest real entry", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [
        modelChange("llm-gw/deepseek-v4-flash"),
        JSON.stringify({ type: "note", text: 'mentions "model" but is junk' }),
        '{"type":"model_change","model":',
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("llm-gw/deepseek-v4-flash");
  });
});

describe("omp session recovery through the host process", () => {
  /** A process tree in which omp itself is our host, carrying argv and cwd. */
  function ompHost(opts: { argv?: string[]; cwd?: string }) {
    const root = scratchDir("todou-omp-proc-");
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
    // The shell omp spawned carries both markers; omp itself carries neither,
    // which is what identifies it as the one that introduced them.
    write(100, 101, { OMPCODE: "1", CLAUDECODE: "1" }, ["sh", "-c", "todou"]);
    write(101, 0, {}, opts.argv ?? ["omp"], opts.cwd);
    return { platform: "linux" as const, procRoot: root, startPid: 100 };
  }

  it("recovers a --session-dir that exists only on omp's command line", () => {
    const flat = scratchDir("todou-omp-flat-");
    writeSession({
      dir: flat,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/recovered")],
    });
    expect(
      detectAgentContext(
        ENV,
        home,
        project,
        ompHost({ argv: ["omp", "--session-dir", flat] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/recovered" });
  });

  it("lets omp's flag beat the environment variable", () => {
    const fromEnv = scratchDir("todou-omp-env-");
    const fromFlag = scratchDir("todou-omp-flag-");
    writeSession({
      dir: fromEnv,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/from-env")],
    });
    writeSession({
      dir: fromFlag,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/from-flag")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_SESSION_DIR: fromEnv },
        home,
        project,
        ompHost({ argv: ["omp", `--session-dir=${fromFlag}`] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/from-flag" });
  });

  it("claims omp's session when we run outside omp's own directory", () => {
    const dir = agentDir();
    const elsewhere = scratchDir("todou-omp-elsewhere-");
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/by-host-cwd")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        elsewhere,
        ompHost({ cwd: project }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/by-host-cwd" });
  });

  it("takes a --resume path from outside every scanned directory", () => {
    const outside = scratchDir("todou-omp-outside-");
    const path = writeSession({
      dir: outside,
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/named")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: agentDir() },
        home,
        project,
        ompHost({ argv: ["omp", "--resume", path] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/named" });
  });

  it("ignores a --resume that names an id prefix rather than a file", () => {
    // The same flag opens a picker or matches an id prefix, and neither is a
    // path; the scan is what answers then, exactly as with no flag at all.
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/by-scan")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ argv: ["omp", "--resume", "01900000"] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/by-scan" });
  });

  it("lets a newer session beat the one named on the command line", () => {
    // `/resume` switches sessions from inside a running omp, which leaves the
    // argv naming a session omp has left; the live one is still the one being
    // appended to.
    const dir = agentDir();
    const outside = scratchDir("todou-omp-resumed-");
    const started = writeSession({
      dir: outside,
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/started-with")],
      mtime: 1_000_000,
    });
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/resumed-into")],
      mtime: 2_000_000,
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ argv: ["omp", "-r", started], cwd: project }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/resumed-into" });
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
    // The command resolves its own cwd, so the session has to be filed under
    // the one the suite really runs in.
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: process.cwd(),
      id: SID,
      lines: [modelChange("llm-gw/deepseek-v4-flash")],
      homeRoot: home,
    });
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["whoami"], {
      fetchImpl,
      home,
      env: { ...loggedInEnv(), ...ENV, PI_CODING_AGENT_DIR: dir },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `detected harness: omp (session ${SID}, model llm-gw/deepseek-v4-flash)`,
    );
  });

  it("write commands carry the omp context", async () => {
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
      // Point at an empty agent dir so the probe never sees a real ~/.omp on
      // the machine running the tests.
      env: {
        ...loggedInEnv("todou"),
        ...ENV,
        PI_CODING_AGENT_DIR: agentDir(),
      },
    });
    expect(result.exitCode).toBe(0);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(JSON.parse(headers["x-todou-agent-context"] as string)).toEqual({
      agent: "omp",
    });
  });
});
