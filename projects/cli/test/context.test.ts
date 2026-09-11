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
    "https://todou.example": {
      token: "todou_pat_bound",
      tokens: {},
      instead_of: [],
    },
    "https://fallback.example": {
      token: "todou_pat_fallback",
      tokens: {},
      instead_of: [],
    },
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
      dirConfig: null,
    });
    expect(ctx).toEqual({
      server: "https://todou.example",
      serverSource: "binding",
      token: "todou_pat_bound",
      tokenSource: "default",
      project: "todou",
      projectSource: "binding",
      binding: config.bindings[0],
      dirConfig: null,
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
      dirConfig: null,
    });
    expect(ctx.server).toBe("https://flag.example");
    expect(ctx.project).toBe("flagged");
    expect(ctx.projectSource).toBe("flag");
    expect(ctx.token).toBe("todou_pat_env");
  });

  it("bound project does not leak onto a different server", () => {
    const ctx = resolveContext({
      flags: { server: "https://fallback.example" },
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
      dirConfig: null,
    });
    expect(ctx.project).toBeUndefined();
    expect(ctx.projectSource).toBeNull();
    expect(ctx.token).toBe("todou_pat_fallback");
  });

  it("falls back to default_server with its token", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: null,
      dirConfig: null,
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
      dirConfig: null,
    });
    expect(ctx.server).toBeUndefined();
    expect(ctx.token).toBeUndefined();
    expect(ctx.serverSource).toBeNull();
  });
});

describe("serverSource", () => {
  const source = (input: {
    flags?: { server?: string };
    env?: Record<string, string>;
    remoteUrl?: string | null;
    dirConfig?: { path: string; project: string; server?: string } | null;
  }) =>
    resolveContext({
      flags: input.flags ?? {},
      env: input.env ?? {},
      config,
      remoteUrl: input.remoteUrl ?? null,
      dirConfig: input.dirConfig ?? null,
    }).serverSource;

  const remote = "git@example.com:me/repo.git";

  it("names each step of the chain that won", () => {
    expect(source({ flags: { server: "https://flag.example" } })).toBe("flag");
    expect(source({ env: { TODOU_SERVER: "https://env.example" } })).toBe(
      "env",
    );
    expect(
      source({
        dirConfig: {
          path: "/work/scratch/.todou.toml",
          project: "dirproj",
          server: "https://todou.example",
        },
      }),
    ).toBe("dir-config");
    expect(source({ remoteUrl: remote })).toBe("binding");
    expect(source({})).toBe("default_server");
  });

  it("says default_server for a directory config with no server key", () => {
    // The file replaces the binding outright, so the binding is not the
    // source even though it exists and matched this remote.
    expect(
      source({
        remoteUrl: remote,
        dirConfig: { path: "/work/scratch/.todou.toml", project: "dirproj" },
      }),
    ).toBe("default_server");
  });

  it("never says binding without a binding to point at", () => {
    // "binding" is what the human output turns into `git binding <remote>`,
    // so it may only appear when there is a remote that matched one.
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: "git@example.com:me/unbound.git",
      dirConfig: null,
    });
    expect(ctx.binding).toBeNull();
    expect(ctx.serverSource).toBe("default_server");
  });
});

