import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, type Route, runCli } from "./harness.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "todou-cli-cmdproj-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;

/** HOME inside the case directory keeps every discovery walk hermetic. */
function setup() {
  const caseDir = join(base, `case-${counter++}`);
  const home = join(caseDir, "home");
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  return { caseDir, home, work, xdg: join(caseDir, "xdg") };
}

function makeRepo(dir: string, remotes: Array<[string, string]> = []): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  for (const [name, url] of remotes) {
    execFileSync("git", ["-C", dir, "remote", "add", name, url]);
  }
}

const dogfood: Route = [
  "GET",
  "/api/projects/dogfood",
  { id: 1, slug: "dogfood", name: "Dogfood", description: "" },
];

function readToml(path: string): Record<string, unknown> {
  return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("project link → directory config", () => {
  it("writes .todou.toml with server and project when there is no remote", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readToml(join(work, ".todou.toml"))).toEqual({
      server: "http://stub.test",
      project: "dogfood",
    });
    expect(result.stderr).toContain(
      "linked ./.todou.toml → http://stub.test · dogfood",
    );
    expect(result.stderr).toContain("not auto-gitignored");
    expect(result.stderr).not.toContain("takes precedence");
    expect(result.stderr).not.toContain("never searched");
  });

  it("prefers .config/todou.toml when a .config directory exists", async () => {
    const { home, work } = setup();
    mkdirSync(join(work, ".config"));
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(work, ".config", "todou.toml"))).toBe(true);
    expect(result.stderr).toContain("linked ./.config/todou.toml");
  });

  it("writes back an existing .todou.toml instead of shadowing it", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "old"\n');
    mkdirSync(join(work, ".config"));
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(readToml(join(work, ".todou.toml")).project).toBe("dogfood");
    expect(existsSync(join(work, ".config", "todou.toml"))).toBe(false);
  });

  it("rewrites the whole file, dropping unknown keys", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "old"\nfuture = 1\n');
    const { fetchImpl } = fakeFetch([dogfood]);
    await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(readToml(join(work, ".todou.toml"))).toEqual({
      server: "http://stub.test",
      project: "dogfood",
    });
  });

  it("lands at the repository root when run in a subdirectory", async () => {
    const { home, work } = setup();
    const repo = join(work, "repo");
    makeRepo(repo);
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: sub,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(repo, ".todou.toml"))).toBe(true);
    expect(result.stderr).toContain("linked ../.todou.toml");
    expect(result.stderr).not.toContain("takes precedence");
  });

  it("warns when a nearer file shadows what it just wrote", async () => {
    const { home, work } = setup();
    const repo = join(work, "repo");
    makeRepo(repo);
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, ".todou.toml"), 'project = "near"\n');
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: sub,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "./.todou.toml is nearer and takes precedence here",
    );
  });

  it("keeps writing the global binding when a remote exists", async () => {
    const { home, work, xdg } = setup();
    const repo = join(work, "repo");
    makeRepo(repo, [["origin", "git@example.com:me/repo.git"]]);
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home, XDG_CONFIG_HOME: xdg },
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "linked git@example.com:me/repo.git → http://stub.test · dogfood",
    );
    expect(readToml(join(xdg, "todou", "config.toml")).bindings).toEqual([
      {
        remote: "git@example.com:me/repo.git",
        server: "http://stub.test",
        project: "dogfood",
      },
    ]);
    expect(existsSync(join(repo, ".todou.toml"))).toBe(false);
  });

  it("--local writes the file even when a remote exists", async () => {
    const { home, work, xdg } = setup();
    const repo = join(work, "repo");
    makeRepo(repo, [["origin", "git@example.com:me/repo.git"]]);
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood", "--local"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home, XDG_CONFIG_HOME: xdg },
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(repo, ".todou.toml"))).toBe(true);
    expect(existsSync(join(xdg, "todou", "config.toml"))).toBe(false);
  });

  it("--global without a remote is an error", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(["project", "link", "dogfood", "--global"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--global needs a git remote");
  });

  it("--local with --global is an error", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([dogfood]);
    const result = await runCli(
      ["project", "link", "dogfood", "--local", "--global"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("contradict each other");
  });

  it("does not write a file when the slug does not exist", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/nope",
        {
          __status: 404,
          body: { error: { code: "not_found", message: "no such project" } },
        },
      ],
    ]);
    const result = await runCli(["project", "link", "nope"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(work, ".todou.toml"))).toBe(false);
  });
});

