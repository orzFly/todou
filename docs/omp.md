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

`todou agent can-i-follow` reports whether this session can, and names
`todou integration install omp` when the extension is what is missing. It
talks to no server and resolves no project, so it answers at any point in a
session, including one that starts with the tracker down.

`--follow=stdout` (or a bare `--follow`) is the transport for everything else.
The transport is never inferred from the environment: a supervisor that runs a
command and reads its output is started *by* the session and has the same
variables set, so guessing would send exactly the batches that belong on
stdout down the push channel instead.

The rest of the channel behaves as it does under Claude Code —
[docs/claude-code.md](claude-code.md) describes the delivery guarantees, the
degradation when a push cannot be confirmed, and `todou agent opt-out-uds`.
One difference is worth stating: an omp session is not asked to approve a
push, so the "held for approval" outcome does not arise there.

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
