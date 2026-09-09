#!/usr/bin/env bash
# End-to-end smoke for the omp integration (T-308), against a real omp.
#
# The unit tests cover both halves of the contract from this side: they write a
# state file and assert the reader believes or rejects it. What they cannot
# cover is whether omp *writes* one — whether the extension loads at all, which
# events actually fire, and whether a push reaches the agent. Every one of
# those fails silently: todou falls back to the session scan and reports an id
# that is merely usually right.
#
# So this drives the real thing. It needs a model, because the only way todou
# runs inside omp is for omp to decide to run it:
#
#   TODOU_SMOKE_OMP_MODEL=<provider/model> scripts/smoke-omp-integration.sh
#
# Pick one you are willing to spend on — each check is one short turn. Nothing
# here talks to a tracker: the detector is called directly and the push is sent
# with the CLI's own `openPeerPush`, so no server and no token are involved.
#
# Everything lands under a scratch HOME and a scratch XDG_RUNTIME_DIR, so a run
# cannot touch the extension you actually have installed.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2-}"; shift $(($# > 1 ? 2 : 1)) ;;
    --only=*) ONLY="${1#*=}"; shift ;;
    -h | --help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "usage: smoke-omp-integration.sh [--only <check>]" >&2; exit 2 ;;
  esac
done

command -v omp >/dev/null || { echo "omp is not on PATH" >&2; exit 2; }

WORK="$ROOT/.tmp/smoke-omp-$$"
HOME_DIR="$WORK/home"
PROJECT="$WORK/project"
# Not under $WORK: an agent sandbox refuses to bind a unix socket inside the
# repository, and the sender opens its receipt listener beside the target it
# dials — so a runtime directory here fails with EACCES while imitating the
# real degradation, a sandbox that blocks unix sockets outright.
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}/todou-smoke-$$"
# The extension makes this itself; made here too because check 5 dials a
# socket that is *absent from a directory that exists*, which is the shape a
# session that has exited leaves behind. Without the directory the sender
# fails to bind its own listener instead, which is a different failure.
mkdir -p "$HOME_DIR" "$PROJECT" "$RUNTIME/todou-omp"
trap 'rm -rf "$WORK" "$RUNTIME"' EXIT

FAILURES=0
SKIPS=0
ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
skip() { printf '  \033[33mskip\033[0m %s\n' "$1"; SKIPS=$((SKIPS + 1)); }
step() { printf '\n==> %s\n' "$1"; }
wanted() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# The detector, called the way a tool inside omp would reach it, plus the raw
# record so a mismatch says which side is wrong rather than only that they
# disagree. `scanned` is the same detector with the variable withheld — what
# todou sees on an omp with no extension — so a run says not just that the
# answer is right but whether the extension is what made it right.
cat > "$WORK/detect.mts" <<'PROBE'
import { readFileSync } from "node:fs";
import { detectAgentContext } from "../../projects/cli/src/harness/index.ts";

const statePath = process.env.TODOU_OMP_STATE;
const { TODOU_OMP_STATE: _withheld, ...withoutState } = process.env;
let record: unknown = null;
try {
  record = JSON.parse(readFileSync(statePath ?? "", "utf8"));
} catch {
  record = null;
}
console.log(
  JSON.stringify({
    detected: detectAgentContext(process.env),
    scanned: detectAgentContext(withoutState),
    state_path: statePath ?? null,
    socket: process.env.TODOU_MESSAGING_SOCKET ?? null,
    record,
  }),
);
PROBE

# The sender, which is the CLI's own — a hand-written frame would prove only
# that the extension parses hand-written frames.
cat > "$WORK/push.mts" <<'PUSH'
import { openPeerPush } from "../../projects/cli/src/peer-push.ts";

const [target, body] = process.argv.slice(2);
const push = await openPeerPush<string>({
  target: target as string,
  fromName: "todou-watch-smoke",
  render: (items) => items.join("\n"),
});
await push.send([body as string], "c0", "c1");
// One receipt window is what the sender itself waits before calling silence a
// delivery; a refusal arrives well inside it.
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(JSON.stringify({ rejected: push.rejected }));
push.close();
PUSH