describe("project unlink → directory config", () => {
  it("deletes the file at the target by existence", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), "project = [broken\n");
    const result = await runCli(["project", "unlink"], {
      env: { HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("unlinked ./.todou.toml");
    expect(existsSync(join(work, ".todou.toml"))).toBe(false);
  });

  it("deletes the .config variant first and notes the survivor", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "x"\n');
    mkdirSync(join(work, ".config"));
    writeFileSync(join(work, ".config", "todou.toml"), 'project = "y"\n');
    const result = await runCli(["project", "unlink"], {
      env: { HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("unlinked ./.config/todou.toml");
    expect(result.stderr).toContain("./.todou.toml remains");
    expect(existsSync(join(work, ".todou.toml"))).toBe(true);
  });

  it("points at a governing parent file instead of touching it", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "parent"\n');
    const sub = join(work, "sub");
    mkdirSync(sub);
    const result = await runCli(["project", "unlink"], {
      env: { HOME: home },
      cwd: sub,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("in effect here is ../.todou.toml");
    expect(existsSync(join(work, ".todou.toml"))).toBe(true);
  });

  it("reports what it checked when there is nothing to unlink", async () => {
    const { home, work } = setup();
    const result = await runCli(["project", "unlink"], {
      env: { HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to unlink here");
  });
});

describe("project edit", () => {
  const patched: Route = [
    "PATCH",
    "/api/projects/dogfood",
    (init: RequestInit) => ({
      id: 1,
      slug: "dogfood",
      ...JSON.parse(String(init.body)),
    }),
  ];
  const patchBody = (calls: Array<{ url: string; init: RequestInit }>) =>
    JSON.parse(String(calls.find((c) => c.init.method === "PATCH")?.init.body));

  it("sends both fields and prints the updated project", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([patched]);
    const result = await runCli(
      ["project", "edit", "dogfood", "--name", "Dogfood", "--description", "A"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(0);
    expect(patchBody(calls)).toEqual({ name: "Dogfood", description: "A" });
    expect(result.stdout).toContain("updated project dogfood — Dogfood");
  });

  it("omits the field that was not passed, and clears on --description ''", async () => {
    const { home, work } = setup();
    const named = fakeFetch([patched]);
    await runCli(["project", "edit", "dogfood", "--name", "Renamed"], {
      fetchImpl: named.fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(patchBody(named.calls)).toEqual({ name: "Renamed" });

    const cleared = fakeFetch([patched]);
    await runCli(["project", "edit", "dogfood", "--description", ""], {
      fetchImpl: cleared.fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(patchBody(cleared.calls)).toEqual({ description: "" });
  });

  it("refuses a no-op edit before making a request", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([patched]);
    const result = await runCli(["project", "edit", "dogfood"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("nothing to change");
    expect(calls).toEqual([]);
  });

  it("falls back to the directory config when the slug is omitted", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "dogfood"\n');
    const { fetchImpl, calls } = fakeFetch([patched]);
    const result = await runCli(["project", "edit", "--name", "Bound"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.url).toContain("/api/projects/dogfood");
    expect(patchBody(calls)).toEqual({ name: "Bound" });
  });

  it("rejects a positional that contradicts -p", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([patched]);
    const result = await runCli(
      ["project", "edit", "dogfood", "-p", "todou", "--name", "X"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("name different projects");
    expect(calls).toEqual([]);
  });

  it("--json prints the whole project", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([patched]);
    const result = await runCli(
      ["project", "edit", "dogfood", "--name", "Dogfood", "--json"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 1,
      slug: "dogfood",
      name: "Dogfood",
    });
  });
});

describe("project edit --slug (T-156)", () => {
  const renamed: Route = [
    "PATCH",
    "/api/projects/dogfood",
    (init: RequestInit) => ({
      id: 1,
      name: "Dogfood",
      ...JSON.parse(String(init.body)),
    }),
  ];
  const reserved: Route = [
    "PATCH",
    "/api/projects/dogfood",
    {
      __status: 409,
      body: {
        error: {
          code: "slug_reserved",
          message: 'slug "taken" still routes to the project that used it',
          details: { slug: "taken" },
        },
      },
    },
  ];
  const patchBody = (calls: Array<{ url: string; init: RequestInit }>) =>
    JSON.parse(String(calls.find((c) => c.init.method === "PATCH")?.init.body));

  it("renames and says what the old slug still does", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([renamed]);
    const result = await runCli(
      ["project", "edit", "dogfood", "--slug", "chowchow"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(0);
    expect(patchBody(calls)).toEqual({ slug: "chowchow" });
    expect(result.stdout).toContain("renamed dogfood → chowchow");
    expect(result.stdout).toContain("todou project link chowchow");
  });

  it("points at --reclaim when the slug is still reserved", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([reserved]);
    const result = await runCli(
      ["project", "edit", "dogfood", "--slug", "taken"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--reclaim");
    expect(patchBody(calls)).toEqual({ slug: "taken" });
  });

  it("sends reclaim when asked", async () => {
    const { home, work } = setup();
    const { fetchImpl, calls } = fakeFetch([renamed]);
    const result = await runCli(
      ["project", "edit", "dogfood", "--slug", "taken", "--reclaim"],
      { fetchImpl, env: { ...loggedInEnv(), HOME: home }, cwd: work },
    );
    expect(result.exitCode).toBe(0);
    expect(patchBody(calls)).toEqual({ slug: "taken", reclaim: true });
  });

  it("notes the canonical slug when a command reaches a project by an alias", async () => {
    const { home, work } = setup();
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/oldname",
        () =>
          new Response(
            JSON.stringify({
              id: 1,
              slug: "newname",
              name: "N",
              description: "",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-todou-canonical-slug": "newname",
              },
            },
          ),
      ],
    ]);
    const result = await runCli(["project", "link", "oldname", "--local"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('is now "newname"');
    // The binding written is the current spelling, not the one typed.
    expect(readToml(join(work, ".todou.toml")).project).toBe("newname");
  });
});

describe("whoami project source", () => {
  const me = {
    id: 2,
    login: "claude-agent",
    display_name: "Claude Agent",
    kind: "machine",
    owner: null,
  };

  it("names the directory config that supplied the project", async () => {
    const { home, work } = setup();
    writeFileSync(join(work, ".todou.toml"), 'project = "dogfood"\n');
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["whoami"], {
      fetchImpl,
      env: { ...loggedInEnv(), HOME: home },
      cwd: work,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "project: dogfood (directory config ./.todou.toml)",
    );
  });

  it("names TODOU_PROJECT and git bindings too", async () => {
    const { home, work, xdg } = setup();
    const envResult = await runCli(["whoami"], {
      fetchImpl: fakeFetch([["GET", "/api/me", me]]).fetchImpl,
      env: { ...loggedInEnv("todou"), HOME: home },
      cwd: work,
    });
    expect(envResult.stderr).toContain("project: todou (TODOU_PROJECT)");

    const repo = join(work, "repo");
    makeRepo(repo, [["origin", "git@example.com:me/repo.git"]]);
    mkdirSync(join(xdg, "todou"), { recursive: true });
    writeFileSync(
      join(xdg, "todou", "config.toml"),
      [
        "[[bindings]]",
        'remote = "git@example.com:me/repo.git"',
        'server = "http://stub.test"',
        'project = "todou"',
      ].join("\n"),
    );
    const boundResult = await runCli(["whoami"], {
      fetchImpl: fakeFetch([["GET", "/api/me", me]]).fetchImpl,
      env: { ...loggedInEnv(), HOME: home, XDG_CONFIG_HOME: xdg },
      cwd: repo,
    });
    expect(boundResult.stderr).toContain(
      "project: todou (git binding git@example.com:me/repo.git)",
    );
  });
});
