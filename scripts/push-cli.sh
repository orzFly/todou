#!/usr/bin/env bash
# Build the CLI artifacts here, pack them, and stage the result on a deployment
# host for its deploy.sh to activate (T-170). Without this, a checkout
# deployment's /api/cli keeps advertising whatever version it was last packed
# at — never the one deploy.sh has just pulled.
#
# The build belongs on a dev machine: the host runs the server and has neither
# deno nor zstd, and installing them would turn a runtime into a build machine.
#
# The same goes for the checking. A non-interactive ssh lands on a PATH like
# /usr/local/bin:/usr/bin:/bin:/usr/games, and a per-user toolchain — mise,
# nvm, asdf — is on none of it; the unit reaches its own node by absolute path.
# So every step that reads a manifest runs here, and the host is asked for
# nothing but coreutils. The preflight below states that requirement out loud
# instead of discovering it halfway through an upload. The whole sequence,
# host side included, is in docs/deploy.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

usage() {
  cat >&2 <<'EOF'
usage: scripts/push-cli.sh [user@]host [options]
  host               the deployment host; TODOU_DEPLOY_HOST is used when the
                     argument is omitted
  --data-dir <path>  remote data directory, relative to the remote home
                     (default: todou-data)
  --checkout <path>  remote checkout (default: todou); read for the version
                     comparison under --activate
  --deploy-script <path>
                     the host's update script, relative to the remote home
                     (default: deploy.sh). The preflight reads it and warns
                     when it carries no cli-dist activation step; empty turns
                     that warning off.
  --activate         swap the drop in, restart the unit and compare the served
                     version here, instead of leaving all three to deploy.sh
  --force            build and upload even when HEAD is off origin/master, the
                     tree is dirty, or the host already holds this drop
  --dry-run          print every state-changing command instead of running it;
                     failed preconditions warn only. The remote preflight is
                     still carried out for real — it reads nothing and it is
                     the half a rehearsal is worth having.

TODOU_DEPLOY_PORT (default 8637) is the port --activate polls on the host.
Remote paths reach a shell as written: keep them free of spaces and glob
characters.
EOF
  exit 2
}

HOST=""
DATA_DIR=todou-data
CHECKOUT=todou
DEPLOY_SCRIPT=deploy.sh
ACTIVATE=0
FORCE=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --checkout) CHECKOUT="${2:?}"; shift 2 ;;
    # Not :? — an empty value is how the check is turned off.
    --deploy-script) DEPLOY_SCRIPT="${2?}"; shift 2 ;;
    --activate) ACTIVATE=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) usage ;;
    *) [ -z "$HOST" ] || usage; HOST="$1"; shift ;;
  esac
done
HOST="${HOST:-${TODOU_DEPLOY_HOST:-}}"
[ -n "$HOST" ] || usage
PORT="${TODOU_DEPLOY_PORT:-8637}"

# Same contract as release.sh: preconditions warn instead of aborting under
# --dry-run, so the full command sequence can be rehearsed from any branch.
fail() {
  if [ "$DRY_RUN" = 1 ]; then echo "warn (dry-run): $*" >&2
  else echo "error: $*" >&2; exit 1; fi
}

# Quote a value for the remote shell, which sees each ssh command as one
# string. scp is deliberately left unquoted: since OpenSSH 9 it speaks SFTP
# rather than a remote shell, where quotes would become part of the file name.
rq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Echoed quoted the way a shell would need it, so a dry run's output pastes back.
run() {
  local shown="" a
  for a in "$@"; do
    case "$a" in *[!A-Za-z0-9_@%+=:,./-]*) a="$(rq "$a")" ;; esac
    shown="$shown $a"
  done
  echo "+$shown"
  [ "$DRY_RUN" = 1 ] || "$@"
}

for tool in git pnpm deno zstd node ssh scp; do
  command -v "$tool" >/dev/null \
    || { echo "error: $tool is not on PATH — build on a dev machine" >&2; exit 1; }
done

REMOTE_TOOLS="cat find mkdir mv rm wc"
if [ "$ACTIVATE" = 1 ]; then
  REMOTE_TOOLS="$REMOTE_TOOLS curl git seq sleep systemctl"
fi
PROBE="echo \"path: \$PATH\"
for c in $REMOTE_TOOLS; do command -v \$c >/dev/null || echo \"missing: \$c\"; done"
if [ "$ACTIVATE" = 1 ]; then
  # Reachability, not liveness: a stopped unit still answers. What this catches
  # is a session bus the non-interactive ssh cannot see, which would make the
  # restart fail after the drop is already live.
  PROBE="$PROBE
systemctl --user show -p Id --value todou >/dev/null 2>&1 \
  || echo \"missing: a usable 'systemctl --user' (no session bus over ssh?)\""
