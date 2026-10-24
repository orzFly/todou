import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpgradeSeam } from "../src/commands/upgrade.ts";
import type { InstallForm } from "../src/upgrade/install-form.ts";
import { GITHUB_REPO } from "../src/upgrade/sources.ts";
import { runCli } from "./harness.ts";

const ART = "todou-linux-amd64";
const SRV = "http://srv.test";

/** A "build" is a file whose content names its version; the smoke reads it back. */
const build = (version: string) => Buffer.from(`build ${version}\n`);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Reply = Response | (() => Response);

/**
 * Keyed by the full URL, unlike the shared fakeFetch: GitHub and the server
 * are two hosts here, and which one a download came from is the assertion.
 */
function web(routes: Record<string, Reply | "down">) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined || route === "down") {
      throw new TypeError("fetch failed", {
        cause: { code: route === "down" ? "ECONNREFUSED" : `no route ${url}` },
      });
    }
    return typeof route === "function" ? route() : route.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function github(version: string, bytes: Buffer, sums = sha(bytes)) {
  const base = `${GITHUB_REPO}/releases/download/${version}`;
  return {
    [`${GITHUB_REPO}/releases/latest`]: () =>
      new Response(null, {
        status: 302,
        headers: { location: `${GITHUB_REPO}/releases/tag/${version}` },
      }),
    [`${base}/SHA256SUMS`]: () =>
      new Response(`${sums}  ${ART}\n${"c".repeat(64)}  todou.cjs\n`),
    [`${base}/${ART}`]: () => new Response(bytes),
  };
}

function server(version: string, bytes: Buffer, declared = sha(bytes)) {
  return {
    [`${SRV}/api/cli`]: () =>
      Response.json({
        version,
        artifacts: [
          {
            name: ART,
            os: "linux",
            arch: "amd64",
            kind: "binary",
            size: bytes.length,
            sha256: declared,
            url: `/api/cli/${ART}`,
          },
        ],
      }),
    [`${SRV}/api/cli/${ART}`]: () => new Response(bytes),
  };
}

const GITHUB_DOWN = { [`${GITHUB_REPO}/releases/latest`]: "down" as const };
const NO_CLI = {
  [`${SRV}/api/cli`]: () =>
    Response.json(
      { error: { code: "cli_dist_not_configured" } },
      { status: 404 },
    ),
};

let dir: string;
let target: string;
const OLD = build("v0.6.0");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "todou-upgrade-"));
  target = join(dir, "todou");
  writeFileSync(target, OLD, { mode: 0o751 });
});

afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

function seam(over: Partial<UpgradeSeam> = {}): UpgradeSeam {
  return {
    install: { kind: "binary", path: target, artifact: ART, platform: "linux" },
    currentVersion: "v0.6.0",
    // Refuses a file without the execute bit, as spawn would: the end-to-end
    // run against real builds first failed exactly there.
    smoke: async ([file]) => {
      if ((statSync(file as string).mode & 0o100) === 0) {
        throw Object.assign(new Error(`spawn ${file} EACCES`), {
          code: "EACCES",
        });
      }
      return readFileSync(file as string, "utf8")
        .replace(/^build /, "")
        .trim();
    },
    ...over,
  };
}

async function upgrade(
  argv: string[],
  routes: Record<string, Reply | "down">,
  opts: { tty?: string; seam?: Partial<UpgradeSeam> } = {},
) {
  const { fetchImpl, calls } = web(routes);
  const result = await runCli(["upgrade", "--server", SRV, ...argv], {
    fetchImpl,
    stdinText: opts.tty,
    stdinIsTTY: opts.tty !== undefined,
    upgrade: seam(opts.seam),
  });
  return { ...result, calls, installed: readFileSync(target, "utf8") };
}

/** Nothing but the target is left in its directory: no temp file, no aside. */
function onlyTarget() {
  expect(readdirSync(dir)).toEqual(["todou"]);
}

const NEW = build("v0.7.0");
const AHEAD = build("v0.7.0-12-gabcdef0");

