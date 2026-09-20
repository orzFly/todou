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
import {
  detectAgentContext,
  liveSessionIdReader,
} from "../../src/harness/index.ts";
import { readOmpStateAt } from "../../src/harness/omp-state.ts";
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
/*
 * `XDG_RUNTIME_DIR` is pinned to an empty directory for the same reason: it is
 * where the extension publishes its records, so leaving it unset would point
 * these tests at whatever a real omp on the developer's machine had written
 * there. Cases that want a record write one into a directory of their own.
 */
const ENV = {
  OMPCODE: "1",
  TMPDIR: tmpdir(),
  XDG_RUNTIME_DIR: scratchDir("todou-omp-noruntime-"),
};
/* The same marker with both other roots out of reach: omp's absolute form. */
const ENV_ABS = {
  OMPCODE: "1",
  TMPDIR: "/nonexistent-tmp",
  XDG_RUNTIME_DIR: ENV.XDG_RUNTIME_DIR,
};

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

/**
 * An mtime `secondsAgo` back, in the seconds `utimesSync` takes.
 *
 * Ordering fixtures may not use bare small numbers any more: those land in
 * 1970, and the detector now refuses a log too old to be the one the harness
 * is writing. A fixture that means "older than the other" has to say so
 * without also meaning "older than an hour".
 */
const recently = (secondsAgo: number) => Date.now() / 1000 - secondsAgo;

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
      lines: [modelChange("llm-gw/example-v4-flash"), userLine],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
        session_id: SID,
        model: "llm-gw/example-v4-flash",
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
      lines: [modelChange("llm-gw/example-v4-flash")],
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, nested)).toEqual({
      agent: "omp",
      session_id: SID,
      model: "llm-gw/example-v4-flash",
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
      mtime: recently(2),
    });
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/live-model")],
      mtime: recently(1),
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      {
        agent: "omp",
        session_id: SID,
        model: "llm-gw/live-model",
      },
    );
  });

  it("refuses a session log too old to be the one being written", () => {
    const dir = agentDir();
    // Being the newest log this project has is not the same as being live. A
    // live one is seconds old, because omp appends the user's message before
    // running the tool that calls us; an hour is three orders of magnitude of
    // room. What this rules out is `--no-session`, where the newest log is a
    // finished session and recency would report it as the current one.
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/finished-yesterday")],
      mtime: recently(26 * 60 * 60),
    });
    expect(detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)).toEqual(
      { agent: "omp" },
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

    it("keeps the XDG split under a profile that overrules the override", () => {
      // The override does not relocate anything here — omp discards it in
      // favour of the profile — so omp's directory is still where omp put it
      // and the split still applies. Reading the override as a relocation
      // would lose this session entirely.
      const xdg = scratchDir("todou-omp-xdg-profile-");
      writeSession({
        sessionsRoot: join(xdg, "omp", "profiles", "work", "sessions"),
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/xdg-profiled")],
      });
      expect(
        detect(
          {
            ...ENV,
            XDG_DATA_HOME: xdg,
            OMP_PROFILE: "work",
            PI_CODING_AGENT_DIR: agentDir(),
          },
          home,
          project,
        )?.model,
      ).toBe("llm-gw/xdg-profiled");
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
        mtime: recently(1),
      });
      writeSession({
        dir: flat,
        cwd: project,
        id: SID,
        lines: [modelChange("llm-gw/ours")],
        mtime: recently(2),
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
        lines: [modelChange("llm-gw/example-v4-flash")],
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
      ).toBe("llm-gw/example-v4-flash");
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
        modelChange("llm-gw/example-v4-flash"),
        JSON.stringify({ type: "note", text: 'mentions "model" but is junk' }),
        '{"type":"model_change","model":',
      ],
    });
    expect(
      detect({ ...ENV, PI_CODING_AGENT_DIR: dir }, home, project)?.model,
    ).toBe("llm-gw/example-v4-flash");
  });
});

