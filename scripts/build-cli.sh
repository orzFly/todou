#!/usr/bin/env bash
# Build standalone `todou` CLI artifacts (issue #22): four deno-compiled
# executables plus one esbuild-bundled .cjs for users who bring their own
# Node runtime. Everything lands in dist/, which is git-ignored.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT=dist
STAGE="$OUT/.stage"

# Plain string pairs rather than `declare -A`: associative arrays need bash 4,
# and macOS still ships bash 3.2.
TARGETS="
linux-amd64:x86_64-unknown-linux-gnu
linux-arm64:aarch64-unknown-linux-gnu
macos-arm64:aarch64-apple-darwin
windows-amd64:x86_64-pc-windows-msvc
"

rm -rf "$OUT"
mkdir -p "$OUT"
trap 'rm -rf "$STAGE"' EXIT

# esbuild tree-shakes by module graph, so it can bundle straight from the
# workspace tree — no staging needed. `.cjs` rather than `.js` because the
# bundle is CommonJS: a bare `.js` is read as ESM whenever the nearest
# package.json says `"type": "module"`, which breaks the moment someone drops
# the file into a modern project. The extension is unconditional.
echo "==> esbuild single-file todou.cjs (bring-your-own-Node)"
pnpm exec esbuild projects/cli/src/index.ts \
  --bundle --platform=node --format=cjs \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT/todou.cjs"
chmod +x "$OUT/todou.cjs"

# `deno compile` embeds whole package directories without tree-shaking, so a
# dev-dependency tree would ship typescript, vitest and @types/node inside
# every executable (~7 MB). It needs a prod-only node_modules — built here in
# a scratch copy, because pruning the developer's own tree to get one is not
# an acceptable side effect of running a build.
#
# `git ls-files` copies tracked files with their current working-tree content
# (so uncommitted edits are built) while leaving node_modules, dist/ and data/
# behind. Brand-new untracked files are not picked up — `git add` them first.
echo "==> staging a prod-only tree in $STAGE"
mkdir -p "$STAGE"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$STAGE"
(cd "$STAGE" && CI=true pnpm install --prod --frozen-lockfile --filter '@todou/cli...')

# --no-check: type checking is `pnpm typecheck`'s job, and running it here
# would demand @types/node — a dev dependency, absent from the staged tree by
# design. Deno reacts to that resolution failure by silently rewriting
# package.json with a migrated workspace config, so removing this flag breaks
# the build and dirties a tracked file at the same time.
echo "==> deno compile"
while IFS=: read -r name target; do
  [ -n "$name" ] || continue
  out="$OUT/todou-$name"
  case "$name" in windows-*) out="$out.exe" ;; esac
  echo "  -> $name ($target)"
  deno compile --no-check --allow-all --target "$target" --output "$out" \
    "$STAGE/projects/cli/src/index.ts"
done <<EOF
$TARGETS
EOF

rm -rf "$STAGE"

echo
echo "==> dist/ artifact sizes"
ls -lh "$OUT"
