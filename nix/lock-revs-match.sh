#!/usr/bin/env bash
# The two flakes have to build against one nixpkgs. Upgrading it takes two
# commands — `nix flake update nixpkgs --flake ./.nix`, then `nix flake update
# dev` — and stopping after the first leaves the package flake on the old
# revision without any error.
#
# The two arguments exist so the check can be pointed at fixture lock files to
# confirm it still reports a mismatch.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEV_LOCK="${1:-$REPO_ROOT/.nix/flake.lock}"
ROOT_LOCK="${2:-$REPO_ROOT/flake.lock}"

# nix rather than jq: the devshell carries no jq, while anywhere this check
# means anything already has nix.
rev_of() { # <lockfile>
  nix --extra-experimental-features nix-command eval --impure --raw \
    --expr "(builtins.fromJSON (builtins.readFile \"$(readlink -f "$1")\")).nodes.nixpkgs.locked.rev"
}

dev_rev=$(rev_of "$DEV_LOCK")
root_rev=$(rev_of "$ROOT_LOCK")

if [ "$dev_rev" != "$root_rev" ]; then
  echo "the two lock files pin different nixpkgs revisions:" >&2
  echo "  $DEV_LOCK: $dev_rev" >&2
  echo "  $ROOT_LOCK: $root_rev" >&2
  exit 1
fi

echo "both lock files pin nixpkgs $dev_rev"