/** A process tree in which omp itself is our host, carrying argv and cwd. */
function ompHost(opts: {
  pid?: number;
  argv?: string[];
  cwd?: string;
  /**
   * Descriptors to hang off omp. Absent leaves no `fd/` at all, which is
   * how a kernel without `/proc` and a process we may not read both look —
   * and is why every case written before this option still exercises the
   * recency path.
   */
  openLogs?: string[];
  /** What omp's fd 0 points at: its terminal, or anything else it was given. */
  stdin?: string;
}) {
  const root = scratchDir("todou-omp-proc-");
  const write = (
    pid: number,
    ppid: number,
    env: Record<string, string>,
    argv: string[],
    cwd?: string,
    fds?: Record<number, string>,
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
    if (fds) {
      const fd = join(dir, "fd");
      mkdirSync(fd, { recursive: true });
      // Numbered the way the kernel does, and pointed straight at the
      // target: an empty directory is a process holding nothing open. The
      // links are allowed to dangle — a terminal is not a file we can make.
      for (const [n, target] of Object.entries(fds)) {
        symlinkSync(target, join(fd, n));
      }
    }
  };
  // Descriptor 0 is the terminal's slot, so the logs start at 1 whenever one
  // is asked for — which is also how a real process is numbered.
  const fds: Record<number, string> = {};
  if (opts.stdin !== undefined) fds[0] = opts.stdin;
  for (const [i, target] of (opts.openLogs ?? []).entries()) {
    fds[i + 1] = target;
  }
  const table =
    opts.stdin === undefined && opts.openLogs === undefined ? undefined : fds;
  // The shell omp spawned carries both markers; omp itself carries neither,
  // which is what identifies it as the one that introduced them.
  const pid = opts.pid ?? 101;
  write(100, pid, { OMPCODE: "1", CLAUDECODE: "1" }, ["sh", "-c", "todou"]);
  write(pid, 0, {}, opts.argv ?? ["omp"], opts.cwd, table);
  return { platform: "linux" as const, procRoot: root, startPid: 100 };
}

describe("omp session recovery through the host process", () => {
  /*
   * omp holds its live log open for append, so the descriptor table answers
   * what recency can only infer. These four cover the answer and each way of
   * not having one, because the interesting part is which of those falls back
   * to guessing and which reports nothing at all.
   */
  it("takes the log omp holds open over the newest one", () => {
    const dir = agentDir();
    // What recency alone would have said: newer, and not the one omp is in.
    // This is T-308's smoke test in miniature — two instances, one project.
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/other-instance")],
      mtime: recently(1),
    });
    const held = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/ours")],
      mtime: recently(30),
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ openLogs: [held] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/ours" });
  });

  it("reports no session when omp holds no log open", () => {
    const dir = agentDir();
    // `--no-session`: the log below is a real past session of this project,
    // and recency would hand back its id as the current one.
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/archived")],
      mtime: recently(1),
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ openLogs: [] }),
      ),
    ).toEqual({ agent: "omp" });
  });

  it("falls back to recency when several logs are held open", () => {
    const dir = agentDir();
    const older = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/older")],
      mtime: recently(30),
    });
    const newer = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/newer")],
      mtime: recently(1),
    });
    // Nothing measured says what two open logs mean, so this is the one case
    // that stays a guess rather than becoming a refusal.
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ openLogs: [older, newer] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/newer" });
  });

  it("reports no session when the held log has no header yet", () => {
    const dir = agentDir();
    // A log open but not yet declared is still the session omp is in, so the
    // scan's answer is the wrong one and silence is the right one.
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/somebody-else")],
      mtime: recently(1),
    });
    const blank = join(sessionsIn(dir), "brand-new.jsonl");
    writeFileSync(blank, "");
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ openLogs: [blank] }),
      ),
    ).toEqual({ agent: "omp" });
  });

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
      mtime: recently(2),
    });
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/resumed-into")],
      mtime: recently(1),
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

/*
 * The extension's half of the contract, read from this side (T-308). Every
 * case here also proves the fallback: a record this reader will not believe
 * has to leave the scan above working exactly as it did without one, because
 * "no extension installed" is the state most omp sessions are in.
 */