elif [ -n "$DEPLOY_SCRIPT" ]; then
  # The failure this exists for is silent on both ends: a host whose update
  # script never grew the activation step takes the drop, leaves it staged
  # forever, and goes on serving the CLI it served before. Nothing downstream
  # notices, because a stale /api/cli answers exactly like a current one.
  # Read with cat and matched by the shell, so the host is still asked for
  # nothing but the tools the probe already requires.
  PROBE="$PROBE
if [ -f $(rq "$DEPLOY_SCRIPT") ]; then
  case \"\$(cat $(rq "$DEPLOY_SCRIPT"))\" in
    *cli-dist*) ;;
    *) echo \"note: $DEPLOY_SCRIPT has no cli-dist activation step - this drop\
 will stay staged (see docs/deploy.md, Updating)\" ;;
  esac
fi"
fi

echo "+ ssh $HOST <preflight: $REMOTE_TOOLS>"
REPORT="$(ssh "$HOST" "$PROBE")" \
  || { echo "error: cannot reach $HOST over ssh" >&2; exit 1; }
if printf '%s\n' "$REPORT" | grep -q '^missing: '; then
  echo "error: $HOST cannot run this script's remote half:" >&2
  printf '%s\n' "$REPORT" | sed 's/^/  /' >&2
  exit 1
fi
# Advisory, never fatal: this script cannot know how a host activates a drop —
# docker images carry their own, and --activate does it from here.
printf '%s\n' "$REPORT" | sed -n "s|^note: |warn: $HOST:|p" >&2

# build-cli.sh stages the working tree through `git ls-files` and bakes
# `git describe` into every artifact, so uncommitted edits and a HEAD off
# origin/master both produce a drop whose version lies about what the host
# will be running.
if [ "$FORCE" = 1 ]; then
  echo "warn: --force — building whatever the working tree currently holds" >&2
else
  git fetch origin master
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] \
    || fail "HEAD is not origin/master — deploy.sh will pull past this build"
  [ -z "$(git status --porcelain --untracked-files=no)" ] \
    || fail "tracked files have uncommitted changes"
fi

VERSION="${TODOU_BUILD_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/todou-push-cli.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
STAGING="$WORK/cli-dist"
REMOTE_MANIFEST="$WORK/remote-manifest.json"
REMOTE_STAGE="$DATA_DIR/cli-dist.staging.$$"

# The same check the server makes at startup (cli-dist.ts) — every artifact
# present at exactly the size the manifest declares — plus the reverse, that
# nothing else is in the directory. The host contributes one `wc -c` per file
# and this side does the judging, so an artifact still in flight, or one that
# never arrived, cannot reach cli-dist.new and take the boot down with it.
CHECK_DROP_JS='
const fs = require("node:fs");
const [manifestPath, manifestBytes, listing] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const want = new Map(m.artifacts.map((a) => [a.name + ".zst", a.compressed_size]));
want.set("manifest.json", Number(manifestBytes));
const got = new Map();
for (const line of listing.split("\n")) {
  const cut = line.indexOf(" ");
  if (cut > 0) got.set(line.slice(cut + 1), Number(line.slice(0, cut)));
}
const bad = [];
for (const [name, size] of want) {
  if (!got.has(name)) bad.push(name + " never arrived");
  else if (got.get(name) !== size)
    bad.push(name + " is " + got.get(name) + " bytes, the manifest declares " + size);
}
for (const name of got.keys())
  if (!want.has(name)) bad.push(name + " does not belong to this drop");
if (bad.length) { console.error("incomplete drop:\n  " + bad.join("\n  ")); process.exit(1); }
console.log("verified " + m.artifacts.length + " artifacts at version " + m.version);
'

# Applied to manifests read back from the host, always in a local node: the
# host is asked for the bytes, never for an opinion about them.
MANIFEST_VERSION_JS='JSON.parse(require("fs").readFileSync(0, "utf8")).version'

REMOTE_SOURCE=""
fetch_remote_manifest() {
  # A cli-dist.new only exists once the verification below has passed, so it is
  # the authority on what the host holds; cli-dist is what it currently serves.
  for d in cli-dist.new cli-dist; do
    if ssh "$HOST" "cat $(rq "$DATA_DIR/$d/manifest.json")" >"$REMOTE_MANIFEST" 2>/dev/null; then
      REMOTE_SOURCE="$d"
      return 0
    fi
  done
  return 1
}

verify_remote_drop() { # <remote dir>
  echo "+ ssh $HOST 'cd $1 && wc -c *'"
  local listing
  listing="$(ssh "$HOST" "cd $(rq "$1") || exit 1
for f in *; do [ -f \"\$f\" ] || continue; printf '%s %s\n' \$(wc -c <\"\$f\") \"\$f\"; done")" \
    || return 1
  node -e "$CHECK_DROP_JS" "$STAGING/manifest.json" \
    "$(wc -c <"$STAGING/manifest.json")" "$listing"
}

