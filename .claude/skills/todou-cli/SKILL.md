---
name: todou-cli
description: todou CLI quick reference — issue/comment/attach/watch commands, cursor semantics, status-flow conventions, and the rules for how agents interact with the tracker. Read this first before touching a todou tracker.
---

# todou CLI

todou is the team's issue tracker. Agent questions, reports, deliverables, and reviews all go
through the tracker so everything leaves a trace. Project-specific facts (slug, server, sandbox
project, deploy command) live in the host project's CLAUDE.md / memory; `<proj>` below is a placeholder.

## Basics

- Just run `todou` — the CLI config auto-selects the machine-account profile prepared for agents; no login flags needed.
- **Every todou command needs network access**: sandboxed runs get their sockets denied, so always run them with the sandbox disabled.
- **The human output is the interface — read that, not `--json`.** Every id, ref, count and cursor
  an agent needs is already in it, at a fraction of the tokens. Reach for `--json` only when a
  *script* consumes stdout. `todou api <method> <path>` covers anything the CLI lacks.
- If the deployment has a sandbox project (scratch space), run experiments and guinea-pig tests there — never pollute the real tracker.

## Command cheat sheet

```bash
todou issue list -p <proj> [--open|--closed|--status X|--unread|-q text]  # ends with a count
todou issue view 16 -p <proj>       # prints a cursor at the end, for watch --since
todou issue view 16 --brief         # header + status only, no body, no timeline
todou issue view 16 --timeline --last 10   # drop the body, keep the newest 10 entries
todou issue create -p <proj> --title T [--body-file -] [--status Next]
#   ^ when filing on behalf of the user, quote their original words verbatim
#     in the body (if any) — off-tracker requests have no other trace
todou issue edit 16 --status "In Progress"    # status/title/labels/assignees
todou issue close 16 --comment "done"
todou comment add -p <proj> 16 --body-file -  # prints the new comment's id
todou attach -p <proj> 16 file.png ...        # prints `#id name → url`
todou attach list -p <proj> 16                # id / filename / size / url
todou attach download -p <proj> 16 <id|name> [-o <path>|-o -]
todou status list -p <proj>
todou status init -p <proj>                   # add the missing canonical statuses, sync existing colors
todou status create -p <proj> --name X --category open|closed [--color '#hex'] [--before Y|--after Y]
todou status edit X [--name N] [--category C] [--color '#hex'] [--before Y|--after Y] [--default]
todou status delete X                         # refused (409) while issues still use it
todou label list -p <proj>
todou label create <name> [--color '#hex']    # rarely needed by hand — see Labels below
todou label edit <name> [--name N] [--color '#hex']
todou label delete <name>
```

Forgiving forms (gh habits all work): `issue show` = `view`, `issue comment` = `comment add`,
and every `<number>` positional also accepts `<proj>/16`, `"#16"`, the project's own ref form
(`T-16`), or a full issue URL — input is never picky about the spelling. Output is: see **Issue refs**.
gh's flag spellings work too — `-t/-b/-F/-l/-a` on `issue create`, `-l/-a/-L/-S/-s --state
open|closed|all` on `issue list`, `-c` on `issue close`, `@me` wherever a login goes.

## Writing bodies

`--body-file -` reads the body from stdin:

```bash
todou issue create -p <proj> --title "…" --body-file - <<'EOF'
Multi-paragraph markdown — code blocks, CJK, blank lines — all survive verbatim.

