import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliConfig } from "../src/config.ts";
import { gitRemoteUrl, resolveContext } from "../src/context.ts";

const dir = mkdtempSync(join(tmpdir(), "todou-cli-context-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeRepo(name: string, remotes: Array<[string, string]>): string {
  const repo = join(dir, name);
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  for (const [remoteName, url] of remotes) {
    execFileSync("git", ["-C", repo, "remote", "add", remoteName, url]);
  }
  return repo;
}

describe("gitRemoteUrl", () => {
  it("prefers origin", () => {
    const repo = makeRepo("origin-repo", [
      ["upstream", "git@example.com:up/stream.git"],
      ["origin", "git@example.com:me/repo.git"],
    ]);
    expect(gitRemoteUrl(repo)).toBe("git@example.com:me/repo.git");
  });

  it("uses the sole remote when origin is absent", () => {
    const repo = makeRepo("sole-repo", [
      ["fork", "git@example.com:me/fork.git"],
    ]);
    expect(gitRemoteUrl(repo)).toBe("git@example.com:me/fork.git");
  });

  it("returns null for several remotes without origin", () => {
    const repo = makeRepo("multi-repo", [
      ["a", "git@example.com:a/a.git"],
      ["b", "git@example.com:b/b.git"],
    ]);
    expect(gitRemoteUrl(repo)).toBeNull();
  });

  it("returns null without remotes or outside a repository", () => {
    expect(gitRemoteUrl(makeRepo("bare-repo", []))).toBeNull();
    const plain = join(dir, "not-a-repo");
    mkdirSync(plain);
    expect(gitRemoteUrl(plain)).toBeNull();
  });
});

const config: CliConfig = {
  default_server: "https://fallback.example",
  servers: {
    "https://todou.example": { token: "todou_pat_bound", tokens: {} },
    "https://fallback.example": { token: "todou_pat_fallback", tokens: {} },
  },
  bindings: [
    {
      remote: "git@example.com:me/repo.git",
      server: "https://todou.example",
      project: "todou",
    },
  ],
};

describe("resolveContext", () => {
  it("binding supplies server, token, and project", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
    });
    expect(ctx).toEqual({
      server: "https://todou.example",
      token: "todou_pat_bound",
      tokenSource: "default",
      project: "todou",
      binding: config.bindings[0],
      remoteUrl: "git@example.com:me/repo.git",
    });
  });

  it("flags beat env, env beats binding", () => {
    const ctx = resolveContext({
      flags: { server: "https://flag.example/", project: "flagged" },
      env: {
        TODOU_SERVER: "https://env.example",
        TODOU_PROJECT: "enved",
        TODOU_TOKEN: "todou_pat_env",
      },
      config,
      remoteUrl: "git@example.com:me/repo.git",
    });
    expect(ctx.server).toBe("https://flag.example");
    expect(ctx.project).toBe("flagged");
    expect(ctx.token).toBe("todou_pat_env");
  });

  it("bound project does not leak onto a different server", () => {
    const ctx = resolveContext({
      flags: { server: "https://fallback.example" },
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
    });
    expect(ctx.project).toBeUndefined();
    expect(ctx.token).toBe("todou_pat_fallback");
  });

  it("falls back to default_server with its token", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: null,
    });
    expect(ctx.server).toBe("https://fallback.example");
    expect(ctx.token).toBe("todou_pat_fallback");
    expect(ctx.project).toBeUndefined();
  });

  it("yields nothing when unconfigured", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config: { servers: {}, bindings: [] },
      remoteUrl: null,
    });
    expect(ctx.server).toBeUndefined();
    expect(ctx.token).toBeUndefined();
  });
});
