// node:os for the tjs build. libuv answers all three for both runtimes, with
// the same environment lookups ($HOME, $TMPDIR and its fallbacks).
export function homedir(): string {
  return tjs.homeDir;
}

export function tmpdir(): string {
  return tjs.tmpDir;
}

export function hostname(): string {
  return tjs.hostName;
}
