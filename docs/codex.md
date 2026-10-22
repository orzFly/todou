# Codex

todou identifies Codex writes with `CODEX_THREAD_ID` and uses the `codex`
credential profile, falling back to `harness`. `--follow=codex` delivers
tracker activity into the Codex conversation the watch was started from. No
plugin installation or replacement Codex launcher is required.

```sh
todou login https://todou.example --profile codex
todou agent can-i-follow
```

Run the second command from the Codex conversation so it inherits the thread
id. It names the channel this conversation has, or says there is none.

## Next-turn delivery

`--follow=codex` uses **`codex queue`** in both the App (including over SSH)
and the terminal TUI. It runs the executable at an absolute `TODOU_CODEX_BIN`,
or the first executable `codex` on an absolute PATH entry. Use the same OS
account and `CODEX_HOME` as the target conversation.

Codex stores each batch in its own state database. Its server checks the queue
periodically (about ten seconds in 0.154.0) and starts a new turn when the
conversation is idle. A batch arriving while the agent works on one card waits
for that turn to finish, including updates to the card currently being worked
on. Use the App or terminal directly for an urgent stop or correction. This
also avoids a race between a watcher checking for idle and another client
starting work.

Earlier versions preferred the App Server socket and injected batches into an
active turn. The agent could finish its current card and end that turn without
acting on the other cards. The watch now always queues; `TODOU_CODEX_SOCKET`
no longer selects a delivery channel. A missing or failing queue command does
not fall back to mid-turn delivery. Install a compatible Codex CLI, set
`TODOU_CODEX_BIN`, or use `--poll`.

Queued tracker text remains task data, not additional authority. The watch
never changes the model, approvals or sandbox, and never starts a replacement
agent conversation.

## Follow tracker activity

```sh
todou issue watch T-16 --follow=codex
todou watch -p todou --follow=codex
```

Start the watch from the conversation, with `exec_command`, and leave it
running when the call returns: Codex keeps a command it started running after
the turn ends, and stops it only on `/stop`, when the session ends, or once
more than 64 are running. From a separate terminal or supervisor, set
`CODEX_THREAD_ID` to the conversation's id and `CODEX_HOME` to the one Codex
uses; todou never guesses from the newest transcript.

Start at least one turn before attaching a watch, so Codex has saved the
conversation that `codex queue` looks up.

The watch batches activity for 60 seconds by default; `--debounce 0` queues
immediately; Codex still controls when the queued turn starts. It carries
comments, spec reviews, and question activity through the existing project/issue
watch filters, including exclusion of the current
session's own writes. Keep separate watches from overlapping if duplicate
notifications would be distracting.

A background command's output alone does not wake Codex, and neither does its
exit. That is why `--follow=stdout` is no substitute here: where the queue
command is unavailable, use `--poll`, read its output, and resume from the printed
cursor.

## Sandboxes

Under Codex's `workspace-write` sandbox, network access is off unless the
configuration turns it on, and `CODEX_HOME` is outside the writable roots. The
first stops every todou command, not only watches; the second stops `codex
queue` from filing a message. A watch that cannot deliver stops and says so.

## Disconnects and recovery

The watch binds to one thread and does not move to another conversation.
It stops on the first message the queue command does not confirm for the
requested thread. Do not leave a watch running after retiring its conversation;
it does not subscribe to App socket close/archive notifications.

Confirmation means Codex stored the batch, not that a turn ran or the agent
acted on every entry. Already queued batches survive the watch exiting, but
require Codex to load and run the target conversation. On missing confirmation,
the watch stops and prints the unconfirmed events with their `since`/`cursor`
range to stdout. Delivery may already have occurred before a disconnect or
timeout: inspect the chat before replaying, rather than automatically
restarting from the older `since` value. After processing the printed events,
resume with `--since <cursor>`. Normal shutdown prints the latest cursor too.
SIGINT, SIGTERM, and SIGHUP flush pending output; SIGKILL or machine failure
cannot. A new watch without `--since` starts at the current position, so retain
the previous cursor when continuity matters.

The watch never answers approval or input requests and never changes the
thread's model, sandbox, or approval policy; respond in Codex when prompted.

## Handling a batch

Read the `todou-cli` skill before acting. Group entries by card and verify
current ownership, discussion and review state for every affected card. Continue
only work authorized for this session. A `changes_requested` verdict calls for
reading unresolved annotations and revising the design; it does not authorize
implementation. A dependency blocking implementation need not block design work.

Before ending the turn, account for all cards in the batch: handled, waiting
for approval, blocked, or outside this session's scope. Do not stop merely
because the first card is finished. Record necessary results on the tracker;
when there is nothing actionable, end quietly. Keep the existing watch as the
source of future wake-ups rather than starting another monitor or waiting for
review inside the agent turn.

The queue guarantees a later opportunity to handle the batch; it is not an
application-level completion receipt. An agent can still overlook an entry or
misjudge its scope. Do not replay admitted batches merely because there is no
comment: work may already have happened, or no action was authorized.

## Compatibility and verification

`codex queue` was verified against Codex CLI **0.154.0**. This is a young CLI
interface that later versions may change.

`node scripts/codex-follow-smoke.mjs` runs a real Codex app-server against a
scripted stand-in for the model and a local todou server. It verifies idle
queue delivery, continuous cursors, and activity for a different card arriving
while a turn is busy: the active turn finishes first, then the queued batch
starts a new turn even after the watcher exits. The busy case exposes a real
App socket as well, guarding against a regression to socket-first delivery.
`--mutate queue` and `--mutate busy` deliberately break admission and the
busy setup respectively; each run must fail.
