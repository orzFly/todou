import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { BUILD_VERSION } from "@todou/shared/version";

/**
 * What this process is, as far as replacing it goes. `path` is always the
 * resolved file — replacing a symlink would leave the real file behind and
 * break whatever else points at it.
 */
export type InstallForm =
  | {
      kind: "binary";
      path: string;
      /** The release artifact this platform runs, e.g. todou-linux-amd64. */
      artifact: string | null;
      platform: NodeJS.Platform;
    }
  | {
      kind: "script";
      path: string;
      artifact: "todou.cjs";
      /** argv that runs a script under the runtime running this one. */
      runner: string[];
      platform: NodeJS.Platform;
    }
  | { kind: "refused"; reason: string; hint: string };

type DenoGlobal = {
  execPath(): string;
  build: { os: string; arch: string; standalone?: boolean };
};

/** The single-file executables' runtime, txiki.js (T-792). */
type TjsGlobal = { exePath: string };

export type InstallProbe = {
  deno: DenoGlobal | undefined;
  tjs?: TjsGlobal | undefined;
  buildVersion: string | null;
  /** process.argv[1]: the script a runtime was handed. */
  script: string | undefined;
  execPath: string;
  platform: NodeJS.Platform;
  /** process.arch; only a tjs executable needs it to name its artifact. */
  arch?: string;
  realpath?: (path: string) => Promise<string>;
};

/**
 * Names as scripts/build-cli-tjs.sh writes them; null where it builds
 * nothing. `os` and `arch` are given the way deno spells them (`windows`,
 * `x86_64`) or the way Node does (`win32`, `x64`).
 */
export function binaryArtifact(os: string, arch: string): string | null {
  const a =
    arch === "x86_64" || arch === "x64"
      ? "amd64"
      : arch === "aarch64" || arch === "arm64"
        ? "arm64"
        : null;
  if (a === null) return null;
  switch (os) {
    case "linux":
      return `todou-linux-${a}`;
    case "darwin":
      return `todou-macos-${a}`;
    case "windows":
    case "win32":
      return `todou-windows-${a}.exe`;
    default:
      return null;
  }
}

export async function detectInstall(probe: InstallProbe): Promise<InstallForm> {
  const real = probe.realpath ?? realpath;
  if (probe.buildVersion === null) {
    return {
      kind: "refused",
      reason: "this todou runs from a source checkout",
      hint: "update the checkout with git instead",
    };
  }

  let form: InstallForm;
  if (probe.tjs !== undefined) {
    form = {
      kind: "binary",
      path: await real(probe.tjs.exePath),
      artifact: binaryArtifact(probe.platform, probe.arch ?? ""),
      platform: probe.platform,
    };
  } else if (probe.deno?.build.standalone) {
    form = {
      kind: "binary",
      path: await real(probe.deno.execPath()),
      artifact: binaryArtifact(probe.deno.build.os, probe.deno.build.arch),
      platform: probe.platform,
    };
  } else if (probe.script !== undefined) {
    const path = await real(resolve(probe.script));
    form = {
      kind: "script",
      path,
      artifact: "todou.cjs",
      runner:
        probe.deno === undefined
          ? [probe.execPath]
          : [probe.execPath, "run", "--allow-all"],
      platform: probe.platform,
    };
  } else {
    return {
      kind: "refused",
      reason: "cannot tell which file this todou was started from",
      hint: "download a build from the releases page instead",
    };
  }

  // A store path is read-only by construction and owned by the package
  // manager's own bookkeeping; even a writable one must not be edited behind
  // its back, so this is refused before any writability probe.
  if (form.path.startsWith("/nix/store/")) {
    return {
      kind: "refused",
      reason: `${form.path} was installed by nix`,
      hint: "upgrade it through nix",
    };
  }
  return form;
}

export function currentInstall(): Promise<InstallForm> {
  return detectInstall({
    deno: (globalThis as { Deno?: DenoGlobal }).Deno,
    tjs: (globalThis as { tjs?: TjsGlobal }).tjs,
    buildVersion: BUILD_VERSION,
    script: process.argv[1],
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  });
}
