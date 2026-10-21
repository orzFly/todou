# Codex

todou identifies Codex writes with `CODEX_THREAD_ID` and uses the `codex`
credential profile, falling back to `harness`. The CLI can also deliver tracker
activity to an existing Codex App Server conversation with `--follow=codex`.
No plugin installation or replacement Codex launcher is required.

## Connect the App to the Codex host

Use the App's supported [SSH remote connection](https://learn.chatgpt.com/docs/remote-connections)
and open a conversation on that host. Install todou and configure its login and
project on the same host and under the same OS account as Codex:

```sh
todou login https://todou.example --profile codex
todou agent can-i-follow
```

Run the second command from the Codex conversation so it inherits the thread id.
The advice checks local channel availability; the watch verifies the connection
and thread before delivering anything. Start at least one conversation turn
before attaching a watch, so Codex has created its saved conversation.

`--follow=codex` connects to the App's **existing** service. A standalone `codex`
terminal session does not become an App conversation through this option, and
starting a separate `codex app-server` would target a different service.

## Follow tracker activity

Run one of these on the remote host in a supervised terminal/process that stays
alive while the agent works:

```sh
todou issue watch T-16 --follow=codex
todou watch -p todou --follow=codex
```

The process must inherit `CODEX_THREAD_ID` from the intended conversation. If
starting from a separate terminal or supervisor, explicitly supply that
conversation's id; todou never guesses from the newest transcript. Use the same
`CODEX_HOME` as the App's remote service (default `~/.codex`). The default socket
is `$CODEX_HOME/app-server-control/app-server-control.sock`; an explicit absolute
`TODOU_CODEX_SOCKET` can select another local control socket.

The watch batches activity for 60 seconds by default; `--debounce 0` delivers
immediately. It carries comments, spec reviews, and question activity through
the existing project/issue watch filters, including exclusion of the current
session's own writes. Keep separate watches from overlapping if duplicate
notifications would be distracting.

Each batch arrives as `todou_watch` tool output in the same thread. Codex queues
it into an active turn or starts a turn when idle. The connected App receives
the thread's usual tool output, assistant messages, and progress events. The
watch never answers approval or input requests and never changes the thread's
model, sandbox, or approval policy; respond in the App when prompted. The App
controls the visual presentation of those events.

A background command's stdout alone does not wake Codex. If you cannot keep a
supervised watch running, use `--poll`, read its output, and resume from the
printed cursor. `--follow=stdout` remains available for consumers that read a
stream themselves. `todou agent opt-out-uds` applies to the separate UDS messaging
transport; Codex delivery always requires explicit `--follow=codex`.

## Disconnects and recovery

The watch binds to one thread and stops on connection loss or that thread's
close/archive notification. It does not reconnect to another conversation.
An unavailable socket, unloaded thread, or incompatible server fails the open
instead of launching another Codex process.

A successful RPC response confirms that Codex admitted the batch, not that the
agent finished acting on it. On missing confirmation, the watch stops and prints
unconfirmed events with their `since`/`cursor` range to stdout. Keep that output
in the supervisor's log. Delivery may already have occurred before a disconnect
or timeout: inspect the chat before replaying, rather than automatically
restarting from the older `since` value. After processing the printed events,
resume with `--since <cursor>`. Normal shutdown prints the latest cursor too.
SIGINT, SIGTERM, and SIGHUP flush pending output; SIGKILL or machine failure
cannot. A new watch without `--since` starts at the current position, so retain
the previous cursor when continuity matters.

## Compatibility and verification

The local WebSocket control socket and
[App Server protocol](https://learn.chatgpt.com/docs/app-server) were verified
with Codex CLI/App Server **0.154.0**. They are experimental interfaces; older
or future versions may need adjustments. The adapter requires `thread/read`,
`thread/resume`, and `turn/start` with `toolOutput`.

Tests cover same-thread delivery, active/idle states, rejection, disconnect,
missing acknowledgements, lifecycle notifications, and leaving approvals to
the App. A separate smoke check with the real server and a local mock model
verified idle turns, active-turn delivery, and notifications received by a
second subscribed client. This verifies protocol delivery; it does not replace
checking rendering in the particular App version used over SSH.