# omp resolves `~` from HOME, and the extension puts its files under
# XDG_RUNTIME_DIR — both redirected so a run cannot reach the real ones.
omp_env() {
  env HOME="$HOME_DIR" XDG_RUNTIME_DIR="$RUNTIME" "$@"
}

# One print-mode turn whose whole job is to run one command. `--auto-approve`
# because there is nobody to approve it, `--no-title` because a title costs a
# second model call for nothing.
omp_run() { # <label> <command to run inside omp> [extra omp flags…]
  local label="$1" command="$2"
  shift 2
  omp_env omp -p --auto-approve --no-title --cwd "$PROJECT" \
    --model "$TODOU_SMOKE_OMP_MODEL" "$@" \
    "Run exactly this shell command, then stop and say nothing else: $command" \
    > "$WORK/$label.omp.log" 2>&1
}

json() { # <file> <jq-ish path via node>
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((o, k) => o?.[k], doc);
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1" "$2"
}

need_model() {
  if [ -z "${TODOU_SMOKE_OMP_MODEL:-}" ]; then
    skip "needs TODOU_SMOKE_OMP_MODEL (a model this run may spend on)"
    return 1
  fi
}

step "installing the extension into a scratch home"
INSTALLED="$HOME_DIR/.omp/agent/extensions/todou-omp-session.ts"
# Through the real command, and with the scratch home in its environment: an
# install performed by copying the asset here would not be testing the thing
# a user runs, and one performed against the developer's own home would edit
# the extension they are actually using.
omp_env node projects/cli/src/index.ts integration install omp \
  > "$WORK/install.log" 2>&1 < /dev/null
if [ -f "$INSTALLED" ]; then
  ok "installed at ${INSTALLED#"$WORK/"}"
else
  bad "install wrote nothing at $INSTALLED"
  cat "$WORK/install.log" >&2
fi

# 1 — the id todou reports, the record omp published, and the session log omp
#     actually opened all name the same session.
if wanted 1; then
  step "1. identification"
  if need_model; then
    omp_run one "node $WORK/detect.mts > $WORK/one.json"
    if [ -s "$WORK/one.json" ]; then
      DETECTED=$(json "$WORK/one.json" detected.session_id)
      RECORDED=$(json "$WORK/one.json" record.session_id)
      LOGGED=$(json "$WORK/one.json" record.session_file)
      AGENT=$(json "$WORK/one.json" detected.agent)
      [ "$AGENT" = omp ] || bad "reported agent $AGENT, not omp"
      if [ -n "$DETECTED" ] && [ "$DETECTED" = "$RECORDED" ]; then
        ok "todou and omp agree on $DETECTED"
      else
        bad "todou says '$DETECTED', the record says '$RECORDED'"
      fi
      case "$LOGGED" in
        *"$RECORDED".jsonl) ok "the record names omp's own session log" ;;
        *) bad "record names $LOGGED, which is not session $RECORDED" ;;
      esac
    else
      bad "the probe produced nothing; see $WORK/one.omp.log"
    fi
  fi
fi

