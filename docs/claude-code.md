# todou × Claude Code

The `todou` CLI recognizes when it runs inside a Claude Code session and
does two things automatically — no flags, no configuration:

1. **Token selection.** If the server has a token stored under the
   `claude-code` profile, it is used instead of the default token:

   ```bash
   todou login https://todou.example --profile claude-code
   ```

   Claude Code sets `CLAUDECODE=1` in every shell it spawns, which is what
   triggers the auto-selection. Your own shell keeps using the default
   token. A profile named `harness` serves *every* harness, for a fleet
   that shares one machine account; `claude-code` wins wherever both
   exist. Precedence: `--profile` > `TODOU_TOKEN` > `TODOU_PROFILE` >
   `claude-code` > `harness` > default token (`--profile default` opts
   out). Neither auto rule applies outside a harness.

2. **Provenance metadata.** Every write (comments, issue events) carries
   an `X-Todou-Agent-Context` header recording
   `{ agent: "claude-code", session_id, model }`. The server stores it on
   the affected comments/events, the API returns it on timeline items, and
   the web timeline shows it as a small badge. Authorship is still the
   authenticated user — this is self-reported context for display and
   auditing, not authentication.

The command surface is also forgiving of gh-style habits: `issue show`
and `issue comment` work as aliases, and anywhere a `<number>` is
expected you can write `project/16`, `"#16"`, `T-16`, or paste the full
issue URL. Output is not left to guesswork either: `--json` spells every
issue number in the project's own reference format (see
[docs/external-trackers.md](external-trackers.md)).

## Pushing activity into the session: `--follow=uds`

`todou watch --follow=uds` and `todou issue watch <n> --follow=uds` stay
resident and deliver each batch of activity as a message to the Claude Code
session that started them, instead of printing one batch and exiting. Run
one as a background task and the session is told when something happens,
rather than having to re-open the watch each time — or forgetting to. The
two commands differ only in what they watch: every issue of a project set,
or one card.

It needs `CLAUDE_CODE_MESSAGING_SOCKET`, which Claude Code exports to the
subprocesses it spawns, and refuses with that variable named if it is
unset. `--follow=stdout` (or a bare `--follow`) is the transport for
everything else, including a supervisor that runs a command and reads its
output; the transport is never inferred from the environment, because such
a supervisor is started *by* the session and has the variable set too.

Choosing the transport is therefore the caller's job, and `todou agent
can-i-follow` does it: it reports which one this environment supports, and
what to run instead where neither does. It talks to no server and resolves no
project, so it answers at any point in a session, including one that starts
with the tracker down. Where a session keeps refusing or holding pushed
messages, `todou agent opt-out-uds` records that on the machine and the
report stops offering the push transport; `todou agent opt-in-uds` takes it
back. Both change advice only — an explicit `--follow=uds` keeps working
either way.

The session exports `CLAUDE_CODE_MESSAGING_TOKEN` next to the socket path
(Claude Code v2.1.228 and later), and every connection opens with that
token on its first line, as `{"type":"auth","token":"…"}`. On POSIX the
line is optional and a wrong token is tolerated; on native Windows it is
required, and a connection that opens without it is closed with no receipt
for what was discarded. Where the variable is missing — a POSIX session
from v2.1.224 to v2.1.227 exported the socket but no token — the watch
pushes anyway, and on Windows it degrades to the one-shot mode it has
without `--follow`.

The message channel has details that were measured rather than documented,
and each of them is silent when written wrong:

- `msg_id` must be a UUID. A message with a custom id is still delivered,
  but the receipt comes back without an `orig_msg_id`, so nothing can be
  correlated to it and a refusal goes unnoticed.
- The sender's reply address must be a `uds:` URI over an absolute `.sock`
  path that the sender itself is listening on, or no receipt is sent at all.
- The auth line has to be the *first* line on the connection. Only the
  first frame is read as an auth frame, so a connection that opens with a
  blank line or unparseable JSON is closed wherever the token is required.
- One payload may not exceed about a million characters, counting the auth
  line, the frame and its trailing newline together. Past that the receiver
  destroys the connection and sends no receipt, so a batch too large to
  push goes out as its entry count and its cursor range instead, and the
  reader re-reads those entries from the tracker.
- A session that accepts messages outright sends no positive receipt, so
  "delivered" can only mean "nothing negative arrived within the window".

On native Windows the push direction is complete — the connection carries
its auth line — while the receipt direction has not been verified on any
Windows machine. `--follow=uds` therefore stays available there and says so
on stderr when it opens: a refusal may pass as delivered.

The sender's display name states which watch a message came from:
`todou-watch-<slug>` for a project watch (`todou-watch-aa-bb` across a list,
`todou-watch-all` under `--all-projects`) and `todou-watch-<slug>-<number>`
for a single card. It is a display label only — the receiving side's
admission check never reads it — but a session holding one project watch and
three card watches would otherwise show the same sender five times.

Whether the push is delivered is decided by the receiving session's
admission check, in this order. An explicit `crossSessionInbound` setting
wins outright: `"hold"` or `"refuse"` stops even a background task that
session started itself, and the watch does not push blind — it writes the
batches it cannot account for and its cursor to stdout, names the setting
on stderr, and exits 0. With no explicit setting, the session asks whether
the sender is one of its own child processes — read from the ancestor chain
on Linux, and from the token on native Windows, in a container where Claude
Code runs as PID 1, and on macOS once the sending process has exited — and
delivers straight through when it is, without reading the permission mode
at all. The attested `from-mode` decides only the remaining case: no
explicit setting and a sender that is not a descendant of the session,
which is what a watch started from an unrelated shell with the socket path
exported into it looks like.

## Where the metadata comes from

- `session_id` — `CLAUDE_CODE_SESSION_ID`, documented and set by Claude
  Code for Bash subprocesses.
- `model` — Claude Code exposes no environment variable for the live
  model, so the CLI reads the tail of the session transcript
  (`~/.claude/projects/*/<session-id>.jsonl`, an *unofficial* format) and
  falls back to a `CLAUDE_MODEL` variable if you export one. Detection
  failures just omit the field; they never break a command.
- permission mode (`--follow=uds` only, so a push can attest to it) —
  the same transcript tail, newest `permissionMode` wins, so switching mode
  mid-session is picked up. `plan` attests nothing: what the receiving side
  normalizes it to depends on a flag the transcript does not record, and in
  the one case that reads the mode at all (above), a wrongly attested mode
  is held outright while an unattested one is held only if the target
  session is in bypass.

## Optional: a stable `CLAUDE_MODEL` via hooks

If you prefer not to rely on transcript parsing, Claude Code's SessionStart
hook receives the model and can export it through the official
`CLAUDE_ENV_FILE` mechanism:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '\"export CLAUDE_MODEL=\" + (.model // \"\")' >> \"$CLAUDE_ENV_FILE\""
          }
        ]
      }
    ]
  }
}
```

Caveats: the hook fires at session start only, so the value goes stale if
you switch models mid-session with `/model` (the transcript tail does not —
that is why the CLI prefers it), and the `model` field can be absent after
`/clear` or session restore.
