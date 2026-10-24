import { realpathSync } from "node:fs";
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

export type InstallProbe = {
  deno: DenoGlobal | undefined;
  buildVersion: string | null;
  /** process.argv[1]: the script a runtime was handed. */
  script: string | undefined;
  execPath: string;
  platform: NodeJS.Platform;
  realpath?: (path: string) => string;
};

/** Names as scripts/build-cli.sh writes them; null where it builds nothing. */
export function binaryArtifact(os: string, arch: string): string | null {
  const a = arch === "x86_64" ? "amd64" : arch === "aarch64" ? "arm64" : null;
  if (a === null) return null;
  switch (os) {
    case "linux":
      return `todou-linux-${a}`;
    case "darwin":
      return a === "arm64" ? "todou-macos-arm64" : null;
    case "windows":
      return a === "amd64" ? "todou-windows-amd64.exe" : null;
    default:
      return null;
  }
}

export function detectInstall(probe: InstallProbe): InstallForm {
  const real = probe.realpath ?? realpathSync;
  if (probe.buildVersion === null) {
    return {
      kind: "refused",
      reason: "this todou runs from a source checkout",
      hint: "update the checkout with git instead",
    };
  }

  let form: InstallForm;
  if (probe.deno?.build.standalone) {
    form = {
      kind: "binary",
      path: real(probe.deno.execPath()),
      artifact: binaryArtifact(probe.deno.build.os, probe.deno.build.arch),
      platform: probe.platform,
    };
  } else if (probe.script !== undefined) {
    const path = real(resolve(probe.script));
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

export function currentInstall(): InstallForm {
  return detectInstall({
    deno: (globalThis as { Deno?: DenoGlobal }).Deno,
    buildVersion: BUILD_VERSION,
    script: process.argv[1],
    execPath: process.execPath,
    platform: process.platform,
  });
}