describe("todou upgrade, against the decision table", () => {
  it("row 1: a server without /api/cli is skipped; GitHub installs, keeping the mode", async () => {
    const r = await upgrade([], { ...github("v0.7.0", NEW), ...NO_CLI });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.stdout).toContain(`upgraded todou v0.6.0 → v0.7.0 (${target})`);
    expect(statSync(target).mode & 0o777).toBe(0o751);
    onlyTarget();
  });

  it("row 2: a verified mirror downloads from the server, no prompt, nothing from GitHub's assets", async () => {
    const r = await upgrade([], {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0", NEW),
    });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.calls).toContain(`${SRV}/api/cli/${ART}`);
    expect(r.calls.some((u) => u.endsWith(`/v0.7.0/${ART}`))).toBe(false);
    expect(r.stderr).not.toMatch(/cannot vouch/);
  });

  it("row 2: a mirror that serves other bytes than it declared falls back to GitHub", async () => {
    const routes = {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0", NEW),
      [`${SRV}/api/cli/${ART}`]: () => new Response(build("v6.6.6")),
    };
    const r = await upgrade([], routes);
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.stderr).toMatch(/has sha256 .* expected .* not installed/);
    expect(r.stderr).toContain("trying GitHub instead");
    onlyTarget();
  });

  it("row 3: same version, different sha — the server's file is never even fetched", async () => {
    const evil = build("v0.7.0 evil");
    const r = await upgrade([], {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0", evil),
    });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.calls).not.toContain(`${SRV}/api/cli/${ART}`);
    expect(r.stderr).toMatch(/differs from the one GitHub published/);
  });

  it("row 4: a server ahead, no terminal, no --yes — declined, GitHub installs", async () => {
    const r = await upgrade([], {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0-12-gabcdef0", AHEAD),
    });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.calls).not.toContain(`${SRV}/api/cli/${ART}`);
    expect(r.stderr).toContain("declined: no terminal to ask on");
  });

  it("row 4: answering y on a terminal installs the server's build", async () => {
    const r = await upgrade(
      [],
      { ...github("v0.7.0", NEW), ...server("v0.7.0-12-gabcdef0", AHEAD) },
      { tty: "y\n" },
    );
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(AHEAD.toString());
    expect(r.stderr).toContain(
      `${SRV} offers todou v0.7.0-12-gabcdef0, which GitHub cannot vouch for`,
    );
    expect(r.stderr).toContain(`sha256 ${sha(AHEAD)}`);
  });

  it("row 4: anything but y on a terminal declines", async () => {
    const r = await upgrade(
      [],
      { ...github("v0.7.0", NEW), ...server("v0.7.0-12-gabcdef0", AHEAD) },
      { tty: "\n" },
    );
    expect(r.installed).toBe(NEW.toString());
  });

  it("row 6: GitHub down, no terminal — refused, nothing downloaded, file untouched", async () => {
    const r = await upgrade([], { ...GITHUB_DOWN, ...server("v0.7.0", NEW) });
    expect(r.exitCode).toBe(1);
    expect(r.installed).toBe(OLD.toString());
    expect(r.stderr).toContain("GitHub unreachable (ECONNREFUSED)");
    expect(r.stderr).toMatch(/rerun with --yes/);
    expect(r.calls).not.toContain(`${SRV}/api/cli/${ART}`);
    onlyTarget();
  });

  it("row 6: --yes accepts the server's build", async () => {
    const r = await upgrade(["--yes"], {
      ...GITHUB_DOWN,
      ...server("v0.7.0", NEW),
    });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
    expect(r.stderr).toContain("installing it anyway: --yes");
  });

  it("row 6: a trusted server still has to deliver what it declared", async () => {
    const routes = {
      ...GITHUB_DOWN,
      ...server("v0.7.0", NEW),
      [`${SRV}/api/cli/${ART}`]: () => new Response(build("v0.7.0 swapped")),
    };
    const r = await upgrade(["--yes"], routes);
    expect(r.exitCode).toBe(1);
    expect(r.installed).toBe(OLD.toString());
    onlyTarget();
  });

  it("row 7: both down — exit 1, both reasons", async () => {
    const r = await upgrade([], { ...GITHUB_DOWN, ...NO_CLI });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("GitHub unreachable (ECONNREFUSED)");
    expect(r.stderr).toContain(`${SRV} does not serve /api/cli`);
    onlyTarget();
  });

  it("row 8: up to date downloads nothing", async () => {
    const r = await upgrade([], github("v0.7.0", NEW), {
      seam: { currentVersion: "v0.7.0" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("todou v0.7.0 is up to date");
    expect(r.calls.some((u) => u.endsWith(ART))).toBe(false);
    onlyTarget();
  });

  it("--force reinstalls the same version", async () => {
    const r = await upgrade(
      ["--force", "--from", "github"],
      github("v0.7.0", NEW),
      {
        seam: { currentVersion: "v0.7.0" },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(NEW.toString());
  });
});

describe("what is never installed", () => {
  it("GitHub bytes that do not match SHA256SUMS", async () => {
    const r = await upgrade(
      ["--from", "github"],
      github("v0.7.0", NEW, "d".repeat(64)),
    );
    expect(r.exitCode).toBe(1);
    expect(r.installed).toBe(OLD.toString());
    expect(r.stderr).toMatch(/expected d{64} — not installed/);
    onlyTarget();
  });

  it("a server stream longer than its manifest declares is cut off, not written out", async () => {
    const routes = {
      ...GITHUB_DOWN,
      ...server("v0.7.0", NEW),
      [`${SRV}/api/cli/${ART}`]: () =>
        new Response(Buffer.concat([NEW, Buffer.alloc(1 << 20)])),
    };
    const r = await upgrade(["--yes"], routes);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `sent more than the ${NEW.length} bytes its manifest declares`,
    );
    expect(r.installed).toBe(OLD.toString());
    onlyTarget();
  });

  it("a build that does not answer --version with the version it was fetched as", async () => {
    const r = await upgrade(
      ["--from", "github"],
      github("v0.7.0", build("v0.6.9")),
    );
    expect(r.exitCode).toBe(1);
    expect(r.installed).toBe(OLD.toString());
    expect(r.stderr).toMatch(/reports v0\.6\.9, expected v0\.7\.0/);
    onlyTarget();
  });

  it("--from server with the same version but a different sha asks (q4); no terminal declines", async () => {
    const evil = build("v0.7.0 evil");
    const routes = { ...github("v0.7.0", NEW), ...server("v0.7.0", evil) };
    const r = await upgrade(["--from", "server"], routes);
    expect(r.exitCode).toBe(1);
    expect(r.installed).toBe(OLD.toString());
    expect(r.stderr).toMatch(
      /differs from the one GitHub published for v0\.7\.0/,
    );
    expect(r.calls.some((u) => u.endsWith(`/v0.7.0/${ART}`))).toBe(false);
  });
});

describe("--from restricts the sources", () => {
  it("github never asks the server", async () => {
    const r = await upgrade(["--from", "github"], github("v0.7.0", NEW));
    expect(r.exitCode).toBe(0);
    expect(r.calls.some((u) => u.startsWith(SRV))).toBe(false);
  });

  it("server never downloads from GitHub, even when the server fails", async () => {
    const routes = {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0", NEW),
      [`${SRV}/api/cli/${ART}`]: () => new Response("oops", { status: 500 }),
    };
    const r = await upgrade(["--from", "server"], routes);
    expect(r.exitCode).toBe(1);
    expect(r.calls.some((u) => u.endsWith(`/v0.7.0/${ART}`))).toBe(false);
    expect(r.installed).toBe(OLD.toString());
  });

  it("rejects an unknown --from", async () => {
    const r = await upgrade(["--from", "ftp"], {});
    expect(r.exitCode).toBe(1);
    expect(r.calls).toEqual([]);
  });
});

describe("installs it cannot replace", () => {
  it.skipIf(process.getuid?.() === 0)(
    "a directory it cannot write is refused before any network",
    async () => {
      chmodSync(dir, 0o555);
      const r = await upgrade([], github("v0.7.0", NEW));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        `replacing ${target} is not supported: ${dir} is not writable (EACCES)`,
      );
      expect(r.calls).toEqual([]);
      expect(r.installed).toBe(OLD.toString());
    },
  );

  const refused: InstallForm = {
    kind: "refused",
    reason: "/nix/store/x-todou/bin/todou was installed by nix",
    hint: "upgrade it through nix",
  };

  it("a refused form errors before any network", async () => {
    const r = await upgrade([], github("v0.7.0", NEW), {
      seam: { install: refused },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "cannot upgrade: /nix/store/x-todou/bin/todou was installed by nix",
    );
    expect(r.calls).toEqual([]);
  });

  it("--check still reports the versions for a refused form", async () => {
    const r = await upgrade(["--check"], github("v0.7.0", NEW), {
      seam: { install: refused },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("github   v0.7.0");
    expect(r.stdout).toContain("→ cannot upgrade:");
  });
});

describe("--check", () => {
  it("reports both sides and the plan, downloading nothing", async () => {
    const r = await upgrade(["--check"], {
      ...github("v0.7.0", NEW),
      ...server("v0.7.0-12-gabcdef0", AHEAD),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("current  v0.6.0");
    expect(r.stdout).toContain(`server   v0.7.0-12-gabcdef0  ${SRV}`);
    expect(r.stdout).toMatch(
      /would install v0\.7\.0-12-gabcdef0 from http:\/\/srv\.test after asking/,
    );
    expect(r.stdout).toContain("otherwise v0.7.0 from GitHub");
    expect(r.calls.some((u) => u.endsWith(ART))).toBe(false);
    onlyTarget();
  });

  it("--json gives the same as a record", async () => {
    const r = await upgrade(["--check", "--json"], {
      ...github("v0.7.0", NEW),
      ...NO_CLI,
    });
    const record = JSON.parse(r.stdout);
    expect(record.github).toEqual({ version: "v0.7.0" });
    expect(record.server).toEqual({
      origin: SRV,
      version: null,
      reason: "does not serve /api/cli",
    });
    expect(record.plan.kind).toBe("install");
  });
});
