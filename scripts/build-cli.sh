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

# The scratch copy exists so the version injection below can overwrite a
# tracked file without dirtying the developer's checkout; `--prod --filter`
# narrows the install to what esbuild needs to resolve the CLI's imports.
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

# The stage, never the working tree: bundle-cli.sh overwrites a tracked file to
# inject the version, and a build must not dirty the developer's checkout. Every
# other artifact is then compiled from this bundle.
#
# `pnpm exec` puts node_modules/.bin ahead of PATH, so the release artifacts are
# bundled with the esbuild the lockfile pins.
echo "==> bundling todou.cjs at version $VERSION (bring-your-own-Node)"
pnpm exec scripts/bundle-cli.sh "$STAGE" "$VERSION" "$OUT/todou.cjs"

# Compiling the bundle above, not the TS entry: the VFS snapshot `deno compile`
# takes of a pnpm tree drops the links that live inside `.pnpm`, so a
# transitive import compiles clean and fails at startup (T-204). A bundle has
# no imports left to resolve, and every artifact then ships the same code.
echo "==> deno compile"
while IFS=: read -r name target; do
  [ -n "$name" ] || continue
  out="$OUT/todou-$name"
  case "$name" in windows-*) out="$out.exe" ;; esac
  echo "  -> $name ($target)"
  # --node-modules-dir=none: deno otherwise walks up to the nearest
  # package.json and embeds the node_modules beside it, which takes the
  # executable from 86 MB to 464.
  deno compile --node-modules-dir=none --allow-all --target "$target" \
    --output "$out" "$OUT/todou.cjs"
done <<EOF
$TARGETS
EOF

rm -rf "$STAGE"

# sha256 proves the bytes, not that they start: T-204 shipped four executables
# that compiled without a single warning and then died on every invocation.
# Comparing the printed version verbatim also rules out a stale artifact.
echo "==> smoke: --version must print $VERSION"
smoke() { # <label> <command…>
  # `local got` separate from the assignment: `local got="$(…)"` would make
  # `local`'s own exit code the one $? reports, hiding a crashed artifact.
  local label="$1" got
  shift
  if ! got="$("$@" --version 2>&1)" || [ "$got" != "$VERSION" ]; then
    echo "smoke failed: $label printed '${got:-<nothing>}' (want '$VERSION')" >&2
    exit 1
  fi
  echo "  ok: $label"
}
smoke todou.cjs node "$OUT/todou.cjs"
# Only the artifact matching the build host can run; the other targets stay
# compile-only, which the two-architecture docker build already covers for
# linux. Windows has no build host at all — the scripts are bash.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) smoke todou-linux-amd64 "$OUT/todou-linux-amd64" ;;
  Linux/aarch64) smoke todou-linux-arm64 "$OUT/todou-linux-arm64" ;;
  Darwin/arm64) smoke todou-macos-arm64 "$OUT/todou-macos-arm64" ;;
  *)
    echo "  warn: no deno artifact runs on $(uname -s)/$(uname -m)" \
      "— only todou.cjs smoked" >&2
    ;;
esac

echo
echo "==> dist/ artifact sizes"
ls -lh "$OUT"