Second paragraph.
EOF
```

`--body-file` and `--questions` also read process substitution (`<(…)`, bash/zsh) — that is how
body **and** questions travel in one call; stdin is a single stream, so at most one of the two
may be `-`. See **Asking the user questions** below.

## Labels

**Never pre-create a label.** Any label flag on a write creates what it doesn't find, prints
`created label 'X' (#color) · recolor: …` on stderr, and carries on. `todou label create` is for
recoloring plans and bulk setup, not for clearing the way.

- **Adding vs replacing.** `--add-label` / `--remove-label` edit the set in place;
  `--label` / `--labels` **replace it wholesale**, and print what they dropped. The two styles
  cannot be combined in one command. Reach for `--add-label` unless you mean to wipe.
- **Both forms are lists.** Repeat the flag or comma-separate it — `--add-label 'area:cli,kind:bug'`
  is two labels. The server enforces the other half of that deal: a label name may not contain a
  comma (422), and whitespace is canonicalized — `'area:   cli'` is stored, and matched, as
  `area: cli`. So a name the CLI can say is always a name it can say again.
- **Removals and filters stay strict.** `--remove-label` and `issue list --label` reject a name the
  project doesn't have; only writes invent one. `issue list --label a --label b` matches **any**.
- Auto-created labels get a color derived from their name. Recolor with the command in the notice.
- Creating needs the **admin** role; a writer-only token gets told so, with the command to hand over.

## watch / poll (the agent's radar)

```bash
todou issue watch 16 --since <cursor> --timeout 43200  # wait on one issue
todou watch -p <proj> --since <cursor> --timeout 43200 --debounce 60  # wait on the whole project, others only
```

Use a 12-hour timeout (43200) and a 60-second debounce as the standard values.

**Leave `--json` off unless a script is consuming the stream.** The default is one line per entry —
`<ref> <who> <what> <when>: <summary>` — ending with a `cursor:` line, and a comment line shows the
start of its body. That last part is the point: a stream that names entry types and stops there gets
read past, and the instruction inside the comment is missed. `--summary <chars>` widens or narrows
the body a line carries (default 120).

**Never issue a blocking wait bare — wrap it in a re-run loop.** This applies to `issue watch`,
`todou watch` and `question wait` alike. Exit 3 (timeout) and exit 4 (network give-up) both mean *keep
waiting*, and a wait parked in the background can also be lost to process-lifecycle accidents. Any of
those endings leaves a bare wait returning with no answer — and an agent whose only wake path just
returned empty goes idle forever:

```bash
while :; do
  todou question wait <n> <commentId> -p <proj> --timeout 43200 --json; c=$?
  [ $c -eq 0 ] && break   # answers in hand
  [ $c -eq 1 ] && break   # fatal — report it, don't spin
done                      # 3 (timeout) and 4 (outage) simply loop; nothing is lost
```

The loop being **killed** from outside (the harness stopping a background task) is a separate, observed
failure — it has hit both workers and the orchestrator. It is not fatal and needs no cron: the kill
notification itself re-invokes you, so the correct reaction is simply *restart the wait with the same
cursor*, every time, however often it happens. Nothing is lost across the gap. Do not downgrade to a
short-period self-poll — a 6-minute poll burns a whole agent turn per tick — and do say a word about it
in the terminal so the orchestrator knows to relay as a backstop.

- Exit codes: **0 = new entries**, **3 = timeout with nothing new**
  (normal, not an error), 1 = fatal error, **4 = gave up on a network outage** after automatic retries
  (a blocking watch retries transient failures — 5xx, refused, reset — for 2+ minutes first; `--poll`
  fails fast after 3 attempts). On exit 4 just rerun with the same cursor; nothing is lost.
- **`--json` is NDJSON** (CLI ≥ 0.3.0): one compact record per line — the item lines have the shape
  the old `items[]` elements had, then one `{"type":"cursor","next_cursor":…,"ref_format":…}` record
  closes the batch. So a file you append a watch to is parseable line by line; resume from the
  **last** cursor record, and item lines no cursor record follows yet simply replay next run.
  Take the cursor with `jq -r 'select(.type=="cursor").next_cursor'` (or `tail -n1 | jq -r
  .next_cursor`), the entries with `jq 'select(.type!="cursor")'`.
- **stdout is data, stderr is diagnostics** — retry progress goes to stderr. When collecting a watch
  into a background file, **never `2>&1`**: write `… --json > feed.ndjson 2> feed.err` (or `2>
  /dev/null`). Merging them is what used to force defensive incremental JSON scraping.
- Cursors are interchangeable project-wide: `issue view`, watch output, and `--poll` all produce them.
  They survive process restarts, and events during an outage are all delivered on reconnect, without duplicates.
- Get a "now" cursor: `cursor=$(todou watch -p <proj> --poll --print-cursor)` — stdout is the bare
  cursor and nothing else, and it exits 0 whether or not the poll found anything, so no `; true`
  and no `jq`. (Conflicts with `--json`, which already ends its batch with a cursor record.)
- `--debounce N`: after the first new entry, keep collecting for N seconds and return one batch (fewer wake-ups, fewer tokens).
- Both watches skip **your own agent session's** entries by default, not your whole account — a fleet
  sharing one machine account does wake each other (T-121). Entries carrying no agent session (the web
  UI, a shell with no harness) still fall back to the account. `--any-actor` turns the filter off;
  `issue watch --exclude-actor <login>` swaps in one named account instead.
- Unread: `issue list` marks issues with unseen outside activity with `●`, `--unread` filters to them,
  and `view` marks as read. The state is **per-user on the server** (the list response carries `unread`;
  `view` fires `PUT /projects/<proj>/issues/<n>/read`), so it follows you across machines — there is no
  local state file. "Unread" only ever counts *other* accounts' activity, never your own. Against a
  server too old to have the endpoint it degrades silently: nothing marked, no error.

## Rich content in bodies and comments

These are affordances, not a licence to write more — **Comment discipline** below still sets the length.

**Attachments.** `todou attach` prints the id and the URL it just created
(`#12 shot.png → /api/projects/<proj>/attachments/12/download/shot.png`); paste the URL verbatim
rather than rewriting it into an absolute one, and address the id with `attach download`.

- `[name](…/download/name.ext)` links the attachment.
- `![](…/download/name.ext)` embeds it inline — images, text files and markdown all render in place.
- Single-file demo pages (mockups, prototype HTML) **must** be attached to the relevant issue with
  `todou attach` — never leave them only on local disk.
- **Reading them back**: `attach list` is the authoritative set (the timeline records upload *events*,
  a body links only what someone chose to link), and its `#id` column is what `attach download`
  addresses — by id, or by exact filename when that is unambiguous. Without `-o` the file lands in the
  current directory under its own name and never overwrites; `-o <dir>` writes into that directory,
  `-o <file>` writes exactly there, `-o -` streams the bytes to stdout.
- **Never lift a token out of `config.toml`.** `attach download` and `todou api` both authenticate the
  way every other command does, and `todou api` streams a non-JSON response through byte for byte, so
  `todou api get /projects/<proj>/attachments/<id>/download > shot.png` works. A hand-written `curl`
  carrying a pasted Bearer is a credential leak with nothing left to buy.

**Permalinks.** Every timestamp is a link to that one entry (`#comment-<id>`, `#event-<id>`). Paste one
to send the reader straight to a specific comment or event.

**Issue refs.** **Never presume the spelling.** A project writes its issues either bare (`#12`) or
with a prefix (`T-12`), it is a per-project setting, and a guessed ref links nowhere. You never have
to ask for it: **every command that knows an issue number already prints it spelled** — the first
line of `issue view` (`todou issue view <n> --brief` is the cheapest way to see just that), the
start of every `issue list` row, the start of every watch line, and `comment add`'s echo.

For a *script* that needs the token on its own, the field is there too:

```bash
todou issue list -p <proj> --json | jq -r .ref_format.token    # "#" or "T-" — token + number
```

`ref` sits beside `number`, `issue_ref` beside `issue_number`, and `ref_format` rides on the
`issue list` / `issue view` / `issue watch` / single-project `todou watch` envelopes, so even an
empty page tells you. Fenced and inline code are exempt from ref parsing, so you can quote a ref
without making one.

- **Reference with intent**: a ref notifies the card you point at. Use refs when the link carries
  meaning (a follow-up, a dependency, a dupe); never enumerate incidental cards — a note listing the
  five cards a branch was rebased past sprays noise and tells nobody anything. Write "rebased onto
  latest master" instead. And **never self-reference**: a ref to the card you are writing on is pure
  noise — write "this card" / "本卡".
- **Tracker text only.** In source and commit messages write the project's own form, read as above.
  In a public repo a bare `#N` autolinks to the host's own issue numbering, permanently wrong — so
  where the project has no prefix configured, name the tracker in prose instead of writing `#N`.

## Comment discipline

A tracker comment is a record, not an essay:

- **Conclusion first.** The finding, the decision, the number. Context after, if at all.
- **Bullets over prose.** Bold the claim, one line of why. Cap the list at five; if it's longer, split
  "now" from "later". Anything the reader must *do* becomes numbered steps.
- **No preamble, no recap, no closer.** Not "先说结论", not "综上", not "有问题随时说".
- **One point per comment.** Two unrelated findings are two comments, or one card and one comment.
- **Cut what the reader can already see.** Don't restate the card body, don't narrate what you did
  before saying what you found.

State failures flat — cause, then fix, no "unfortunately". If something is left open, name the single
thing that unblocks it rather than listing everything that remains.

Length has to earn itself. A shipped-summary with real evidence (test counts, shas, a diff that
surprised you) can run long; a triage note cannot. When in doubt, cut it in half and see what breaks.

## Status flow (who moves what)

```
Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done
```

(New projects are seeded with all seven. For a project that predates that, run `todou status init -p
<proj>` — it creates the missing ones in canonical order, syncs existing ones to the standard colors,
and pins Todo as the default; one-off tweaks go through `status create/edit/delete`.)

- **Worker agents**: move the card to In Progress when starting; move it to Ready to Ship when development
  is complete (commits on their own branch, not merged), and post a summary comment.
- **The orchestrator**: moves cards to Shipped after merge + deploy.
- **Only the user** moves a card to Done, after verifying. Never do this on the user's behalf.

## Asking the user questions (native questions component)

Do not use AskUserQuestion or external review tools — post questions on the issue and wait:

```bash
todou comment add -p <proj> 16 --body-file <(cat <<'EOF'
Context for the questions — full markdown, as long as it needs to be.
EOF
) --questions <(cat <<'EOF2'
[{"header": "Storage", "question": "Where should X live?",
  "options": [{"label": "Reuse mechanism A", "description": "pros/cons…"},
              {"label": "New entity"}],
  "multiple": false}]
EOF2
)                          # prints the wait command, comment id filled in
todou question wait 16 <commentId> -p <proj> --timeout 43200   # blocks until answered
```

- All text fields are markdown; validation is **strict** — unknown/extra fields fail with the path named.
- Users answer once, all questions in the comment together; "decline to answer" is a built-in exclusive
  choice; options and free-text "other" can coexist. Answers arrive decoded in the wait output.
- `question list <n> --unanswered` shows what's still open; `question answer` is the CLI answering side.
- Exit codes follow the watch convention (0 answered / 3 timeout — re-wait / 1 error).
- One comment may carry 2–3 tightly related questions, each with your recommendation and reasoning.

## Spec documents (plans, proposals, reviewable docs)

A spec set is a group of versioned markdown files attached to an issue — the tracker-native
replacement for specs/ directories and external review tools. Documents are written in a scratch
dir and pushed; **git never carries them**.

```bash
todou spec push <n> <dir> -p <proj> --message "v2" [--if-version <v>]  # upload/iterate a version
todou spec pull <n> <dir> -p <proj> [--version <v>] [--prune]          # fetch a version
todou spec status <n> -p <proj>                                        # versions + review verdict
todou spec comments <n> --unresolved                                   # inline annotations (file+anchor)
todou spec resolve <n> <commentIds…>                                   # mark annotations addressed
todou spec review <n> --approve | --request-changes [--body …]         # submit a verdict
```

- Review state is computed, never stored: a verdict counts only against the **latest** version, and
  the pusher of a version cannot review it.
- Wait for the verdict by watching the whole issue — `issue watch <n> --since <cursor> --debounce 60
  --timeout 43200` — with no `--type` filter, so a plain comment (an amended requirement, a
  question back) wakes the waiter too.
- **The watch wakes; `spec status` judges.** A wake-up is not a verdict: sibling agents on the same
  machine account pass the self-filter (it is per agent session, see watch above). On exit 0 read
  `spec status` — `approved` proceeds; `changes_requested` or `unresolved_comments > 0` enters the
  revision loop; neither means no verdict yet — handle others' comments as feedback, otherwise
  resume the wait silently. Always resume with the cursor the watch printed on its last line
  (exit 3/4: same cursor), never a fresh "now" cursor, which would skip whatever landed in the
  gap. Never poll `spec status` in place of the blocking watch, and never read a verdict off the
  event stream.
- Annotations remap across versions (resolved/outdated tracked automatically).
- The plan workflow on top of this lives in `/todou-plan` and `/todou-impl-plan`.
