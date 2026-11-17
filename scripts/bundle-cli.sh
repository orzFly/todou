#!/usr/bin/env bash
# The esbuild invocation, shared by scripts/build-cli.sh and the nix package so
# that the bundler flags exist in one place. Two copies drift silently: whoever
# edits one side gets no error from the other, and nix keeps shipping a bundle
# built to the old flags.
#
# `esbuild` is resolved from PATH rather than through `pnpm exec`, because the
# caller decides which copy runs — the lockfile's for release artifacts,
# nixpkgs' inside the nix build.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: bundle-cli.sh <tree> <version> <outfile>" >&2
  exit 2
fi
TREE="$1"
VERSION="$2"
OUT="$3"

echo "==> esbuild $(esbuild --version) from $(command -v esbuild)"

# build-info.ts is a tracked placeholder, and this overwrites it: the caller has
# to hand over a tree it is willing to have modified.
printf 'export const BUILD_VERSION: string | null = "%s";\n' "$VERSION" \
  > "$TREE/projects/shared/src/build-info.ts"

# mermaid travels as a brotli-compressed string inside the bundle and is only
# evaluated when a body holds a diagram (T-769). Bundled plainly it would be
# 5 MB that V8 compiles on every start, doubling the CLI's startup time.
# payload.ts is a tracked placeholder overwritten the same way as
# build-info.ts above.
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
