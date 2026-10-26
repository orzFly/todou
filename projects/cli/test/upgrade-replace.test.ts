import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { binaryArtifact, detectInstall } from "../src/upgrade/install-form.ts";
import { type SwapIo, swap, sweepAside } from "../src/upgrade/replace.ts";

describe("detectInstall", () => {
  const deno = (os: string, arch: string, standalone: boolean) => ({
    execPath: () => "/opt/todou/todou",
    build: { os, arch, standalone },
  });
  const id = (p: string) => p;

  it("a compiled binary replaces its own executable, with the matching artifact", () => {
    expect(
      detectInstall({
        deno: deno("linux", "aarch64", true),
        buildVersion: "v0.7.0",
        script: "/opt/todou/todou",
        execPath: "/opt/todou/todou",
        platform: "linux",
        realpath: id,
      }),
    ).toEqual({
      kind: "binary",
      path: "/opt/todou/todou",
      artifact: "todou-linux-arm64",
      platform: "linux",
    });
  });

  it("todou.cjs replaces the script, run again by the runtime running it", () => {
    const node = detectInstall({
      deno: undefined,
      buildVersion: "v0.7.0",
      script: "/home/todou/bin/todou.cjs",
      execPath: "/usr/bin/node",
      platform: "linux",
      realpath: id,
    });
    expect(node).toMatchObject({
      kind: "script",
      path: "/home/todou/bin/todou.cjs",
      runner: ["/usr/bin/node"],
    });
    const underDeno = detectInstall({
      deno: deno("linux", "x86_64", false),
      buildVersion: "v0.7.0",
      script: "/home/todou/bin/todou.cjs",
      execPath: "/usr/bin/deno",
      platform: "linux",
      realpath: id,
    });
    expect(underDeno).toMatchObject({
      kind: "script",
      runner: ["/usr/bin/deno", "run", "--allow-all"],
    });
  });

  it("nix (deno running a store path) and a source checkout are refused", () => {
    expect(
      detectInstall({
        deno: deno("linux", "x86_64", false),
        buildVersion: "0.6.5-g2cc59bb",
        script: "/nix/store/abc-todou-cli-cjs/lib/todou/todou.cjs",
        execPath: "/nix/store/def-deno/bin/deno",
        platform: "linux",
        realpath: id,
      }),
    ).toMatchObject({ kind: "refused", hint: "upgrade it through nix" });
    expect(
      detectInstall({
        deno: undefined,
        buildVersion: null,
        script: "/src/todou/projects/cli/src/index.ts",
        execPath: "/usr/bin/node",
        platform: "linux",
        realpath: id,
      }),
    ).toMatchObject({
      kind: "refused",
      reason: "this todou runs from a source checkout",
    });
  });

  it("a symlinked install replaces the file the link points at", () => {
    // Resolved up front: `detectInstall` reports the real path, and on macOS
    // the default TMPDIR sits behind the `/var` -> `/private/var` link.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "todou-install-")));
    try {
      mkdirSync(join(dir, "opt"));
      writeFileSync(join(dir, "opt", "todou.cjs"), "x");
      mkdirSync(join(dir, "bin"));
      symlinkSync(join(dir, "opt", "todou.cjs"), join(dir, "bin", "todou"));
      const form = detectInstall({
        deno: undefined,
        buildVersion: "v0.7.0",
        script: join(dir, "bin", "todou"),
        execPath: "/usr/bin/node",
        platform: "linux",
      });
      expect(form).toMatchObject({ path: join(dir, "opt", "todou.cjs") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the artifacts build-cli.sh builds, and nothing it does not", () => {
    expect(binaryArtifact("linux", "x86_64")).toBe("todou-linux-amd64");
    expect(binaryArtifact("darwin", "aarch64")).toBe("todou-macos-arm64");
    expect(binaryArtifact("windows", "x86_64")).toBe("todou-windows-amd64.exe");
    expect(binaryArtifact("darwin", "x86_64")).toBeNull();
    expect(binaryArtifact("linux", "constructor")).toBeNull();
  });
});

describe("swap", () => {
  let dir: string;
  let target: string;
  let tmp: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "todou-swap-"));
    target = join(dir, "todou.exe");
    tmp = join(dir, ".todou.exe.upgrade-1.exe");
    writeFileSync(target, "old");
    writeFileSync(tmp, "new");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Real files, with Windows' one rule layered on: a running executable can
   * be renamed but not replaced or deleted.
   */
  async function windowsIo(over: Partial<SwapIo> = {}) {
    const fsp = await import("node:fs/promises");
    const log: string[] = [];
    const running = new Set([target]);
    const io: SwapIo = {
      stat: fsp.stat,
      chmod: fsp.chmod,
      readdir: fsp.readdir,
      rename: async (from, to) => {
        log.push(
          `rename ${String(from).slice(dir.length + 1)} -> ${String(to).slice(dir.length + 1)}`,
        );
        if (running.has(String(to))) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        await fsp.rename(from, to);
        if (running.delete(String(from))) running.add(String(to));
      },
      unlink: async (path) => {
        log.push(`unlink ${String(path).slice(dir.length + 1)}`);
        if (running.has(String(path))) {
          throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        }
        await fsp.unlink(path);
      },
      ...over,
    } as SwapIo;
    return { io, log };
  }

  it("Windows: the running file steps aside, the new one takes its name, the aside waits", async () => {
    const { io, log } = await windowsIo();
    await swap(tmp, target, "win32", io);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(log[0]).toMatch(
      /^rename todou\.exe -> \.todou\.exe\.old-[0-9a-f]+$/,
    );
    expect(log[1]).toBe("rename .todou.exe.upgrade-1.exe -> todou.exe");
    const aside = readdirSync(dir).filter((n) =>
      n.startsWith(".todou.exe.old-"),
    );
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), "utf8")).toBe("old");
  });

  it("Windows: a failed second rename puts the old file back", async () => {
    const fsp = await import("node:fs/promises");
    let n = 0;
    const { io } = await windowsIo({
      rename: async (from, to) => {
        n += 1;
        if (n === 2)
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        await fsp.rename(from, to);
      },
    });
    await expect(swap(tmp, target, "win32", io)).rejects.toThrow(
      /is not supported/,
    );
    expect(readFileSync(target, "utf8")).toBe("old");
  });

  it("a later run sweeps the asides that are no longer running", async () => {
    writeFileSync(join(dir, ".todou.exe.old-abc"), "older");
    writeFileSync(join(dir, ".other.old-abc"), "not ours");
    await sweepAside(target);
    expect(readdirSync(dir).sort()).toEqual([
      ".other.old-abc",
      ".todou.exe.upgrade-1.exe",
      "todou.exe",
    ]);
  });

  it("POSIX: one rename over the target", async () => {
    await swap(tmp, target, "linux");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["todou.exe"]);
  });
});
