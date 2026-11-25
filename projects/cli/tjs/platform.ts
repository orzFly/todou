// The host as Node names it.
//
// `navigator.platform` cannot give the architecture on a Mac or on Windows:
// tjs answers `MacIntel` and `Win32` there whatever the CPU, as browsers do.
// The architecture and the OS release come from the high-entropy hints
// instead, which read the same uname(2) data but return a promise, so they
// are filled in by `detectPlatform`, which the entry points await before
// they load anything else. It cannot be a top-level await here: this module
// is reached from the injected prelude, which esbuild imports into every
// file, CommonJS ones included, and a `require` may not reach a top-level
// await.
//
// Like `uname -m`, the hints describe the machine as this process sees it:
// an x64 build running under emulation reports x64, as Node would.

/** tjs implements the User-Agent Client Hints API, which lib.dom lacks. */
type UserAgentData = {
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<{
    architecture?: string;
    bitness?: string;
    platformVersion?: string;
  }>;
};
const userAgentData = (
  navigator as Navigator & { userAgentData: UserAgentData }
).userAgentData;

const NODE_PLATFORM: Record<string, NodeJS.Platform> = {
  Linux: "linux",
  macOS: "darwin",
  Windows: "win32",
  FreeBSD: "freebsd",
  OpenBSD: "openbsd",
};

export const platform: NodeJS.Platform =
  NODE_PLATFORM[userAgentData.platform] ??
  (userAgentData.platform.toLowerCase() as NodeJS.Platform);

export let arch: NodeJS.Architecture = "x64";

/** `os.release()`'s first three components, as Node's tty code reads them. */
export let osRelease = "";

export async function detectPlatform(): Promise<void> {
  const hints = await userAgentData.getHighEntropyValues([
    "architecture",
    "bitness",
    "platformVersion",
  ]);
  arch =
    hints.architecture === "arm"
      ? hints.bitness === "64"
        ? "arm64"
        : "arm"
      : hints.bitness === "64"
        ? "x64"
        : "ia32";
  osRelease = hints.platformVersion ?? "";
}
