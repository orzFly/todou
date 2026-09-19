import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { integration } from "../../src/integrations/registry.ts";
import { runCli } from "../harness.ts";

/**
 * The version the registry carries now, read rather than written out. A bump is
 * a real event — it is the whole of how an installed extension is told it is
 * stale — and a literal in each assertion below would turn every one into a
 * sweep through cases that are not about the version at all.
 */
const V = integration("omp")?.version;

// Fail during collection if Pi disappears from the registry; never skip its cases.
const piIntegration = integration("pi");
expect(piIntegration, "Pi must be registered").toBeDefined();
expect(piIntegration?.version).toBe(1);

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function fresh(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** The file the omp integration takes, under a given agent directory. */
const target = (agentDir: string) =>
  join(agentDir, "extensions", "todou-omp-session.ts");
const piTarget = (agentDir: string) =>
  join(agentDir, "extensions", "todou-pi-session.ts");

/**
 * A home with `~/.omp/agent` already in it, which is the "omp lives here"
 * signal `install-all` looks for.
 */
function ompHome(): string {
  const home = fresh("todou-integ-home-");
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  return home;
}

const run = (argv: string[], home: string, env: Record<string, string> = {}) =>
  runCli(argv, { home, env: { HOME: home, ...env } });

describe("todou integration install", () => {
  /*
   * The four ways omp's agent directory moves. Each is a way to install into
   * a directory omp never reads — successfully, and with nothing to show for
   * it — so each gets its own case rather than a shared helper's confidence.
   */
  it("writes into the default agent directory", async () => {
    const home = ompHome();
    const result = await run(["integration", "install", "omp"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`install v${V}`);
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(true);
  });

  it("follows PI_CODING_AGENT_DIR", async () => {
    const home = ompHome();
    const dir = fresh("todou-integ-agent-");
    const result = await run(["integration", "install", "omp"], home, {
      PI_CODING_AGENT_DIR: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(target(dir))).toBe(true);
    // And not into the default, which is what "follows" has to mean.
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(false);
  });

  it("follows a profile", async () => {
    const home = ompHome();
    const result = await run(["integration", "install", "omp"], home, {
      OMP_PROFILE: "work",
    });
    expect(result.exitCode).toBe(0);
    expect(
      existsSync(target(join(home, ".omp", "profiles", "work", "agent"))),
    ).toBe(true);
  });

  it("follows PI_CONFIG_DIR", async () => {
    const home = ompHome();
    const result = await run(["integration", "install", "omp"], home, {
      PI_CONFIG_DIR: ".omp-alt",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(target(join(home, ".omp-alt", "agent")))).toBe(true);
  });

  /*
   * The two combinations where the variables disagree with each other. Inside
   * omp they cannot: omp normalises its own environment before its tools see
   * it. In the shell this command is typed into, nothing has normalised
   * anything, so these are the cases that decide whether the file lands where
   * omp will read it. Both were measured against omp 18.1.15.
   */
  it("lets a profile overrule PI_CODING_AGENT_DIR", async () => {
    const home = ompHome();
    const dir = fresh("todou-integ-ignored-");
    const result = await run(["integration", "install", "omp"], home, {
      OMP_PROFILE: "work",
      PI_CODING_AGENT_DIR: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(
      existsSync(target(join(home, ".omp", "profiles", "work", "agent"))),
    ).toBe(true);
    // omp does not merely prefer the profile here, it discards the override —
    // it never even creates this directory.
    expect(existsSync(target(dir))).toBe(false);
  });

  it("does not fall through an empty OMP_PROFILE to PI_PROFILE", async () => {
    const home = ompHome();
    const result = await run(["integration", "install", "omp"], home, {
      OMP_PROFILE: "",
      PI_PROFILE: "work",
    });
    expect(result.exitCode).toBe(0);
    // A bound-but-empty OMP_PROFILE shadows PI_PROFILE and then fails omp's
    // own name check, which leaves omp with no profile and its sessions in
    // the default agent directory.
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(true);
    expect(
      existsSync(target(join(home, ".omp", "profiles", "work", "agent"))),
    ).toBe(false);
  });

  it("writes a file that names itself as ours", async () => {
    const home = ompHome();
    await run(["integration", "install", "omp"], home);
    const text = readFileSync(target(join(home, ".omp", "agent")), "utf8");
    expect(text).toContain("// installed by todou");
    // The marker the overwrite check reads, and the version `status` reports.
    expect(text).toContain("// TODOU_INTEGRATION_ID=omp");
    expect(text).toContain(`// TODOU_INTEGRATION_VERSION=${V}`);
    // And the extension itself, not just a header.
    expect(text).toContain("TODOU_OMP_STATE");
    expect(text).toContain("export default function todou");
  });

  it("replaces its own file", async () => {
    const home = ompHome();
    const path = target(join(home, ".omp", "agent"));
    await run(["integration", "install", "omp"], home);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// edited by hand\n`);
    const result = await run(["integration", "install", "omp"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`reinstall v${V}`);
    expect(readFileSync(path, "utf8")).not.toContain("edited by hand");
  });

  it("refuses a file it did not write, and says so", async () => {
    // The case that costs work when it goes wrong: an extensions directory is
    // where people keep their own files, and a deleted one is not recoverable
    // from here.
    const home = ompHome();
    const path = target(join(home, ".omp", "agent"));
    mkdirSync(join(home, ".omp", "agent", "extensions"), { recursive: true });
    writeFileSync(path, "export default function mine() {}\n");
    const result = await run(["integration", "install", "omp"], home);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("refused");
    expect(readFileSync(path, "utf8")).toBe(
      "export default function mine() {}\n",
    );
  });

  it("refuses an agent it has never heard of, before writing anything", async () => {
    const home = ompHome();
    const result = await run(["integration", "install", "omp", "nope"], home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown integration "nope"');
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(false);
  });

  it("writes nothing under --dry-run", async () => {
    // The assertion is the absence of a write, so it is made against a home
    // of this test's own: a recursive listing before and after, which catches
    // a stray directory as well as the file itself.
    const home = ompHome();
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(
      ["integration", "install", "omp", "--dry-run"],
      home,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`would install v${V}`);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });

  it("says what a --dry-run would replace", async () => {
    const home = ompHome();
    await run(["integration", "install", "omp"], home);
    const result = await run(
      ["integration", "install", "omp", "--dry-run"],
      home,
    );
    expect(result.stdout).toContain(`would reinstall v${V}`);
  });
});

describe("todou integration uninstall", () => {
  it("removes its own file", async () => {
    const home = ompHome();
    const path = target(join(home, ".omp", "agent"));
    await run(["integration", "install", "omp"], home);
    const result = await run(["integration", "uninstall", "omp"], home);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("leaves a file it did not write, and fails", async () => {
    const home = ompHome();
    const path = target(join(home, ".omp", "agent"));
    mkdirSync(join(home, ".omp", "agent", "extensions"), { recursive: true });
    writeFileSync(path, "export default function mine() {}\n");
    const result = await run(["integration", "uninstall", "omp"], home);
    expect(result.exitCode).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it("is content when there is nothing to remove", async () => {
    const home = ompHome();
    const result = await run(["integration", "uninstall", "omp"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nothing at");
  });
});

describe("todou integration status", () => {
  it("reports every integration when none is named", async () => {
    const home = ompHome();
    const result = await run(["integration", "status"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("omp: not installed");
    expect(result.stdout).toContain("pi: not installed");
    await run(["integration", "install", "omp"], home);
    expect((await run(["integration", "status"], home)).stdout).toContain(
      `omp: installed v${V}`,
    );
  });

  it("names a stale version rather than calling it installed", async () => {
    const home = ompHome();
    const path = target(join(home, ".omp", "agent"));
    await run(["integration", "install", "omp"], home);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        `TODOU_INTEGRATION_VERSION=${V}`,
        "TODOU_INTEGRATION_VERSION=0",
      ),
    );
    const result = await run(["integration", "status"], home);
    expect(result.stdout).toContain(
      `installed v0, current is v${V} — reinstall`,
    );
  });

  it("says when the agent leaves no sign of itself here", async () => {
    const home = fresh("todou-integ-bare-");
    const result = await run(["integration", "status"], home);
    expect(result.stdout).toContain("no sign of this agent on this machine");
  });
});

describe("todou integration install-all", () => {
  /**
   * The predicate this uses is the filesystem, never `Harness.matches`: it is
   * typed into an ordinary shell, where no agent marker is in the environment
   * at all. A version keyed on the environment would install nothing here and
   * report that nothing is installed — true-sounding, and wrong.
   */
  it("installs into an agent the environment says nothing about", async () => {
    const home = ompHome();
    const result = await run(["integration", "install-all"], home);
    expect(result.exitCode).toBe(0);
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(true);
  });

  it("finding nothing is success", async () => {
    const home = fresh("todou-integ-bare-");
    const result = await run(["integration", "install-all"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("no agent found on this machine\n");
    expect(readdirSync(home)).toEqual([]);
  });

  it("undoes itself with uninstall-all", async () => {
    const home = ompHome();
    await run(["integration", "install-all"], home);
    const result = await run(["integration", "uninstall-all"], home);
    expect(result.exitCode).toBe(0);
    expect(existsSync(target(join(home, ".omp", "agent")))).toBe(false);
  });
});

describe("todou integration install pi", () => {
  it("writes the native Pi asset and ownership marker at the default path", async () => {
    const home = fresh("todou-integ-pi-");
    const result = await run(["integration", "install", "pi"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: install v1");
    const text = readFileSync(piTarget(join(home, ".pi", "agent")), "utf8");
    expect(text).toContain("// TODOU_INTEGRATION_ID=pi");
    expect(text).toContain("// TODOU_INTEGRATION_VERSION=1");
    expect(text).toContain("TODOU_PI_STATE");
    expect(text).toContain("TODOU_PI_TOOLS");
    expect(text).not.toContain("// TODOU_INTEGRATION_ID=omp");
    expect(existsSync(join(home, ".omp"))).toBe(false);
  });

  it("follows a custom agent directory despite omp profile and config variables", async () => {
    const home = fresh("todou-integ-pi-");
    const dir = join(home, "custom", "agent");
    const result = await run(["integration", "install", "pi"], home, {
      PI_CODING_AGENT_DIR: dir,
      OMP_PROFILE: "work",
      PI_PROFILE: "other",
      PI_CONFIG_DIR: ".omp-alt",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(piTarget(dir))).toBe(true);
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(existsSync(join(home, ".omp"))).toBe(false);
    expect(existsSync(join(home, ".omp-alt"))).toBe(false);
  });

  it.each([
    ["~/custom-agent", "custom-agent"],
    ["~", ""],
    ["", ".pi/agent"],
  ])("resolves PI_CODING_AGENT_DIR=%j", async (override, relative) => {
    const home = fresh("todou-integ-pi-");
    const result = await run(["integration", "install", "pi"], home, {
      PI_CODING_AGENT_DIR: override,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(piTarget(join(home, relative)))).toBe(true);
    if (relative !== ".pi/agent") {
      expect(existsSync(join(home, ".pi"))).toBe(false);
    }
  });

  it("rejects unknown agents before installing Pi and lists Pi as known", async () => {
    const home = fresh("todou-integ-pi-");
    const result = await run(["integration", "install", "pi", "nope"], home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown integration "nope"');
    expect(result.stderr).toContain("known: omp, pi");
    expect(readdirSync(home)).toEqual([]);
  });

  it("does not create even directories during a dry run", async () => {
    const home = fresh("todou-integ-pi-");
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(
      ["integration", "install", "pi", "--dry-run"],
      home,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: would install v1");
    expect(result.stdout).toContain(
      "~/.pi/agent/extensions/todou-pi-session.ts",
    );
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });

  it("leaves an edited owned file untouched during a dry reinstall", async () => {
    const home = fresh("todou-integ-pi-");
    expect((await run(["integration", "install", "pi"], home)).exitCode).toBe(
      0,
    );
    const path = piTarget(join(home, ".pi", "agent"));
    const text = `${readFileSync(path, "utf8")}\n// edited by hand\n`;
    writeFileSync(path, text);
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(
      ["integration", "install", "pi", "--dry-run"],
      home,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: would reinstall v1");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });
});

describe("todou integration install-all with Pi", () => {
  // run() injects HOME only; no active-agent marker or process ancestry.
  it.each(["pi", "omp", "both"])(
    "detects %s independently from config roots alone in an ordinary shell",
    async (agent) => {
      const home = fresh("todou-integ-pi-");
      if (agent !== "omp") mkdirSync(join(home, ".pi"));
      if (agent !== "pi") mkdirSync(join(home, ".omp"));
      expect(existsSync(join(home, ".pi", "agent"))).toBe(false);
      expect(existsSync(join(home, ".omp", "agent"))).toBe(false);
      const result = await run(["integration", "install-all"], home);
      expect(result.exitCode).toBe(0);
      expect(existsSync(piTarget(join(home, ".pi", "agent")))).toBe(
        agent !== "omp",
      );
      expect(existsSync(target(join(home, ".omp", "agent")))).toBe(
        agent !== "pi",
      );
      if (agent !== "omp") expect(result.stdout).toContain("pi: install v1");
      else expect(result.stdout).not.toContain("pi:");
      if (agent !== "pi") expect(result.stdout).toContain(`omp: install v${V}`);
      else expect(result.stdout).not.toContain("omp:");
    },
  );

  it("finds an existing custom Pi directory without a default config root", async () => {
    const home = fresh("todou-integ-pi-");
    const dir = join(home, "custom-agent");
    mkdirSync(dir);
    const result = await run(["integration", "install-all"], home, {
      PI_CODING_AGENT_DIR: dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: install v1");
    expect(existsSync(piTarget(dir))).toBe(true);
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  it("reports both roots in a dry run without creating agent directories", async () => {
    const home = fresh("todou-integ-pi-");
    mkdirSync(join(home, ".pi"));
    mkdirSync(join(home, ".omp"));
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(["integration", "install-all", "--dry-run"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: would install v1");
    expect(result.stdout).toContain(`omp: would install v${V}`);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });
});

describe("todou integration uninstall pi", () => {
  it("removes its owned file and preserves neighboring user extensions", async () => {
    const home = fresh("todou-integ-pi-");
    expect((await run(["integration", "install", "pi"], home)).exitCode).toBe(
      0,
    );
    const dir = join(home, ".pi", "agent");
    const neighbor = join(dir, "extensions", "mine.ts");
    const userText = "export default function mine() {}\n";
    writeFileSync(neighbor, userText);
    const result = await run(["integration", "uninstall", "pi"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: removed");
    expect(existsSync(piTarget(dir))).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe(userText);
  });

  it.each([
    ["unowned", "export default function mine() {}\n"],
    [
      "omp-marked",
      "// TODOU_INTEGRATION_ID=omp\n// TODOU_INTEGRATION_VERSION=5\n",
    ],
  ])("refuses to remove or overwrite an %s file", async (_kind, text) => {
    const home = fresh("todou-integ-pi-");
    const dir = join(home, ".pi", "agent");
    mkdirSync(join(dir, "extensions"), { recursive: true });
    const path = piTarget(dir);
    writeFileSync(path, text);
    const before = readdirSync(home, { recursive: true }).sort();
    for (const action of ["uninstall", "install"]) {
      const result = await run(["integration", action, "pi"], home);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("pi: refused");
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    const status = await run(["integration", "status", "pi"], home);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("pi: a file todou did not write");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });

  it("preserves the owned file during a dry uninstall", async () => {
    const home = fresh("todou-integ-pi-");
    expect((await run(["integration", "install", "pi"], home)).exitCode).toBe(
      0,
    );
    const path = piTarget(join(home, ".pi", "agent"));
    const text = readFileSync(path, "utf8");
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(
      ["integration", "uninstall", "pi", "--dry-run"],
      home,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: would remove");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });
});

describe("todou integration status pi", () => {
  it("reports missing Pi without creating a directory", async () => {
    const home = fresh("todou-integ-pi-");
    const result = await run(["integration", "status", "pi"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: not installed");
    expect(result.stdout).toContain(
      "~/.pi/agent/extensions/todou-pi-session.ts",
    );
    expect(result.stdout).toContain("no sign of this agent on this machine");
    expect(readdirSync(home)).toEqual([]);
  });

  it("recognizes a root-only trace without creating an agent directory", async () => {
    const home = fresh("todou-integ-pi-");
    mkdirSync(join(home, ".pi"));
    const before = readdirSync(home, { recursive: true }).sort();
    const result = await run(["integration", "status", "pi"], home);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pi: not installed");
    expect(result.stdout).not.toContain("no sign of this agent");
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });

  it("reports installed and stale versions at the custom destination without changing them", async () => {
    const home = fresh("todou-integ-pi-");
    const dir = join(home, "custom-agent");
    const env = { PI_CODING_AGENT_DIR: "~/custom-agent" };
    expect(
      (await run(["integration", "install", "pi"], home, env)).exitCode,
    ).toBe(0);
    const path = piTarget(dir);
    const text = readFileSync(path, "utf8");
    const before = readdirSync(home, { recursive: true }).sort();
    const installed = await run(["integration", "status", "pi"], home, env);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("pi: installed v1");
    expect(installed.stdout).toContain(
      "~/custom-agent/extensions/todou-pi-session.ts",
    );
    expect(readFileSync(path, "utf8")).toBe(text);
    const stale = text.replace(
      "TODOU_INTEGRATION_VERSION=1",
      "TODOU_INTEGRATION_VERSION=0",
    );
    writeFileSync(path, stale);
    const result = await run(["integration", "status", "pi"], home, env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "pi: installed v0, current is v1 — reinstall",
    );
    expect(readFileSync(path, "utf8")).toBe(stale);
    expect(readdirSync(home, { recursive: true }).sort()).toEqual(before);
  });
});
