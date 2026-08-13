#!/usr/bin/env bash
# Single source of truth for the container image reference, shared by the
# Docker workflow and local builds:
#
#   podman build -t "$(scripts/docker-image-ref.sh):dev" .
#
# The workflow's first attempt used ${{ github.repository }} directly, which
# expands with the owner's original casing (orzFly) — but registry references
# must be lowercase, so every buildx push failed. Deriving the name here, from
# the same repository field package.json already publishes, means a bad
# reference fails a local build with the identical error instead of only
# surfacing on GitHub.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node -p '"ghcr.io/" + require("./package.json").repository.replace(/^github:/, "").toLowerCase()'
