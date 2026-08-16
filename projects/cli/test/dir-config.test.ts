import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverDirConfig } from "../src/dir-config.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "todou-cli-dirconfig-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;

/**
 * A hermetic corner: HOME sits inside the case directory, so every walk
 * ends at the HOME wall (dirs under it) or the ancestor-of-HOME wall
 * (siblings) and can never read files elsewhere on the machine.
 */
function setup() {
  const caseDir = join(base, `case-${counter++}`);
  const home = join(caseDir, "home");
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  return { caseDir, home, work, env: { HOME: home } };
}

function writeToml(dir: string, name: string, body = 'project = "todou"\n') {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe("discoverDirConfig file precedence", () => {
  it("prefers .config/todou.toml over .todou.toml in one directory", () => {
    const { work, env } = setup();
    writeToml(work, ".todou.toml", 'project = "plain"\n');
    const winner = writeToml(work, ".config/todou.toml", 'project = "cfg"\n');
    expect(discoverDirConfig(work, env)).toEqual({
      path: winner,
      project: "cfg",
      server: undefined,
    });
  });

  it("nearest directory wins regardless of file name", () => {
    const { work, env } = setup();
    writeToml(work, ".config/todou.toml", 'project = "far"\n');
    const near = join(work, "a");
    const winner = writeToml(near, ".todou.toml", 'project = "near"\n');
    const cwd = join(near, "b");
    mkdirSync(cwd);
    expect(discoverDirConfig(cwd, env)?.path).toBe(winner);
  });

  it("ignores unknown keys and normalizes the server", () => {
    const { work, env } = setup();
    writeToml(
      work,
      ".todou.toml",
      'project = "x"\nserver = "https://todou.example///"\nfuture = 1\n',
    );
    expect(discoverDirConfig(work, env)).toMatchObject({
      project: "x",
      server: "https://todou.example",
    });
  });
});

describe("discoverDirConfig walls", () => {
  it("never reads $HOME itself", () => {
    const { home, work, env } = setup();
    writeToml(home, ".todou.toml");
    writeToml(home, ".config/todou.toml");
    expect(discoverDirConfig(work, env)).toBeNull();
    expect(discoverDirConfig(home, env)).toBeNull();
  });

  it("never reads ancestors of $HOME", () => {
    const { caseDir, env } = setup();
    writeToml(caseDir, ".todou.toml");
    const outside = join(caseDir, "other", "x");
    mkdirSync(outside, { recursive: true });
    expect(discoverDirConfig(outside, env)).toBeNull();
    const control = writeToml(join(caseDir, "other"), ".todou.toml");
    expect(discoverDirConfig(outside, env)?.path).toBe(control);
  });

  it("never reads $XDG_CONFIG_HOME, while projects inside it still work", () => {
    const { home, env } = setup();
    writeToml(join(home, ".config"), "todou.toml", 'project = "oops"\n');
    const proj = join(home, ".config", "myproj");
    mkdirSync(proj, { recursive: true });
    expect(discoverDirConfig(proj, env)).toBeNull();
    const inner = writeToml(proj, ".todou.toml", 'project = "inner"\n');
    expect(discoverDirConfig(proj, env)?.path).toBe(inner);
  });

  it("ignores a relative XDG_CONFIG_HOME and keeps the default wall", () => {
    const { home, env } = setup();
    writeToml(join(home, ".config"), "todou.toml", 'project = "oops"\n');
    const proj = join(home, ".config", "myproj");
    mkdirSync(proj, { recursive: true });
    expect(
      discoverDirConfig(proj, { ...env, XDG_CONFIG_HOME: "rel/path" }),
    ).toBeNull();
  });

  it("survives a missing HOME by falling back to os.homedir()", () => {
    const dir = join(base, `case-${counter++}`);
    mkdirSync(dir, { recursive: true });
    const file = writeToml(dir, ".todou.toml");
    expect(discoverDirConfig(dir, {})?.path).toBe(file);
  });

  it("stops at filesystem boundaries via the dev seam", () => {
    const { work, env } = setup();
    writeToml(work, ".todou.toml");
    const sub = join(work, "sub");
    mkdirSync(sub);
    expect(
      discoverDirConfig(sub, env, { devOf: (p) => (p === sub ? 1 : 2) }),
    ).toBeNull();
    expect(discoverDirConfig(sub, env, { devOf: () => 1 })).not.toBeNull();
  });
});

describe("discoverDirConfig VCS boundaries", () => {
  function repoWithParentConfig(gitEntry?: { file?: string }) {
    const { work, env } = setup();
    writeToml(work, ".todou.toml", 'project = "parent"\n');
    const repo = join(work, "repo");
    mkdirSync(repo);
    if (gitEntry?.file !== undefined) {
      writeFileSync(join(repo, ".git"), gitEntry.file);
    } else {
      mkdirSync(join(repo, ".git"));
    }
    return { work, repo, env };
  }

  it("checks a repo root itself but stops there", () => {
    const { repo, env } = repoWithParentConfig();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    expect(discoverDirConfig(sub, env)).toBeNull();
    const own = writeToml(repo, ".todou.toml", 'project = "own"\n');
    expect(discoverDirConfig(sub, env)?.path).toBe(own);
  });

  it("walks through a submodule root into the superproject", () => {
    const { repo, env } = repoWithParentConfig({
      file: "gitdir: ../.git/modules/sub\n",
    });
    expect(discoverDirConfig(repo, env)?.project).toBe("parent");
  });

  it("stops at a linked worktree root", () => {
    const { repo, env } = repoWithParentConfig({
      file: "gitdir: /elsewhere/.git/worktrees/wt\n",
    });
    expect(discoverDirConfig(repo, env)).toBeNull();
  });

  it("stops when the .git file is unreadable gibberish", () => {
    const { repo, env } = repoWithParentConfig({ file: "not a pointer\n" });
    expect(discoverDirConfig(repo, env)).toBeNull();
  });

  it("stops at .hg and .svn roots", () => {
    for (const marker of [".hg", ".svn"]) {
      const { work, env } = setup();
      writeToml(work, ".todou.toml");
      const repo = join(work, "repo");
      mkdirSync(join(repo, marker), { recursive: true });
      expect(discoverDirConfig(repo, env)).toBeNull();
    }
  });
});

describe("discoverDirConfig bad files", () => {
  it("throws on unparsable TOML, naming the path", () => {
    const { work, env } = setup();
    const file = writeToml(work, ".todou.toml", 'project = "unclosed\n');
    expect(() => discoverDirConfig(work, env)).toThrow(file);
  });

  it("throws on credential keys instead of ignoring them", () => {
    const { work, env } = setup();
    writeToml(work, ".todou.toml", 'project = "x"\ntoken = "todou_pat_x"\n');
    expect(() => discoverDirConfig(work, env)).toThrow('contains "token"');
  });

  it("throws on a servers table", () => {
    const { work, env } = setup();
    writeToml(
      work,
      ".todou.toml",
      'project = "x"\n[servers."https://todou.example"]\ntoken = "t"\n',
    );
    expect(() => discoverDirConfig(work, env)).toThrow('contains "servers"');
  });

  it("throws when project is missing", () => {
    const { work, env } = setup();
    writeToml(work, ".todou.toml", 'server = "https://todou.example"\n');
    expect(() => discoverDirConfig(work, env)).toThrow('no "project" key');
  });

  it("does not walk past a broken file", () => {
    const { work, env } = setup();
    writeToml(work, ".todou.toml", 'project = "good"\n');
    const sub = join(work, "sub");
    writeToml(sub, ".todou.toml", "project = [broken\n");
    expect(() => discoverDirConfig(sub, env)).toThrow(/cannot parse/);
  });
});
