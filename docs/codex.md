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

## Two channels

`--follow=codex` reaches the thread one of two ways, and picks the first that
works:

1. **The App Server's control socket**, at
   `$CODEX_HOME/app-server-control/app-server-control.sock` (default
   `~/.codex`; an absolute `TODOU_CODEX_SOCKET` selects another). It exists
   when a Codex app-server daemon runs on this host: the App connected over
   [SSH](https://learn.chatgpt.com/docs/remote-connections), or `codex app-server
   daemon start`, after which a `codex` TUI started on the same host attaches
   to that daemon instead of running its own server. Each batch arrives as
   `todou_watch` tool output. A batch that arrives while a turn is running is
   added to that turn; on an idle thread it starts one.
2. **`codex queue`**, run from `TODOU_CODEX_BIN` or the first `codex` on
   PATH. This reaches a plain `codex` TUI too, which has no socket anyone else
   can dial: the command files the message in Codex's state database, and every
   Codex server checks that database every ten seconds. A batch that arrives
   while a turn is running waits for that turn to end, then starts the next one.

The socket is tried first because it can reach a running turn. When it refuses
the thread — a daemon that started after the TUI holding the conversation does
not hold it — the watch says so on stderr and uses `codex queue`.

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

The watch batches activity for 60 seconds by default; `--debounce 0` delivers
immediately. It carries comments, spec reviews, and question activity through
the existing project/issue watch filters, including exclusion of the current
session's own writes. Keep separate watches from overlapping if duplicate
notifications would be distracting.

A background command's output alone does not wake Codex, and neither does its
exit. That is why `--follow=stdout` is no substitute here: where neither
channel exists, use `--poll`, read its output, and resume from the printed
cursor.

## Sandboxes

Under Codex's `workspace-write` sandbox, network access is off unless the
configuration turns it on, and `CODEX_HOME` is outside the writable roots. The
first stops every todou command, not only watches; the second stops `codex
queue` from filing a message. A watch that cannot deliver stops and says so.

## Disconnects and recovery

The watch binds to one thread and does not move to another conversation.
Over the socket it stops on connection loss or on that thread's close/archive
notification; through `codex queue` it stops on the first message the command
does not confirm.

Confirmation means Codex admitted the batch — a turn started or steered, or a
message stored — not that the agent has acted on it. On missing confirmation,
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

## Compatibility and verification

Both channels were verified against Codex CLI **0.154.0**. The control socket
speaks the [App Server protocol](https://learn.chatgpt.com/docs/app-server),
whose `turn/start` with `toolOutput` this needs; `codex queue` is a CLI
command of the same release. Both are young interfaces that later versions may
change.

`node scripts/codex-follow-smoke.mjs` runs a real `codex app-server` against a
scripted stand-in for the model and a local todou server, and checks what the
model is sent: a comment reaching an idle thread through `codex queue`, a
comment posted mid-turn landing in that turn through the socket, and each
batch's `since:` continuing the previous `cursor:`. `--mutate queue` and
`--mutate steer` break one input each, and the run must then fail.