describe("the session omp publishes for itself", () => {
  const runtime = scratchDir("todou-omp-runtime-");
  /** The state file the extension writes, named after omp's own pid. */
  const statePath = (pid: number) => join(runtime, `${pid}.json`);
  /** No process has this pid: Linux caps at 4194304 by default. */
  const DEAD = 2147483647;

  function writeState(pid: number, body: unknown, at = statePath(pid)): string {
    writeFileSync(at, typeof body === "string" ? body : JSON.stringify(body));
    return at;
  }

  const state = (pid: number, sessionId: string, sessionFile?: string) => ({
    v: 1,
    pid,
    agent: "omp",
    session_id: sessionId,
    ...(sessionFile === undefined ? {} : { session_file: sessionFile }),
    updated_at: "2026-09-09T09:03:27.798Z",
  });

  /**
   * Two omp instances open on one project, which is the case the scan cannot
   * resolve even in principle: the newest write is the only signal it has, so
   * whichever instance spoke last takes both instances' identity. The record
   * decides it, and the assertion is that the *older* session wins — a
   * detector still scanning would report the newer one and look correct.
   */
  it("beats the scan where the scan is guessing", () => {
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/ours")],
      mtime: recently(2),
    });
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/the-other-instance")],
      mtime: recently(1),
    });
    const ours = join(
      sessionsIn(dir),
      sessionDirName(project, { home, tmp: tmpdir() }),
      `2026-01-01T00-00-00-000Z_${SID}.jsonl`,
    );
    const env = {
      ...ENV,
      PI_CODING_AGENT_DIR: dir,
      TODOU_OMP_STATE: writeState(process.pid, state(process.pid, SID, ours)),
    };
    expect(detect(env, home, project)).toEqual({
      agent: "omp",
      session_id: SID,
      model: "llm-gw/ours",
    });
    // And with the record gone the same environment falls back to the guess,
    // so the case above is the record's doing and not the fixture's.
    rmSync(env.TODOU_OMP_STATE);
    expect(detect(env, home, project)).toEqual({
      agent: "omp",
      session_id: OTHER_SID,
      model: "llm-gw/the-other-instance",
    });
  });

  it("reports the id alone when the record names no session file", () => {
    const path = writeState(process.pid, state(process.pid, SID));
    expect(detect({ ...ENV, TODOU_OMP_STATE: path }, home, project)).toEqual({
      agent: "omp",
      session_id: SID,
    });
  });

  /*
   * The push endpoint travels in the record because omp's curated environment
   * does not carry it anywhere but the bash tool. It is read as a pair, and a
   * record that fails any part of it has to degrade to "no channel" without
   * taking the session id down with it — the id is what an older extension
   * publishes, and that extension is installed on real machines right now.
   */
  describe("the push channel the record carries", () => {
    const SOCK = "/run/user/1000/todou-omp/9.sock";
    const TOKEN = "9f2c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d";
    const channel = (socket?: unknown, token?: unknown) =>
      readOmpStateAt(
        writeState(process.pid, {
          ...state(process.pid, SID),
          ...(socket === undefined ? {} : { socket }),
          ...(token === undefined ? {} : { token }),
        }),
      );

    it("reads a socket and a token that belong together", () => {
      expect(channel(SOCK, TOKEN)).toMatchObject({
        sessionId: SID,
        socket: SOCK,
        token: TOKEN,
      });
    });

    it.each([
      ["a relative socket path", "todou-omp/9.sock", TOKEN],
      ["a socket that is not one", "/run/user/1000/todou-omp/9", TOKEN],
      ["a socket that is not a string", 9, TOKEN],
      ["an empty token", SOCK, ""],
      ["a token of some other type", SOCK, { value: TOKEN }],
      ["a token past any plausible length", SOCK, "a".repeat(513)],
      ["a socket with no token beside it", SOCK, undefined],
      ["a token with no socket beside it", undefined, TOKEN],
    ])("keeps the session id and drops the channel on %s", (_n, sock, tok) => {
      const read = channel(sock, tok);
      expect(read?.sessionId).toBe(SID);
      expect(read?.socket).toBeUndefined();
      expect(read?.token).toBeUndefined();
    });

    it("reads the record an older extension wrote, channel and all absent", () => {
      // The regression that matters: every omp on this machine running the
      // previous extension publishes exactly this, and it must keep answering.
      expect(channel()).toMatchObject({ sessionId: SID });
    });
  });

  describe("the tool names the record carries", () => {
    const read = (tools: unknown) =>
      readOmpStateAt(
        writeState(process.pid, { ...state(process.pid, SID), tools }),
      );

    it("reads a list of names", () => {
      expect(read(["todou_watch"])?.tools).toEqual(["todou_watch"]);
    });

    it("reads nothing where the record carries none", () => {
      expect(read(undefined)?.tools).toBeUndefined();
    });

    it.each([
      ["not an array", "todou_watch"],
      ["an entry that is not a string", ["todou_watch", 3]],
      ["a name with a character a tool may not carry", ["Todou Watch"]],
      ["a name past 64 characters", ["t".repeat(65)]],
      [
        "more names than any real extension registers",
        Array.from({ length: 17 }, (_, i) => `t${i}`),
      ],
    ])("drops the whole field on %s", (_n, tools) => {
      expect(read(tools)?.tools).toBeUndefined();
    });
  });

  describe("falls back to the scan rather than believe a bad record", () => {
    /* A recorded session for the scan to find, so a fallback is visible as
       an answer rather than as the agent-only degradation. */
    const dir = agentDir();
    writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/scanned")],
    });
    const scanned = {
      agent: "omp",
      session_id: OTHER_SID,
      model: "llm-gw/scanned",
    };
    const fallsBack = (path: string) => {
      expect(
        detect(
          { ...ENV, PI_CODING_AGENT_DIR: dir, TODOU_OMP_STATE: path },
          home,
          project,
        ),
      ).toEqual(scanned);
    };

    it("when the file is not there", () => {
      fallsBack(join(runtime, "never-written.json"));
    });

    it("when the JSON is half-written", () => {
      fallsBack(writeState(process.pid, '{"v":1,"pid":'));
    });

    it("when the version is one this does not know", () => {
      fallsBack(writeState(process.pid, { ...state(process.pid, SID), v: 2 }));
    });

    it("when the record names a pid other than the file it is in", () => {
      // A copied or hand-edited record, which is what ties the answer to the
      // path we were pointed at rather than to any file that parses.
      fallsBack(writeState(process.pid, state(DEAD, SID)));
    });

    it("when the process that wrote it is gone", () => {
      // A crash between the last write and `session_shutdown` leaves this
      // behind, and its id belongs to a session nobody is in any more.
      fallsBack(writeState(DEAD, state(DEAD, SID)));
    });

    it("when the id is not one that may go into a URL", () => {
      fallsBack(writeState(process.pid, state(process.pid, "../../etc")));
    });
  });

  describe("liveSessionId", () => {
    const read = (env: Record<string, string>) =>
      liveSessionIdReader({ env: { ...ENV, ...env }, home, io: NO_TREE })();

    it("re-reads the record on every call", () => {
      const path = statePath(process.pid);
      writeState(process.pid, state(process.pid, SID));
      const reader = liveSessionIdReader({
        env: { ...ENV, TODOU_OMP_STATE: path },
        home,
        io: NO_TREE,
      });
      expect(reader()).toEqual({ id: SID });
      // What a `/new` or a `/resume` does to it mid-watch: the session id
      // rotates without the process changing, so a reader that captured the
      // first answer would keep filtering on a session nobody is in.
      writeState(process.pid, state(process.pid, OTHER_SID));
      expect(reader()).toEqual({ id: OTHER_SID });
    });

    it("says nothing at all where the extension is not installed", () => {
      expect(read({})).toEqual({});
    });

    it("names the file it could not believe", () => {
      // Not `{}`: falling back silently here restores the startup snapshot
      // this probe exists to replace, and does it looking like a success.
      const path = writeState(DEAD, state(DEAD, SID));
      expect(read({ TODOU_OMP_STATE: path })).toEqual({ unreadable: path });
    });
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
      lines: [modelChange("llm-gw/example-v4-flash")],
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
      `detected harness: omp (session ${SID}, model llm-gw/example-v4-flash)`,
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

/*
 * omp creates its session log at the first turn, not at session start, so
 * early in a session there is no log and no descriptor to hold — and the
 * variable that names the extension's record reaches only omp's own bash tool.
 * These cases are that window: the record is the only thing that can answer,
 * and it is found by asking which ancestor published it (T-312).
 */
describe("the session omp published, found by ancestor pid", () => {
  /**
   * omp's pid is our own throughout, because the record is only believed while
   * the process that wrote it is alive — a fixture pid would be rejected for
   * being dead and would prove nothing about the lookup.
   */
  const OMP_PID = process.pid;
  const CHILD_PID = 424242;

  /** A runtime directory holding whatever records a case asks for. */
  function runtimeWith(
    records: Record<number, unknown>,
  ): Record<string, string> {
    const runtime = scratchDir("todou-omp-rt-");
    const dir = join(runtime, "todou-omp");
    mkdirSync(dir, { recursive: true });
    for (const [pid, body] of Object.entries(records)) {
      writeFileSync(
        join(dir, `${pid}.json`),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }
    return { XDG_RUNTIME_DIR: runtime };
  }

  const record = (pid: number, sessionId: string, sessionFile?: string) => ({
    v: 1,
    pid,
    agent: "omp",
    session_id: sessionId,
    ...(sessionFile === undefined ? {} : { session_file: sessionFile }),
    updated_at: "2026-09-10T16:24:50.805Z",
  });

  /**
   * A chain of `[child, omp]`, with the environments each carries when it was
   * exec'd. `childEnv` empty is the eval-runtime shape: spawned by omp without
   * any of omp's markers.
   */
  function chain(opts: {
    childEnv?: Record<string, string>;
    childComm?: string;
    openLogs?: string[];
  }) {
    const root = scratchDir("todou-omp-chain-");
    const write = (
      pid: number,
      ppid: number,
      env: Record<string, string>,
      argv: string[],
      openLogs?: string[],
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
      symlinkSync(project, join(dir, "cwd"));
      if (openLogs) {
        const fd = join(dir, "fd");
        mkdirSync(fd, { recursive: true });
        for (const [i, target] of openLogs.entries()) {
          symlinkSync(target, join(fd, String(i)));
        }
      }
    };
    write(CHILD_PID, OMP_PID, opts.childEnv ?? {}, [
      opts.childComm ?? "python3",
      ...(opts.childComm === "omp" ? ["__omp_worker_js_eval_process"] : []),
    ]);
    write(OMP_PID, 1, {}, ["omp"], opts.openLogs);
    return {
      platform: "linux" as const,
      procRoot: root,
      startPid: CHILD_PID,
    };
  }

  /* The window itself: a session whose log has not been created yet. */
  it("answers before the log exists, with the id and no model", () => {
    const runtime = runtimeWith({
      [OMP_PID]: record(OMP_PID, SID, join(project, "not-created-yet.jsonl")),
    });
    expect(
      detectAgentContext(
        { ...ENV, ...runtime },
        home,
        project,
        chain({ childEnv: { OMPCODE: "1", CLAUDECODE: "1" } }),
      ),
    ).toEqual({ agent: "omp", session_id: SID });
  });

  it("outranks a descriptor naming a different session", () => {
    const dir = agentDir();
    const held = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/held")],
    });
    const ours = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/ours")],
    });
    const runtime = runtimeWith({ [OMP_PID]: record(OMP_PID, SID, ours) });
    expect(
      detectAgentContext(
        { ...ENV, ...runtime, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        chain({ childEnv: { OMPCODE: "1" }, openLogs: [held] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/ours" });
  });

  it("leaves the descriptor in charge when nothing was published", () => {
    const dir = agentDir();
    const held = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: SID,
      lines: [modelChange("llm-gw/held")],
    });
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        chain({ childEnv: { OMPCODE: "1" }, openLogs: [held] }),
      ),
    ).toEqual({ agent: "omp", session_id: SID, model: "llm-gw/held" });
  });

  /*
   * The JavaScript runtime re-enters omp with its hidden worker-mode argument
   * (omp v18.2.5 subprocess/worker-client.ts); Python uses python3. Neither
   * carries a marker, so the published host record selects the session.
   */
  for (const comm of ["python3", "omp"]) {
    it(`finds omp from a bare ${comm} eval runtime`, () => {
      const runtime = runtimeWith({
        [OMP_PID]: record(OMP_PID, SID, join(project, "not-created-yet.jsonl")),
      });
      expect(
        detectAgentContext(
          { TMPDIR: tmpdir(), ...runtime },
          home,
          project,
          chain({ childEnv: {}, childComm: comm }),
        ),
      ).toEqual({ agent: "omp", session_id: SID });
    });
  }

  it("takes the nearest publisher, so omp inside omp resolves to itself", () => {
    const inner = 424243;
    const root = scratchDir("todou-omp-nested-");
    const write = (pid: number, ppid: number, argv: string[]) => {
      const dir = join(root, String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "stat"), `${pid} (proc) S ${ppid} 0 0 0 -1`);
      writeFileSync(join(dir, "environ"), "\0");
      writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
    };
    // Our pid is the *inner* omp; the outer one is a pid that is also alive,
    // so the walk has two believable publishers and order alone decides.
    write(CHILD_PID, OMP_PID, ["sh"]);
    write(OMP_PID, inner, ["omp"]);
    write(inner, 1, ["omp"]);
    const runtime = runtimeWith({
      [OMP_PID]: record(OMP_PID, SID),
      [inner]: record(inner, OTHER_SID),
    });
    expect(
      detectAgentContext({ TMPDIR: tmpdir(), ...runtime }, home, project, {
        platform: "linux" as const,
        procRoot: root,
        startPid: CHILD_PID,
      }),
    ).toEqual({ agent: "omp", session_id: SID });
  });

  describe("refuses a record it cannot believe", () => {
    const bare = { TMPDIR: tmpdir() };
    const rejects = (records: Record<number, unknown>) => {
      expect(
        detectAgentContext(
          { ...bare, ...runtimeWith(records) },
          home,
          project,
          chain({ childEnv: {} }),
        ),
      ).toBeNull();
    };

    it("a version it does not know", () => {
      rejects({ [OMP_PID]: { ...record(OMP_PID, SID), v: 2 } });
    });

    it("a pid that disagrees with the file it is named by", () => {
      rejects({ [OMP_PID]: record(OMP_PID + 1, SID) });
    });

    /*
     * The record has to be believable in every way except that the process it
     * names is gone, and it has to sit on an ancestor — a pid outside the chain
     * is never read at all and would prove nothing. Only a fixture tree can
     * offer a dead ancestor, so the whole chain is fixture pids here.
     */
    it("a pid nobody is using, even sitting on an ancestor", () => {
      const DEAD = 424244;
      const root = scratchDir("todou-omp-dead-");
      for (const [pid, ppid] of [
        [CHILD_PID, DEAD],
        [DEAD, 1],
      ]) {
        const dir = join(root, String(pid));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "stat"), `${pid} (proc) S ${ppid} 0 0 0 -1`);
        writeFileSync(join(dir, "environ"), "\0");
        writeFileSync(join(dir, "cmdline"), "omp\0");
      }
      expect(
        detectAgentContext(
          { ...bare, ...runtimeWith({ [DEAD]: record(DEAD, SID) }) },
          home,
          project,
          { platform: "linux" as const, procRoot: root, startPid: CHILD_PID },
        ),
      ).toBeNull();
    });

    it("a record naming no agent", () => {
      const { agent: _, ...noAgent } = record(OMP_PID, SID);
      rejects({ [OMP_PID]: noAgent });
    });

    it("half-written json", () => {
      rejects({ [OMP_PID]: '{"v":1,"pid":' });
    });
  });

  it("ignores a runtime directory that holds no records", () => {
    expect(
      detectAgentContext(
        { TMPDIR: tmpdir(), ...runtimeWith({}) },
        home,
        project,
        chain({ childEnv: {} }),
      ),
    ).toBeNull();
  });

  /*
   * The second stage runs only when the first put up nothing, which is what
   * keeps every ordering rule in HARNESSES intact. Here Claude Code matches on
   * the environment while a believable omp record sits on an ancestor: the
   * record must not take the selection.
   */
  it("never takes a harness that matched on the environment", () => {
    const runtime = runtimeWith({ [OMP_PID]: record(OMP_PID, SID) });
    expect(
      detectAgentContext(
        { CLAUDECODE: "1", TMPDIR: tmpdir(), ...runtime },
        home,
        project,
        chain({ childEnv: { CLAUDECODE: "1" } }),
      ),
    ).toMatchObject({ agent: "claude-code" });
  });

  describe("liveSessionId", () => {
    const read = (env: Record<string, string>, io: object) =>
      liveSessionIdReader({ env, home, cwd: project, io })();

    it("reads the record even with no variable in the environment", () => {
      const runtime = runtimeWith({ [OMP_PID]: record(OMP_PID, SID) });
      expect(
        read({ TMPDIR: tmpdir(), ...runtime }, chain({ childEnv: {} })),
      ).toEqual({ id: SID });
    });

    it("names a publisher whose record would not read", () => {
      const runtime = runtimeWith({ [OMP_PID]: '{"v":1,"pid":' });
      // Selection needs a harness first, so the marker is present here; what
      // is under test is that a found-but-unreadable record is reported rather
      // than silently degrading to the startup snapshot.
      expect(
        read({ ...ENV, ...runtime }, chain({ childEnv: { OMPCODE: "1" } })),
      ).toEqual({
        unreadable: join(
          runtime.XDG_RUNTIME_DIR as string,
          "todou-omp",
          `${OMP_PID}.json`,
        ),
      });
    });
  });
});

