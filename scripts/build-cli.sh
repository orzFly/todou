#!/usr/bin/env bash
# Build standalone `todou` CLI artifacts (T-22): four deno-compiled
# executables plus one esbuild-bundled .cjs for users who bring their own
# Node runtime. Everything lands in dist/, which is git-ignored.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT=dist
STAGE="$OUT/.stage"

# `git` stages through `git ls-files`; `copy` copies the working tree instead,
# for build contexts that carry no .git — the docker image build (T-146).
STAGE_MODE=git
while [ $# -gt 0 ]; do
  case "$1" in
    --stage-mode) STAGE_MODE="${2-}"; shift $(($# > 1 ? 2 : 1)) ;;
    --stage-mode=*) STAGE_MODE="${1#*=}"; shift ;;
    *) echo "usage: build-cli.sh [--stage-mode git|copy]" >&2; exit 2 ;;
  esac
done
case "$STAGE_MODE" in
  git | copy) ;;
  *) echo "build-cli.sh: --stage-mode must be git or copy" >&2; exit 2 ;;
esac

# Plain string pairs rather than `declare -A`: associative arrays need bash 4,
# and macOS still ships bash 3.2.
TARGETS="
linux-amd64:x86_64-unknown-linux-gnu
linux-arm64:aarch64-unknown-linux-gnu
macos-arm64:aarch64-apple-darwin
windows-amd64:x86_64-pc-windows-msvc
"

# Computed before anything else touches the tree; --dirty reflects the same
# working-tree content `git ls-files` stages below, so the suffix is truthful
# about what actually enters the artifacts. TODOU_BUILD_VERSION wins, for
# builds where git cannot answer — the docker stage has no .git and no git.
VERSION="${TODOU_BUILD_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
fi

rm -rf "$OUT"
mkdir -p "$OUT"
trap 'rm -rf "$STAGE"' EXIT

# `deno compile` embeds whole package directories without tree-shaking, so a
# dev-dependency tree would ship typescript, vitest and @types/node inside
# every executable (~7 MB). It needs a prod-only node_modules — built here in
# a scratch copy, because pruning the developer's own tree to get one is not
# an acceptable side effect of running a build.
#
# `git ls-files` copies tracked files with their current working-tree content
# (so uncommitted edits are built) while leaving node_modules, dist/ and data/
# behind. Brand-new untracked files are not picked up — `git add` them first.
echo "==> staging a prod-only tree in $STAGE ($STAGE_MODE mode)"
mkdir -p "$STAGE"
if [ "$STAGE_MODE" = git ]; then
  git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$STAGE"
else
  # Nothing to list without .git: docker's `COPY . .` has already applied
  # .dockerignore, whose stated purpose is to make the context equal the
  # tracked tree. node_modules and dist are excluded because the image build
  # creates them after that copy; .git because a copy-mode run outside docker
  # would otherwise duplicate the whole object store for nothing.
  tar --exclude ./node_modules --exclude ./dist --exclude ./.git -cf - . \
    | tar -xf - -C "$STAGE"
fi
(cd "$STAGE" && CI=true pnpm install --prod --frozen-lockfile --filter '@todou/cli...')

# Overwriting the tracked placeholder in the staged copy — never the working
# tree — bakes the version into everything built from the stage; a build must
# not dirty the developer's checkout.
echo "==> injecting version $VERSION"
printf 'export const BUILD_VERSION: string | null = "%s";\n' "$VERSION" \
  > "$STAGE/projects/shared/src/build-info.ts"

# esbuild bundles from the stage rather than the workspace tree so the version
# injection above reaches the bundle through the same file deno compile reads —
# one mechanism for every artifact. `.cjs` rather than `.js` because the bundle
# is CommonJS: a bare `.js` is read as ESM whenever the nearest package.json
# says `"type": "module"`, which breaks the moment someone drops the file into
# a modern project. The extension is unconditional.
echo "==> esbuild single-file todou.cjs (bring-your-own-Node)"
pnpm exec esbuild "$STAGE/projects/cli/src/index.ts" \
  --bundle --platform=node --format=cjs \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$OUT/todou.cjs"
chmod +x "$OUT/todou.cjs"

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
