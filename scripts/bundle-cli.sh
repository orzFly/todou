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

# `.cjs` rather than `.js` because the bundle is CommonJS: a bare `.js` is read
# as ESM whenever the nearest package.json says `"type": "module"`, which breaks
# the moment someone drops the file into a modern project. The extension is
# unconditional.
esbuild "$TREE/projects/cli/src/index.ts" \
  --bundle --platform=node --format=cjs \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT"
chmod +x "$OUT"