/*
 * The last layer, and the narrowest. omp files three lines per terminal —
 * cwd, session file, and `fresh` while that file has yet to be created — the
 * moment a session exists, which is earlier than anything else here can
 * answer: earlier than the log the scan reads, and earlier than the descriptor
 * omp opens on it. A just-opened omp sits in exactly that state until its
 * first turn, and that is when somebody types `todou` in the `!` shell.
 */
describe("the session omp filed against its terminal", () => {
  const TTY = "/dev/pts/7";
  /** The name omp derives from the tty, and files the breadcrumb under. */
  const TERMINAL = "pts-7";

  /** A session file path in omp's own naming, for a file nobody created. */
  const uncreated = (id: string) =>
    join(project, "sessions", `2026-09-12T02-49-21-732Z_${id}.jsonl`);

  /** Each part of a breadcrumb a case may want to take away or point aside. */
  type Breadcrumb = {
    cwd?: string;
    file?: string;
    fresh?: false;
    terminal?: string;
  };

  /** omp's breadcrumb, written where a given agent directory keeps them. */
  function breadcrumb(root: string, opts: Breadcrumb = {}): void {
    const dir = join(root, "terminal-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, opts.terminal ?? TERMINAL),
      `${opts.cwd ?? project}\n${opts.file ?? uncreated(SID)}\n${
        opts.fresh === false ? "" : "fresh"
      }\n`,
    );
  }

  /** The whole arrangement: a relocated agent directory, and omp on a tty. */
  function read(opts: {
    breadcrumb?: Breadcrumb;
    stdin?: string;
    openLogs?: string[];
    env?: Record<string, string>;
    dir?: string;
    hostPid?: number;
  }) {
    const dir = opts.dir ?? agentDir();
    if (opts.breadcrumb) breadcrumb(dir, opts.breadcrumb);
    return detectAgentContext(
      { ...ENV, PI_CODING_AGENT_DIR: dir, ...opts.env },
      home,
      project,
      ompHost({
        pid: opts.hostPid,
        cwd: project,
        stdin: opts.stdin ?? TTY,
        ...(opts.openLogs === undefined ? {} : { openLogs: opts.openLogs }),
      }),
    );
  }

  it("answers with the session, and with no model to read", () => {
    // The model lives in the log, and the log not existing is half of why the
    // breadcrumb was believed — so this is the same answer a session opened a
    // moment ago already gave, with the session in it now.
    expect(read({ breadcrumb: {} })).toEqual({ agent: "omp", session_id: SID });
  });

  it("leaves the descriptor in charge wherever there is one", () => {
    // Ordering, stated against a breadcrumb that would otherwise be taken:
    // the descriptor names the session omp is appending to right now, while
    // this names whatever last opened the terminal.
    const dir = agentDir();
    const held = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
      lines: [modelChange("llm-gw/held")],
    });
    expect(read({ dir, breadcrumb: {}, openLogs: [held] })).toEqual({
      agent: "omp",
      session_id: OTHER_SID,
      model: "llm-gw/held",
    });
  });

  it("is never reached once omp has published a record of its own", () => {
    const runtime = scratchDir("todou-omp-crumb-rt-");
    const statePath = join(runtime, `${process.pid}.json`);
    writeFileSync(
      statePath,
      JSON.stringify({
        v: 1,
        pid: process.pid,
        agent: "omp",
        session_id: OTHER_SID,
        updated_at: "2026-09-12T02:49:21.732Z",
      }),
    );
    expect(
      read({
        breadcrumb: {},
        env: { TODOU_OMP_STATE: statePath },
        hostPid: process.pid,
      }),
    ).toEqual({ agent: "omp", session_id: OTHER_SID });
  });

  /*
   * Each of the four things that has to be true, taken away one at a time.
   * None of them degrades to a guess: the result is what this file reported
   * before the breadcrumb existed at all.
   */
  const nothing = { agent: "omp" };

  it("refuses one whose session file is already there", () => {
    // The realistic collision: pane-splitting multiplexers reuse a pts number
    // hard, and the omp that had it before left a breadcrumb naming a log it
    // really did write. Existence is what tells the two apart.
    const dir = agentDir();
    const written = writeSession({
      sessionsRoot: sessionsIn(dir),
      cwd: project,
      id: OTHER_SID,
    });
    expect(read({ dir, breadcrumb: { file: written } })).toEqual(nothing);
  });

  it("refuses one with the fresh marker rewritten away", () => {
    // omp clears it once the log lands, so a missing marker beside a path
    // that does not exist is a session deleted or moved, not one starting.
    expect(read({ breadcrumb: { fresh: false } })).toEqual(nothing);
  });

  it("refuses one filed from another project", () => {
    expect(
      read({ breadcrumb: { cwd: scratchDir("todou-omp-elsewhere-") } }),
    ).toEqual(nothing);
  });

  it("refuses a file name that yields no session id", () => {
    // `--resume` opens the path it is handed, under any name at all, so the
    // id is only there to be read while omp chose the name itself.
    for (const file of [
      join(project, "sessions", "handed-to-resume.jsonl"),
      join(project, "sessions", `2026-09-12_${SID}.txt`),
      join(project, "sessions", "2026-09-12_../../etc.jsonl"),
    ]) {
      expect(read({ breadcrumb: { file } })).toEqual(nothing);
    }
  });

  it("reads no breadcrumb at all when omp's stdin is not a terminal", () => {
    // Without a tty omp names the terminal from ZELLIJ_PANE_ID and its like,
    // which need not have reached us and need not still say the same thing.
    expect(read({ breadcrumb: {}, stdin: "pipe:[918273]" })).toEqual(nothing);
    // And with no descriptor table to read at all, which is every platform
    // without /proc and every process that is not ours to look into.
    const dir = agentDir();
    breadcrumb(dir);
    expect(
      detectAgentContext(
        { ...ENV, PI_CODING_AGENT_DIR: dir },
        home,
        project,
        ompHost({ cwd: project }),
      ),
    ).toEqual(nothing);
  });

  it("never guesses at the terminal by listing the directory", () => {
    // It holds every terminal this user has ever had. Our own fd 0 is the
    // bash tool's pty or /dev/null, and it is not omp's.
    expect(read({ breadcrumb: { terminal: "pts-99" } })).toEqual(nothing);
  });

  /*
   * omp keeps sessions under the data directory and these under the state
   * one, so the two follow different XDG variables — and both stop following
   * XDG at the same point, which is a rule that exists once.
   */
  it("follows the XDG state directory, and only while omp's own is in place", () => {
    const xdg = scratchDir("todou-omp-state-");
    breadcrumb(join(xdg, "omp"));
    expect(
      detectAgentContext(
        { ...ENV, XDG_STATE_HOME: xdg },
        home,
        project,
        ompHost({ cwd: project, stdin: TTY }),
      ),
    ).toEqual({ agent: "omp", session_id: SID });
    // A relocated agent directory takes its state with it, exactly as it
    // takes its sessions.
    expect(
      detectAgentContext(
        { ...ENV, XDG_STATE_HOME: xdg, PI_CODING_AGENT_DIR: agentDir() },
        home,
        project,
        ompHost({ cwd: project, stdin: TTY }),
      ),
    ).toEqual(nothing);
  });
});
