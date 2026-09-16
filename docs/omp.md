# todou × omp

The `todou` CLI recognizes when it runs inside an omp session and does two
things automatically — no flags, no configuration:

1. **Token selection.** If the server has a token stored under the `omp`
   profile, it is used instead of the default token:

   ```bash
   todou login https://todou.example --profile omp
   ```

   omp sets `OMPCODE=1` in every shell it spawns, which is what triggers the
   auto-selection. Your own shell keeps using the default token. A profile
   named `harness` serves *every* harness, for a fleet that shares one machine
   account; `omp` wins wherever both exist.

   omp also sets `CLAUDECODE=1`, deliberately, so that tools keyed on Claude
   Code behave inside it. todou tells the two apart anyway — by `OMPCODE` and
   by the process tree — so an omp session picks the `omp` profile and reports
   itself as omp, including when it was started from a Claude Code session or
   the other way round.

2. **Provenance metadata.** Every write carries an `X-Todou-Agent-Context`
   header recording `{ agent: "omp", session_id, model }`. Authorship is still
   the authenticated user — this is self-reported context for display and
   auditing, not authentication.

## The extension: `todou integration install omp`

omp exports nothing that says which session it is in. Without help, todou
infers it: among the session logs filed under this project, the most recently
written one is almost always the live session, because omp appends the user's
message before running the tool that invokes todou.

*Almost* always. Two omp instances open on the same project defeat that by
construction — there is nothing to tell them apart — and a write that lands
between the tool starting and todou reading can hand a session id to the wrong
instance. The fix is not a better guess:

```bash
todou integration install omp
```

This writes one file into omp's own extension directory, under your home
directory:

```
~/.omp/agent/extensions/todou-omp-session.ts
```

It follows omp wherever it keeps that directory — `PI_CODING_AGENT_DIR`,
`PI_CONFIG_DIR`, and `OMP_PROFILE` / `PI_PROFILE` are all honoured — and
`todou integration status` prints the path it resolved. **Restart omp
afterwards**: an extension is loaded when a session starts, so a running
session is unaffected.

The extension buys two things:

- **Exact session identification.** omp itself publishes which session it is
  in, and todou reads that instead of guessing. Two instances on one project
  each report their own session, and `/new` and `/resume` are followed as they
  happen.
- **Somewhere for `--follow=uds` to push.** See below.

It is per-user, not per-project: it lives in your home directory and applies to
every project you open omp in. There is no project-scoped install — an
extension that travelled with a checkout would install itself into every
person who opened that repository, and whether an agent integration is wanted
is a decision about a machine and a user, not about a repository.

An omp without the extension keeps working exactly as it did: the session
falls back to the log scan, every command still runs, and only `--follow=uds`
becomes unavailable. The same fallback covers a broken install — an
unreadable, malformed or stale record is treated as no record at all.

### Managing it

```bash
todou integration status                 # every integration, and where it resolved
todou integration install omp            # write it (or replace an older version)
todou integration install omp --dry-run  # say what would change, write nothing
todou integration uninstall omp          # remove it
todou integration install-all            # every agent found on this machine
todou integration uninstall-all
```

`install-all` and `uninstall-all` act on every agent this machine shows a sign
of, which is a question about the filesystem — they are meant to be typed into
an ordinary shell, where no agent is present in the environment at all.
Finding none is success.

The installed file is marked as todou's, in a header naming the integration
and its version. A file at that path *without* that marker is somebody else's:
it is never overwritten and never deleted, and the command says so and exits
non-zero. Put your own extensions in files beside it rather than editing it —
reinstalling replaces the whole file.

## Pushing activity into the session: `--follow=uds`

With the extension installed, `todou watch --follow=uds` and
`todou issue watch <n> --follow=uds` stay resident and deliver each batch of
activity as a message into the omp session that started them, instead of
printing one batch and exiting. Run one as a background task and the session
is told when something happens, rather than having to re-open the watch each
time — or forgetting to.

`--follow=stdout` (or a bare `--follow`) is the transport for everything else.
The transport is never inferred from the environment: a supervisor that runs a
command and reads its output is started *by* the session and has the same
variables set, so guessing would send exactly the batches that belong on
stdout down the push channel instead.

## `todou_watch`: the tool the extension registers