# 2 — the card's own case: two instances on one project, which the scan cannot
#     resolve even in principle because the newest write is all it has.
if wanted 2; then
  step "2. two instances on one project"
  if need_model; then
    omp_run two_a "node $WORK/detect.mts > $WORK/two-a.json" &
    A=$!
    omp_run two_b "node $WORK/detect.mts > $WORK/two-b.json" &
    B=$!
    wait $A; wait $B
    if [ -s "$WORK/two-a.json" ] && [ -s "$WORK/two-b.json" ]; then
      IDA=$(json "$WORK/two-a.json" detected.session_id)
      IDB=$(json "$WORK/two-b.json" detected.session_id)
      RECA=$(json "$WORK/two-a.json" record.session_id)
      RECB=$(json "$WORK/two-b.json" record.session_id)
      if [ -n "$IDA" ] && [ "$IDA" = "$RECA" ] && [ "$IDB" = "$RECB" ]; then
        ok "each instance reports its own published session"
      else
        bad "a: '$IDA' vs '$RECA'; b: '$IDB' vs '$RECB'"
      fi
      if [ -n "$IDA" ] && [ "$IDA" != "$IDB" ]; then
        ok "the two are told apart ($IDA / $IDB)"
      else
        bad "both instances reported '$IDA'"
      fi
      # Not an assertion: the scan picks the most recently written session, so
      # with two instances it is right about one of them by construction and
      # may be right about both if the writes happened to interleave kindly.
      # Printed because a run where it agreed twice proves less than it looks.
      SCANA=$(json "$WORK/two-a.json" scanned.session_id)
      SCANB=$(json "$WORK/two-b.json" scanned.session_id)
      if [ "$SCANA" != "$IDA" ] || [ "$SCANB" != "$IDB" ]; then
        printf '       (the scan alone would have said %s / %s)\n' \
          "${SCANA:-nothing}" "${SCANB:-nothing}"
      else
        printf '       (the scan alone happened to agree this run)\n'
      fi
    else
      bad "one of the two probes produced nothing"
    fi
  fi
fi

