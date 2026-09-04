# Scripting against the CLI

What a script needs from todou: machine-readable shapes, exit codes and cursor plumbing. An agent
reading for itself uses the default human output, which already carries every id, ref, count and
cursor.

## Exit codes of the wait commands, by mode

- `--forever` (the standard wait; `spec wait` always behaves this way): 0 = new entries, 1 = fatal.
  Timeouts and outages are handled inside the command. `--timeout` is the heartbeat interval (default
  600s): one `still watching — nothing new in …` line per interval on stderr.
- Blocking without a flag: 0 = new entries; 3 = timeout with nothing new (normal, not an error);
  1 = fatal; 4 = the command gave up on a network outage after automatic retries (transient failures
  are retried for more than two minutes first). On 3 or 4, rerun with the same cursor.
- `--poll`: 0 = the check finished, with or without news; 1 = fatal; 4 = the command failed fast
  after three attempts.
- `todou watch --follow` (standing mode, implies `--forever`): 0 = it stopped on purpose — the push
  channel refused delivery and it degraded, which is the same verdict a one-shot delivery gives;
  1 = fatal. There is no "nothing new" ending, because it does not end on quiet. Before any exit,
  including a fatal one, uds mode flushes the entries it cannot confirm were delivered plus a
  `cursor:` line to stdout, so the position is never lost; feed that cursor back to `--since`.

All waits subscribe to the server's change feed and return within about a second of a new entry;
`--interval` (default 2s) is the poll cadence used while the feed is unavailable. `question wait` and
`spec wait` read the state they wait for before blocking, so a result that is already in is returned
without waiting.

## `--json` on the waits is NDJSON

One compact record per line: item records, then one `{"type":"cursor","next_cursor":…,"ref_format":…}`
record closing the batch. `spec wait` and `spec push --wait` add a final
`{"type":"outcome","outcome":"approved"|"changes_requested"|"feedback",…}` record with
`review_status`, `unresolved_comments` and `version`. A file you append a watch to is parseable line
by line; resume from the last cursor record, because item lines not yet followed by a cursor record
replay on the next run.

```bash
jq -r 'select(.type=="cursor").next_cursor'     # the cursor
jq 'select(.type!="cursor")'                    # the entries
```

stdout carries data and stderr carries diagnostics; retry progress and heartbeats go to stderr. When
collecting a watch into a file, write `… --json > feed.ndjson 2> feed.err`, never `2>&1`.

## Cursors

- Cursors are interchangeable project-wide: `issue view`, watch output and `--poll` all produce them.
  They survive restarts, and events during an outage are delivered on reconnect without duplicates.
- A bare current cursor on stdout: `todou watch -p <proj> --poll --print-cursor`. It exits 0 with or
  without news and conflicts with `--json`. Use it only for a wait that no write precedes.
- The write's own cursor: `spec push` and `comment add` accept `--print-cursor`, which prints the
  bare cursor on stdout and moves the summary to stderr (conflicts with `--json` and with `--wait`).
  They also accept `--since <cursor>`: the write runs regardless, the entries between that cursor and
  now are listed on stderr (`missed` under `--json`), and the cursor reported back is the given one,
  so a watch resuming from it delivers those entries again. An empty `--since ""` is refused before
  anything is written, because a failed `$(…)` capture must not turn into "the whole timeline".

## Refs in `--json`

```bash
todou issue list -p <proj> --json | jq -r .ref_format.token    # "#" or "T-"
```

`ref` sits beside `number`, `issue_ref` beside `issue_number`, and `ref_format` is carried by the
`issue list`, `issue view`, `issue watch` and single-project `todou watch` envelopes, so an empty page
still tells you the spelling. `issue view --json` keeps its single-object shape for one number and
switches to `{items, ref_format}` for several.

## Reading bodies

`comment view <n> <id> --json | jq -r .body` gives a script a comment body by id; `comment list` and
`issue events` are where the ids come from. Neither marks the card read; only `issue view` does
(`PUT /projects/<proj>/issues/<n>/read`). Unread state is per user on the server and degrades
silently against a server without the endpoint.

## Raw API

`todou api <method> <path>` authenticates like every other command and passes a non-JSON response
through byte for byte: `todou api get /projects/<proj>/attachments/<id>/download > shot.png`.