describe("resolveContext through an alias (T-311)", () => {
  /** The deployment answers at the public address; the CLI reaches the proxy. */
  const aliased: CliConfig = {
    default_server: "https://todou.example",
    servers: {
      "http://gateway.test/todou": {
        token: "todou_pat_proxy",
        tokens: {},
        instead_of: ["https://todou.example"],
      },
      "https://elsewhere.test": { tokens: {}, instead_of: [] },
    },
    bindings: [],
  };

  const resolve = (over: {
    flags?: { server?: string };
    env?: Record<string, string>;
    remoteUrl?: string | null;
    dirConfig?: { path: string; project: string; server?: string } | null;
    config?: CliConfig;
  }) =>
    resolveContext({
      flags: over.flags ?? {},
      env: over.env ?? {},
      config: over.config ?? aliased,
      remoteUrl: over.remoteUrl ?? null,
      dirConfig: over.dirConfig ?? null,
    });

  it("resolves --server <alias> to the real base and names the alias", () => {
    const ctx = resolve({ flags: { server: "https://todou.example" } });
    expect(ctx.server).toBe("http://gateway.test/todou");
    expect(ctx.serverSource).toBe("flag");
    expect(ctx.serverInsteadOf).toBe("https://todou.example");
  });

  it("does the same for TODOU_SERVER", () => {
    const ctx = resolve({ env: { TODOU_SERVER: "https://todou.example" } });
    expect(ctx.server).toBe("http://gateway.test/todou");
    expect(ctx.serverSource).toBe("env");
    expect(ctx.serverInsteadOf).toBe("https://todou.example");
  });

  it("does the same for default_server", () => {
    const ctx = resolve({});
    expect(ctx.server).toBe("http://gateway.test/todou");
    expect(ctx.serverSource).toBe("default_server");
    expect(ctx.serverInsteadOf).toBe("https://todou.example");
  });

  it("does the same for a directory config", () => {
    const ctx = resolve({
      dirConfig: {
        path: "/work/scratch/.todou.toml",
        project: "dirproj",
        server: "https://todou.example",
      },
    });
    expect(ctx.server).toBe("http://gateway.test/todou");
    expect(ctx.serverSource).toBe("dir-config");
    expect(ctx.serverInsteadOf).toBe("https://todou.example");
  });

  it("does the same for a binding", () => {
    const config: CliConfig = {
      ...aliased,
      bindings: [
        {
          remote: "git@example.com:me/repo.git",
          server: "https://todou.example",
          project: "todou",
        },
      ],
    };
    const ctx = resolve({
      config,
      remoteUrl: "git@example.com:me/repo.git",
    });
    expect(ctx.server).toBe("http://gateway.test/todou");
    expect(ctx.serverSource).toBe("binding");
    expect(ctx.serverInsteadOf).toBe("https://todou.example");
  });

  it("picks the token stored on the entry the alias names", () => {
    // The whole reason the rewrite runs before the chain picks: the entry
    // holding the token is keyed by the base, not by the alias.
    const ctx = resolve({ flags: { server: "https://todou.example" } });
    expect(ctx.token).toBe("todou_pat_proxy");
    expect(ctx.tokenSource).toBe("default");
  });

  it("keeps a directory config's project when its server is an alias", () => {
    // Today the project is dropped here, because the file says the public
    // address and the active base is the proxy's — one deployment, two
    // spellings, and a `.todou.toml` committed to a repo naming the public
    // one had its `project` silently ignored.
    const ctx = resolve({
      flags: { server: "https://todou.example" },
      dirConfig: {
        path: "/work/scratch/.todou.toml",
        project: "dirproj",
        server: "https://todou.example",
      },
    });
    expect(ctx.project).toBe("dirproj");
    expect(ctx.projectSource).toBe("dir-config");
  });

  it("keeps a binding's project when its server is an alias", () => {
    const config: CliConfig = {
      ...aliased,
      bindings: [
        {
          remote: "git@example.com:me/repo.git",
          server: "https://todou.example",
          project: "todou",
        },
      ],
    };
    const ctx = resolve({
      flags: { server: "https://todou.example" },
      config,
      remoteUrl: "git@example.com:me/repo.git",
    });
    expect(ctx.project).toBe("todou");
    expect(ctx.projectSource).toBe("binding");
  });

  it("still drops a local project pinned elsewhere", () => {
    const ctx = resolve({
      flags: { server: "https://elsewhere.test" },
      dirConfig: {
        path: "/work/scratch/.todou.toml",
        project: "dirproj",
        server: "https://todou.example",
      },
    });
    expect(ctx.project).toBeUndefined();
    expect(ctx.projectSource).toBeNull();
  });

  it("changes nothing when no entry has instead_of", () => {
    const ctx = resolve({ flags: { server: "https://elsewhere.test" } });
    expect(ctx.server).toBe("https://elsewhere.test");
    expect(ctx.serverInsteadOf).toBeUndefined();
    expect(ctx.token).toBeUndefined();
  });
});

describe("resolveContext with a directory config", () => {
  const dirConfig = {
    path: "/work/scratch/.todou.toml",
    project: "dirproj",
    server: "https://todou.example",
  };

  it("beats the binding for both server and project", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
      dirConfig,
    });
    expect(ctx.server).toBe("https://todou.example");
    expect(ctx.project).toBe("dirproj");
    expect(ctx.projectSource).toBe("dir-config");
  });

  it("replaces the binding outright: no server key means default_server", () => {
    const ctx = resolveContext({
      flags: {},
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
      dirConfig: { path: "/work/scratch/.todou.toml", project: "dirproj" },
    });
    expect(ctx.server).toBe("https://fallback.example");
    expect(ctx.token).toBe("todou_pat_fallback");
    expect(ctx.project).toBe("dirproj");
    expect(ctx.projectSource).toBe("dir-config");
  });

  it("is beaten by TODOU_PROJECT", () => {
    const ctx = resolveContext({
      flags: {},
      env: { TODOU_PROJECT: "enved" },
      config,
      remoteUrl: null,
      dirConfig,
    });
    expect(ctx.project).toBe("enved");
    expect(ctx.projectSource).toBe("env");
  });

  it("does not leak its project onto a different server", () => {
    const ctx = resolveContext({
      flags: { server: "https://fallback.example" },
      env: {},
      config,
      remoteUrl: "git@example.com:me/repo.git",
      dirConfig,
    });
    expect(ctx.project).toBeUndefined();
    expect(ctx.projectSource).toBeNull();
  });

  it("floats a server-less project onto the active server", () => {
    const ctx = resolveContext({
      flags: { server: "https://todou.example" },
      env: {},
      config,
      remoteUrl: null,
      dirConfig: { path: "/work/scratch/.todou.toml", project: "dirproj" },
    });
    expect(ctx.project).toBe("dirproj");
    expect(ctx.projectSource).toBe("dir-config");
  });
});