announce_skip() {
  if [ "$REMOTE_SOURCE" = cli-dist.new ]; then
    echo "$VERSION is already staged on $HOST — run deploy.sh there to activate it"
  else
    echo "$HOST already serves $VERSION — nothing to push"
  fi
}

# The version is compared before the build, not after: a re-run over an
# interrupted deploy is the case this exists for, and it should not cost a
# build first. The version is enough to identify the bytes here — the
# preconditions above pin it to one commit's content, and --force, the one way
# to reuse a version string, ignores this skip.
if [ "$DRY_RUN" = 1 ]; then
  echo "+ ssh $HOST cat $DATA_DIR/cli-dist.new/manifest.json || cat $DATA_DIR/cli-dist/manifest.json"
elif [ "$FORCE" = 0 ]; then
  if fetch_remote_manifest \
    && [ "$(node -p "$MANIFEST_VERSION_JS" <"$REMOTE_MANIFEST" 2>/dev/null)" = "$VERSION" ]; then
    announce_skip
    exit 0
  fi
fi

run scripts/build-cli.sh
run scripts/pack-cli.sh dist "$STAGING"

run ssh "$HOST" "find $(rq "$DATA_DIR") -maxdepth 1 -name 'cli-dist.staging.*' -exec rm -rf {} + 2>/dev/null; mkdir -p $(rq "$REMOTE_STAGE")"
# The manifest lands last: it is what makes the directory self-describing, and
# what both the verification below and deploy.sh read to decide it is complete.
run scp -q "$STAGING"/*.zst "$HOST:$REMOTE_STAGE/"
run scp -q "$STAGING/manifest.json" "$HOST:$REMOTE_STAGE/"

if [ "$DRY_RUN" = 1 ]; then
  echo "+ ssh $HOST 'cd $REMOTE_STAGE && wc -c *'   # compared against the manifest here"
elif ! verify_remote_drop "$REMOTE_STAGE"; then
  run ssh "$HOST" "rm -rf $(rq "$REMOTE_STAGE")"
  fail "the upload to $HOST is incomplete — nothing was staged"
fi

# rename(2) is atomic, so deploy.sh only ever sees a complete cli-dist.new.
run ssh "$HOST" "rm -rf $(rq "$DATA_DIR/cli-dist.new") && mv $(rq "$REMOTE_STAGE") $(rq "$DATA_DIR/cli-dist.new")"

if [ "$ACTIVATE" = 0 ]; then
  echo
  echo "staged $VERSION on $HOST as $DATA_DIR/cli-dist.new"
  echo "next: run deploy.sh on the host — it activates the drop before its restart"
  exit 0
fi

# Same sequence deploy.sh runs, for a CLI-only refresh that skips a deploy.
# cli-dist.old survives until the served version has been confirmed.
if [ "$DRY_RUN" = 1 ]; then
  echo "+ ssh $HOST 'cd $DATA_DIR/cli-dist.new && wc -c *'"
else
  verify_remote_drop "$DATA_DIR/cli-dist.new"
fi
run ssh "$HOST" "d=$(rq "$DATA_DIR"); rm -rf \"\$d/cli-dist.old\"; if [ -d \"\$d/cli-dist\" ]; then mv \"\$d/cli-dist\" \"\$d/cli-dist.old\" || exit 1; fi; mv \"\$d/cli-dist.new\" \"\$d/cli-dist\""
run ssh "$HOST" "systemctl --user restart todou"

if [ "$DRY_RUN" = 1 ]; then
  echo "+ ssh $HOST curl -fsS localhost:$PORT/api/cli   # compare .version with git describe"
  echo "+ ssh $HOST rm -rf $DATA_DIR/cli-dist.old       # only once they match"
  echo
  echo "dry-run complete — nothing was changed."
  exit 0
fi

deployed=""
deployed="$(ssh "$HOST" "git -C $(rq "$CHECKOUT") describe --tags --always")" || deployed=""
served=""
served="$(ssh "$HOST" "for _ in \$(seq 30); do curl -fsS localhost:$PORT/api/cli && exit 0; sleep 1; done; exit 1" \
  | node -p "$MANIFEST_VERSION_JS" 2>/dev/null)" || served=""

if [ -z "$served" ] || [ "$served" != "$deployed" ]; then
  echo "ALARM: /api/cli serves ${served:-nothing} but $CHECKOUT is at ${deployed:-unknown}" >&2
  echo "       $DATA_DIR/cli-dist.old is kept — restore it if the server refused to boot," >&2
  echo "       otherwise rebuild from the deployed commit and rerun this script" >&2
  exit 1
fi

run ssh "$HOST" "rm -rf $(rq "$DATA_DIR/cli-dist.old")"
echo
echo "$HOST now serves $served"
