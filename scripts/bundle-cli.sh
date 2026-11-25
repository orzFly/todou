#!/usr/bin/env bash
# The esbuild invocation, shared by scripts/build-cli.sh and the nix package so
# that the bundler flags exist in one place. Two copies drift silently: whoever
# edits one side gets no error from the other, and nix keeps shipping a bundle
# built to the old flags.
#
#   bundle-cli.sh [--runtime node|tjs] <tree> <version> <outfile>
#   bundle-cli.sh --tjs-flags <tree>
#
# `--runtime node`, the default, is todou.cjs. `--runtime tjs` is the ESM
# bundle the single-file executables are compiled from (T-792); it needs the
# build host's tjs in $TJS, which compiles the mermaid payload.
# `--tjs-flags` prints the tjs flags one per line, for scripts that bundle a
# different entry with the same configuration (scripts/tjs-conformance.mjs).
#
# `esbuild` is resolved from PATH rather than through `pnpm exec`, because the
# caller decides which copy runs — the lockfile's for release artifacts,
# nixpkgs' inside the nix build.
set -euo pipefail

# Every node module the CLI process may use is listed in design.md's subset
# table of T-792 and has a shim of the same name under tjs/node/; `tty` is the
# one clipanion imports. A shim exports only the subset's names, so code that
# reaches past the subset fails this build with esbuild's "No matching export"
# naming the import. `--platform=neutral` is what makes any other node module
# fail to resolve at all, rather than being left for a runtime that has none.
# The `tjs` condition selects the tjs side of the package.json `imports`
# entries (#mermaid-loader, #git-describe). process and Buffer come from the
# injected prelude. async_hooks is left external: clipanion requires it only
# when a command's output is captured into another stream, which the CLI never
# asks for, and esbuild would otherwise fail on it.
tjs_flags() { # <tree>
  local tjs="$1/projects/cli/tjs"
  # esbuild reads an alias target without a leading `./` or `/` as a package.
  case "$tjs" in
    /* | ./*) ;;
    *) tjs="./$tjs" ;;
  esac
  TJS_FLAGS=(
    --bundle --platform=neutral --format=esm --target=es2024
    --main-fields=module,main --conditions=tjs
    --external:'tjs:*' --external:async_hooks
    "--inject:$tjs/prelude.ts"
    "--alias:node:fs/promises=$tjs/node/fs-promises.ts"
    "--alias:node:fs=$tjs/node/fs.ts"
    "--alias:node:child_process=$tjs/node/child-process.ts"
    "--alias:node:path=$tjs/node/path.ts"
    "--alias:node:os=$tjs/node/os.ts"
    "--alias:node:crypto=$tjs/node/crypto.ts"
    "--alias:node:util=$tjs/node/util.ts"
    "--alias:node:net=$tjs/node/net.ts"
    "--alias:node:http=$tjs/node/http.ts"
    "--alias:node:readline=$tjs/node/readline.ts"
    "--alias:tty=$tjs/node/tty.ts"
  )
}

if [ "${1-}" = --tjs-flags ]; then
  if [ $# -ne 2 ]; then
    echo "usage: bundle-cli.sh --tjs-flags <tree>" >&2
    exit 2
  fi
  tjs_flags "$2"
  printf '%s\n' "${TJS_FLAGS[@]}"
  exit 0
fi

RUNTIME=node
case "${1-}" in
  --runtime)
    RUNTIME="${2-}"
    shift $(($# > 1 ? 2 : 1))
    ;;
  --runtime=*)
    RUNTIME="${1#*=}"
    shift
    ;;
esac
if [ $# -ne 3 ] || { [ "$RUNTIME" != node ] && [ "$RUNTIME" != tjs ]; }; then
  echo "usage: bundle-cli.sh [--runtime node|tjs] <tree> <version> <outfile>" >&2
  exit 2
fi
TREE="$1"
VERSION="$2"
OUT="$3"
if [ "$RUNTIME" = tjs ] && [ -z "${TJS:-}" ]; then
  echo "bundle-cli.sh: --runtime tjs needs the build host's tjs in \$TJS" >&2
  exit 2
fi

echo "==> esbuild $(esbuild --version) from $(command -v esbuild) ($RUNTIME)"

# build-info.ts is a tracked placeholder, and this overwrites it: the caller has
# to hand over a tree it is willing to have modified.
printf 'export const BUILD_VERSION: string | null = "%s";\n' "$VERSION" \
  > "$TREE/projects/shared/src/build-info.ts"

# mermaid travels compressed inside the bundle and is only evaluated when a
# body holds a diagram (T-769). Bundled plainly it would be 5 MB that V8
# compiles on every start, doubling the CLI's startup time. Both runtimes
# start from the same CommonJS sub-bundle: node's payload is its source,
# brotli-compressed; tjs' is the QuickJS bytecode compiled from it, which
# loads in a tenth of the time the source would. The payload files are
# tracked placeholders overwritten the same way as build-info.ts above.
MERMAID="$TREE/projects/cli/src/mermaid"
# esbuild reads an alias target without a leading `./` or `/` as a package name.
case "$MERMAID" in
  /* | ./*) ;;
  *) MERMAID="./$MERMAID" ;;
esac
MERMAID_SUB="$(dirname "$OUT")/.mermaid-sub.cjs"
trap 'rm -f "$MERMAID_SUB"' EXIT
MSYS_NO_PATHCONV=1 esbuild "$MERMAID/entry.ts" \
  --bundle --platform=node --format=cjs --minify --log-level=warning \
  --alias:dompurify="$MERMAID/dompurify-stub.ts" \
  --outfile="$MERMAID_SUB"

if [ "$RUNTIME" = tjs ]; then
  "$TJS" run "$TREE/projects/cli/tjs/compile.js" --mermaid \
    "$MERMAID_SUB" "$TREE/projects/cli/tjs/mermaid-payload.ts"
  tjs_flags "$TREE"
  MSYS_NO_PATHCONV=1 esbuild "$TREE/projects/cli/tjs/main.ts" \
    "${TJS_FLAGS[@]}" \
    --outfile="$OUT"
  exit 0
fi

node "$TREE/projects/cli/build/embed-mermaid.mjs" \
  "$MERMAID_SUB" "$MERMAID/payload.ts"

# `.cjs` rather than `.js` because the bundle is CommonJS: a bare `.js` is read
# as ESM whenever the nearest package.json says `"type": "module"`, which breaks
# the moment someone drops the file into a modern project. The extension is
# unconditional.
#
# MSYS_NO_PATHCONV: Git Bash on Windows rewrites arguments that look like POSIX
# paths before a native program sees them, which turned the banner into
# `#!C:/…/usr/bin/env node` (T-572). Other shells ignore the variable.
#
# `--external:mermaid` makes a stray import of mermaid a failure at run time
# rather than 5 MB of plain mermaid silently added to every start.
MSYS_NO_PATHCONV=1 esbuild "$TREE/projects/cli/src/index.ts" \
  --bundle --platform=node --format=cjs \
  --external:mermaid \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT"
chmod +x "$OUT"
