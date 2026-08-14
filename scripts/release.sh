#!/usr/bin/env bash
# Cut a release: verify preconditions, bump the five package.json versions,
# commit, tag, push. Artifacts, the GitHub release and the images are CI's
# job (release.yaml / docker.yaml, triggered by the tag landing on the
# mirror) — this script only moves git state. Full process: docs/release.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat >&2 <<'EOF'
usage: scripts/release.sh <x.y.z> --tag-message-file <file> [options]
  --tag-message-file <file>  annotated-tag body: a title line + short prose
  --co-author "Name <email>" append a Co-Authored-By trailer (agent runs)
  --dry-run                  print every state-changing command instead of
                             running it; failed preconditions warn only
EOF
  exit 2
}

VERSION="${1:-}"
[ -n "$VERSION" ] || usage
shift
TAG_MSG_FILE=""
CO_AUTHOR=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag-message-file) TAG_MSG_FILE="${2:?}"; shift 2 ;;
    --co-author) CO_AUTHOR="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage ;;
  esac
done
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "error: version must be x.y.z" >&2; exit 2; }
[ -n "$TAG_MSG_FILE" ] || usage

TAG="v$VERSION"
NOTES="docs/releases/$TAG.md"
PACKAGES="package.json
projects/cli/package.json
projects/server/package.json
projects/shared/package.json
projects/web/package.json"

# Preconditions warn instead of aborting under --dry-run so the full command
# sequence can be rehearsed from any branch.
fail() {
  if [ "$DRY_RUN" = 1 ]; then echo "warn (dry-run): $*" >&2
  else echo "error: $*" >&2; exit 1; fi
}

run() {
  echo "+ $*"
  [ "$DRY_RUN" = 1 ] || "$@"
}

[ "$(git symbolic-ref --short HEAD)" = "master" ] \
  || fail "not on master"
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || fail "tracked files have uncommitted changes"
git fetch origin master
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] \
  || fail "HEAD is not origin/master — pull or push first"
[ -f "$NOTES" ] \
  || fail "$NOTES missing — the release notes are a precondition, not an afterthought"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "tag $TAG already exists"
fi
[ -s "$TAG_MSG_FILE" ] \
  || fail "tag message file is missing or empty: $TAG_MSG_FILE"

# Plain JSON rewrite keeps biome's formatting (2-space indent, trailing
# newline); `pnpm lint` below is the read-only proof nothing broke.
BUMP_JS='const fs=require("node:fs");const[f,v]=process.argv.slice(1);
const pkg=JSON.parse(fs.readFileSync(f,"utf8"));pkg.version=v;
fs.writeFileSync(f,JSON.stringify(pkg,null,2)+"\n");'
for f in $PACKAGES; do
  run node -e "$BUMP_JS" "$f" "$VERSION"
done
run pnpm lint

# $PACKAGES expands unquoted on purpose: a fixed, space-free file list.
run git add $PACKAGES "$NOTES"
if [ -n "$CO_AUTHOR" ]; then
  run git commit -m "chore(release): $TAG" -m "Co-Authored-By: $CO_AUTHOR"
else
  run git commit -m "chore(release): $TAG"
fi
run git tag -a "$TAG" -F "$TAG_MSG_FILE"

# Authority first: origin is the archive of record, the GitHub mirror is what
# triggers release.yaml and docker.yaml. Only master and release tags ever go
# to the mirror.
run git push origin master "$TAG"
run git push github master "$TAG"

echo
if [ "$DRY_RUN" = 1 ]; then
  echo "dry-run complete — nothing was changed."
else
  echo "pushed $TAG — CI builds the artifacts, release and images from here."
  echo "next: deploy and verify (docs/release.md)."
fi
