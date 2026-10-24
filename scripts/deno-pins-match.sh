#!/usr/bin/env bash
# Every place that compiles the CLI has to compile it with one deno: the
# GitHub release (release.yaml), the docker image's /api/cli builds
# (Dockerfile), CI's preview artifacts (ci.yaml) and dev machines that run
# push-cli.sh (.nix/deno.nix). A different deno is a different executable, and
# `todou upgrade` installs a server's build without asking only when its sha256
# matches the GitHub release's (T-570) — so a drifted pin silently turns every
# such upgrade into a trust prompt.
#
# The argument exists so the check can be pointed at a doctored copy of the
# tree to confirm it still reports a mismatch.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

want="$(sed -n 's/^ *version = "\([^"]*\)";.*/\1/p' "$ROOT/.nix/deno.nix")"
[ -n "$want" ] || { echo "no version in .nix/deno.nix" >&2; exit 1; }

bad=0
check() { # <file> <found>
  if [ "$2" != "$want" ]; then
    echo "$1 pins deno ${2:-<nothing>}, .nix/deno.nix pins $want" >&2
    bad=1
  fi
}

check Dockerfile "$(sed -n 's|.*denoland/deno:bin-\([^ ]*\) .*|\1|p' "$ROOT/Dockerfile")"
for wf in release.yaml ci.yaml; do
  found="$(sed -n 's/^ *deno-version: *v\{0,1\}\([^ ]*\).*/\1/p' "$ROOT/.github/workflows/$wf")"
  [ -n "$found" ] || found=""
  # One line per setup-deno step; each has to agree.
  while IFS= read -r v; do check ".github/workflows/$wf" "$v"; done <<EOF
$found
EOF
done

[ "$bad" = 0 ] || exit 1
echo "every CLI build pins deno $want"
