#!/usr/bin/env bash
# Build standalone `todou` CLI artifacts (issue #22): four deno-compiled
# executables plus one esbuild-bundled .js for users who bring their own
# Node runtime. Everything lands in dist/, which is git-ignored.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT=dist
ESBUILD_VERSION=0.28.2

declare -A DENO_TARGETS=(
  [linux-amd64]=x86_64-unknown-linux-gnu
  [linux-arm64]=aarch64-unknown-linux-gnu
  [macos-arm64]=aarch64-apple-darwin
  [windows-amd64]=x86_64-pc-windows-msvc
)

rm -rf "$OUT"
mkdir -p "$OUT"

# Prod-only install keeps devDependency sources (vitest, typescript, ...) out
# of the node_modules tree that `deno compile` embeds — it vendors whole
# package directories, no tree-shaking. Restored at the end for local dev.
echo "==> pnpm install --prod (node_modules for deno compile)"
CI=true pnpm install --prod --frozen-lockfile

echo "==> deno compile"
for name in "${!DENO_TARGETS[@]}"; do
  target="${DENO_TARGETS[$name]}"
  out="$OUT/todou-$name"
  [[ "$name" == windows-* ]] && out="$out.exe"
  echo "  -> $name ($target)"
  deno compile --no-check --allow-all --target "$target" --output "$out" \
    projects/cli/src/index.ts
done

# esbuild only needs the same prod deps deno just used; it bundles them into
# the single file rather than embedding a runtime, so no restore needed yet.
echo "==> esbuild single-file todou.js (bring-your-own-Node)"
pnpm dlx "esbuild@$ESBUILD_VERSION" projects/cli/src/index.ts \
  --bundle --platform=node --format=cjs --outfile="$OUT/todou.js"
# dist/ has no package.json of its own, so it would otherwise inherit this
# repo's "type": "module" and Node would refuse the CJS bundle's syntax.
echo '{"type":"commonjs"}' >"$OUT/package.json"

echo "==> pnpm install (restoring devDependencies)"
CI=true pnpm install --frozen-lockfile

echo
echo "==> dist/ artifact sizes"
ls -lh "$OUT"
