#!/usr/bin/env bash
# The six single-file `todou` executables (T-792): the CLI bundled for
# txiki.js, compiled to QuickJS bytecode by the build host's own tjs, and
# appended to each target's runtime. Bytecode does not depend on the
# architecture, so one host produces all six.
#
#   build-cli-tjs.sh <tree> <version> <runtimes-dir> <outdir>
#
# <tree> is a staged copy this may modify (bundle-cli.sh injects the version
# and the mermaid payload into it); <runtimes-dir> is the output of
# `nix build .#tjs-runtimes`. esbuild is taken from PATH, as bundle-cli.sh
# explains.
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: build-cli-tjs.sh <tree> <version> <runtimes-dir> <outdir>" >&2
  exit 2
fi
TREE="$1"
VERSION="$2"
RUNTIMES="$3"
OUTDIR="$4"
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Every runtime is cross-compiled, but only the build host's can run compile.js.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) HOST=tjs-linux-amd64 ;;
  Linux/aarch64 | Linux/arm64) HOST=tjs-linux-arm64 ;;
  Darwin/arm64) HOST=tjs-macos-arm64 ;;
  Darwin/x86_64) HOST=tjs-macos-amd64 ;;
  MINGW64_NT-*/x86_64 | MSYS_NT-*/x86_64) HOST=tjs-windows-amd64.exe ;;
  *)
    echo "build-cli-tjs.sh: no tjs runtime runs on $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac
TJS="$RUNTIMES/$HOST"
if [ ! -x "$TJS" ]; then
  echo "build-cli-tjs.sh: $TJS is missing or not executable" >&2
  exit 1
fi

mkdir -p "$OUTDIR"
WORK="$(mktemp -d "$OUTDIR/.tjs-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# `tjs run` is the tjs CLI, which creates its home directory on every start;
# pointed into the scratch directory, it leaves nothing in the builder's home.
export TJS_HOME="$WORK/tjs-home"

BUNDLE="$WORK/todou.mjs"
TJS="$TJS" bash "$SCRIPTS/bundle-cli.sh" --runtime tjs "$TREE" "$VERSION" "$BUNDLE"

echo "==> compiling to bytecode on $HOST"
"$TJS" run "$TREE/projects/cli/tjs/compile.js" "$BUNDLE" \
  "$RUNTIMES/tjs-linux-amd64" "$OUTDIR/todou-linux-amd64" \
  "$RUNTIMES/tjs-linux-arm64" "$OUTDIR/todou-linux-arm64" \
  "$RUNTIMES/tjs-macos-arm64" "$OUTDIR/todou-macos-arm64" \
  "$RUNTIMES/tjs-macos-amd64" "$OUTDIR/todou-macos-amd64" \
  "$RUNTIMES/tjs-windows-amd64.exe" "$OUTDIR/todou-windows-amd64.exe" \
  "$RUNTIMES/tjs-windows-arm64.exe" "$OUTDIR/todou-windows-arm64.exe"