The extension also registers a `todou_watch` tool the model can call, which
runs those watches as children of omp itself — no bash job to keep alive. It
is mounted as a device rather than listed among the session's tools, because
its `loadMode` is omp's default `discoverable`: the session reads its full
documentation from `xd://todou_watch` and runs it by writing a call's JSON
arguments to `xd://todou_watch`. In a session with `tools.xdev` turned off
every tool is a top-level tool instead, and writing to `xd://` answers
`xd:// is not mounted in this session.` — that sentence names the next step
itself, so nothing here branches on it.

Three actions: `{"action": "start", "issue": "T-16"}` follows one card,
`{"action": "start"}` follows every card of a project, `{"action": "list"}`
reports what is running, and `{"action": "stop", "id": "w1"}` ends one.
`project` and `server` are optional and resolved from the directory omp is
running in when left out; a directory that settles neither fails the call
rather than guessing. `since` resumes from a cursor an earlier command
printed.

The tool finds the CLI on PATH — the PATH of the shell omp was started from,
inherited — and `TODOU_BIN` overrides that. Nothing is recorded at install
time: the shell `todou integration install omp` runs in has a different PATH
from the one omp later inherits, so an install-time check would name the
wrong one.

### `/todou` and the widget

The user sees one line in omp's interface — `todou watch - todou, T-16, T-18`
— naming what is being followed right now, with more folded into an
`and <n> more` tail past four. `/todou` says the same in a notification and
is how the user stops them: `/todou stop` ends every watch, `/todou stop w1`
ends one.

Stopping from `/todou` notifies the agent — one message naming every watch
that ended, what each had not handed over, and the cursor to resume from.
The same message arrives when a watch dies on its own; a watch the model
stopped through the tool says nothing, because that call's return already
did.

`todou agent can-i-follow` reports whether this session can, and where the
extension's tool is present its answer is the tool. It talks to no server
and resolves no project, so it answers at any point in a session, including
one that starts with the tracker down.

Give a command that has to outlive a single tool call `timeout: 0` when it
runs as a bash job — `spec push --wait`, `spec wait`, `question wait`. The
deadline belongs to omp's bash tool rather than to todou: it defaults to 300
seconds and ends the command with no signal it can catch, so a command that
reaches it stops without printing the cursor a restart would resume from,
and whatever arrived in between is never read. A watch started through
`todou_watch` is not under that deadline; these days it is the way to run
one.

A batch that arrives cuts into the turn the session is running rather than
waiting for that turn to end. omp makes room for it by backgrounding the
foreground bash command early — it reports
`Backgrounded early to handle an incoming message` when it does — and that
command goes on running. How often this happens is set by the batching
window, `--debounce`, which is 60 seconds by default here.

Delivery guarantees, the degradation when a push cannot be confirmed, and
`todou agent opt-out-uds` are as [docs/claude-code.md](claude-code.md)
describes them, with the differences below.

An omp session is not asked to approve a push, so the "held for approval"
outcome does not arise. And where Claude Code tolerates a missing or wrong
auth line on POSIX, omp requires one: every connection has to open with
`{"type":"auth","token":"…"}` carrying the token the session published, and a
`user` frame that arrives without it is refused with a receipt — the sender
learns its batch went nowhere instead of reading the silence as delivery.
Only `user` frames are answered that way; a `control` frame is never replied
to, so two sessions exchanging receipts cannot ping-pong. A connection that
opens with a *wrong* token is closed with no receipt at all, which is what
Claude Code does on the platform where it checks: holding the wrong
credential is a fact about the sender, not something this side confirms.

The other difference is the envelope. Claude Code's receiver reads a
`<cross-session-message>` wrapper off every pushed body and re-serializes
its attributes to decide whether to believe them; omp's extension hands the
body to the session as it stands, so a todou pushing to omp writes no
envelope at all. What survives either way is the frame's `from` — the reply
address a receipt travels back over.

## Where the metadata comes from

- `session_id` — the extension's record, when it is installed; otherwise the
  most recently written session log filed under this project, matched against
  its own recorded cwd. Both are *unofficial* in the sense that omp does not
  promise either format, and a read that fails falls back rather than erroring.
- `model` — read from the tail of the session log: the newest `model_change`
  or assistant message, whichever came later, which is what omp itself
  resolves the live model from. It therefore follows a model switched
  mid-session. The extension deliberately does not publish a `model` of its
  own — it changes every turn, and a second copy would only be one more thing
  that can go stale.