# 3 — /new and /resume swap the session inside a running process, so the record
#     has to follow. Only a TUI emits session_switch, hence the pty.
if wanted 3; then
  step "3. /new and /resume inside a running session"
  if ! command -v script >/dev/null; then
    skip "needs script(1) to give omp a pty"
  elif need_model; then
    RECORDS="$WORK/switch.log"
    : > "$RECORDS"
    # Sampled from outside rather than asserted at the end: the record is
    # deleted on shutdown, so what it held while the session ran is only
    # observable while the session runs.
    (
      for _ in $(seq 1 90); do
        for file in "$RUNTIME"/todou-omp/*.json; do
          [ -f "$file" ] && cat "$file" >> "$RECORDS" && echo >> "$RECORDS"
        done
        sleep 1
      done
    ) &
    SAMPLER=$!
    ids() { grep -o '"session_id":"[^"]*"' "$RECORDS" | cut -d'"' -f4; }
    # A carriage return, not a newline: a pty's Enter is CR, and a newline
    # goes into omp's composer as a second line instead of submitting.
    {
      sleep 12
      # One real turn first: omp does not keep a session that was never
      # spoken to, so a `/new` out of an empty one discards it and the
      # `/resume` below would have nothing to find.
      printf 'Reply with the single word: ready\r'
      sleep 25
      # `/resume` opens a picker with no argument; the id the session started
      # with is already in the record, which is what makes this drivable.
      FIRST=$(ids | head -1)
      printf '/new\r'
      sleep 10
      printf '/resume %s\r' "$FIRST"
      sleep 12
      printf '/exit\r'
      sleep 3
    } | omp_env script -qc "omp --cwd '$PROJECT' --model '$TODOU_SMOKE_OMP_MODEL' --no-title" /dev/null \
      > "$WORK/switch.omp.log" 2>&1
    kill "$SAMPLER" 2>/dev/null
    wait "$SAMPLER" 2>/dev/null
    # The ids in the order the record held them, runs collapsed: A B A is a
    # `/new` away and a `/resume` back, which is the whole assertion. The
    # environment cannot express this — a variable is fixed for the life of
    # the process, so after a `/resume` it would name a session omp has left
    # while looking exactly as authoritative as before.
    SEQUENCE=$(ids | awk '$0 != prev { print } { prev = $0 }')
    COUNT=$(printf '%s\n' "$SEQUENCE" | grep -c .)
    FIRST=$(printf '%s\n' "$SEQUENCE" | sed -n 1p)
    SECOND=$(printf '%s\n' "$SEQUENCE" | sed -n 2p)
    THIRD=$(printf '%s\n' "$SEQUENCE" | sed -n 3p)
    if [ "$COUNT" -ge 2 ] && [ -n "$SECOND" ] && [ "$FIRST" != "$SECOND" ]; then
      ok "the record followed /new ($FIRST → $SECOND)"
    else
      bad "the record did not follow /new; saw ${SEQUENCE:-nothing}"
    fi
    if [ "$THIRD" = "$FIRST" ] && [ -n "$THIRD" ]; then
      ok "and followed /resume back to $THIRD"
    else
      bad "the record did not follow /resume back; third was '${THIRD:-none}'"
    fi
  fi
fi

# 4 — a push from the CLI's own sender reaches the agent, which is the half
#     that has no reader on this side at all.
if wanted 4; then
  step "4. a push reaches the session"
  if need_model; then
    MARK="todou-smoke-$$-delivered"
    # A turn long enough to push into: the extension's socket is up for as
    # long as the session is, and a print-mode session ends with its turn.
    omp_run push "sleep 25" &
    TURN=$!
    SOCKET=""
    for _ in $(seq 1 40); do
      SOCKET=$(ls "$RUNTIME"/todou-omp/*.sock 2>/dev/null | head -1)
      [ -n "$SOCKET" ] && break
      sleep 1
    done
    if [ -z "$SOCKET" ]; then
      bad "the extension never opened a socket"
      wait $TURN
    else
      sleep 3
      node "$WORK/push.mts" "$SOCKET" "$MARK" > "$WORK/push.json" 2>&1
      REJECTED=$(json "$WORK/push.json" rejected)
      [ -z "$REJECTED" ] && ok "the sender saw no refusal" \
        || bad "the sender was refused: $REJECTED"
      wait $TURN
      if grep -rqF "$MARK" "$HOME_DIR/.omp/agent/sessions" 2>/dev/null; then
        ok "the pushed text is in omp's session log"
      else
        bad "nothing carrying $MARK reached the session log"
      fi
    fi
  fi
fi

# 5 — and the failure is reported rather than passing as a delivery, which is
#     the mode this whole channel is built to avoid.
if wanted 5; then
  step "5. an unreachable session is reported, not assumed delivered"
  node "$WORK/push.mts" "$RUNTIME/todou-omp/nobody.sock" "unreachable" \
    > "$WORK/push-fail.json" 2>&1
  STATUS=$(json "$WORK/push-fail.json" rejected.status)
  if [ "$STATUS" = unreachable ]; then
    ok "reported unreachable"
  else
    bad "reported '${STATUS:-nothing}'; silence here reads as a delivery"
  fi
fi

# 6 — and with no extension the behaviour from before this card is untouched,
#     which is the state every omp that has not run the install is in.
if wanted 6; then
  step "6. an omp without the extension still resolves a session"
  if need_model; then
    omp_run bare "node $WORK/detect.mts > $WORK/bare.json" --no-extensions
    if [ -s "$WORK/bare.json" ]; then
      AGENT=$(json "$WORK/bare.json" detected.agent)
      ID=$(json "$WORK/bare.json" detected.session_id)
      STATE=$(json "$WORK/bare.json" state_path)
      [ -z "$STATE" ] || bad "the extension published a record with --no-extensions"
      if [ "$AGENT" = omp ] && [ -n "$ID" ]; then
        ok "the scan still answers ($ID)"
      else
        bad "reported agent '$AGENT', session '${ID:-none}'"
      fi
    else
      bad "the probe produced nothing; see $WORK/bare.omp.log"
    fi
  fi
fi

printf '\n'
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed; scratch tree kept at $WORK"
  # The logs and probe output are worth keeping; the sockets under the runtime
  # directory are not, and leaving them behind would grow one stale directory
  # per failed run in a place nothing cleans.
  trap 'rm -rf "$RUNTIME"' EXIT
  exit 1
fi
[ "$SKIPS" -gt 0 ] && echo "$SKIPS check(s) skipped"
echo "omp integration smoke passed"
