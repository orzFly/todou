#!/usr/bin/env bash
# Compress the CLI artifacts from scripts/build-cli.sh into the layout the
# server's `http.cli_dist_dir` serves (T-146): one zstd frame per artifact
# plus a manifest carrying each one's uncompressed size and sha256.
#
# Usage: pack-cli.sh [indir] <outdir>        (indir defaults to dist)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

case $# in
  1) IN=dist; OUT="$1" ;;
  2) IN="$1"; OUT="$2" ;;
  *) echo "usage: pack-cli.sh [indir] <outdir>" >&2; exit 2 ;;
esac

# The build runs on CI runners and inside a docker stage, both of which can
# install zstd; a node reimplementation would buy nothing at build time.
command -v zstd >/dev/null || {
  echo "pack-cli.sh: zstd is required (apt-get install zstd)" >&2
  exit 1
}

VERSION="${TODOU_BUILD_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
fi

# name:os:arch:kind:runtime — the five names are build-cli.sh's own contract.
# Plain string pairs rather than `declare -A` for the same reason as there:
# associative arrays need bash 4, and macOS still ships bash 3.2.
ARTIFACTS="
todou-linux-amd64:linux:amd64:binary:
todou-linux-arm64:linux:arm64:binary:
todou-macos-arm64:darwin:arm64:binary:
todou-windows-amd64.exe:windows:amd64:binary:
todou.cjs:any:any:script:node>=20.12
"

mkdir -p "$OUT"
# Idempotent: a stale .zst from an earlier artifact set would otherwise
# survive next to a manifest that no longer lists it.
rm -f "$OUT"/*.zst "$OUT/manifest.json"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

NL=$'\n'
entries=""
while IFS=: read -r name os arch kind runtime; do
  [ -n "$name" ] || continue
  src="$IN/$name"
  [ -f "$src" ] || { echo "pack-cli.sh: missing artifact $src" >&2; exit 1; }

  echo "==> $name"
  zstd -19 -T0 -q -f -o "$OUT/$name.zst" "$src"

  size="$(wc -c < "$src" | tr -d ' ')"
  compressed="$(wc -c < "$OUT/$name.zst" | tr -d ' ')"
  sha="$(sha256sum "$src" | cut -d' ' -f1)"
  printf '  %s -> %s bytes (%s%%)\n' "$size" "$compressed" \
    "$((compressed * 100 / size))"

  entry="$(printf '    {"name": "%s", "os": "%s", "arch": "%s", "kind": "%s",' \
    "$(json_escape "$name")" "$os" "$arch" "$kind")"
  if [ -n "$runtime" ]; then
    entry="$entry$(printf ' "runtime": "%s",' "$(json_escape "$runtime")")"
  fi
  entry="$entry$(printf '\n     "size": %s, "compressed_size": %s, "sha256": "%s"}' \
    "$size" "$compressed" "$sha")"
  entries="${entries:+$entries,$NL}$entry"
done <<EOF
$ARTIFACTS
EOF

{
  printf '{\n  "version": "%s",\n  "artifacts": [\n' "$(json_escape "$VERSION")"
  printf '%s\n' "$entries"
  printf '  ]\n}\n'
} > "$OUT/manifest.json"

echo
echo "==> $OUT (version $VERSION)"
ls -lh "$OUT"
