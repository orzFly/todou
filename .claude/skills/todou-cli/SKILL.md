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
- `--json` gives structured output; `todou api <method> <path>` covers anything the CLI lacks.
- If the deployment has a sandbox project (scratch space), run experiments and guinea-pig tests there — never pollute the real tracker.

## Command cheat sheet

```bash
todou issue list -p <proj> [--open|--closed|--status X|--unread|-q text]
todou issue view 16 -p <proj>       # prints a cursor at the end, for watch --since
todou issue create -p <proj> --title T [--body-file f] [--status Next]
#   ^ when filing on behalf of the user, quote their original words verbatim
#     in the body (if any) — off-tracker requests have no other trace
todou issue edit 16 --status "In Progress"    # status/title/labels/assignees
todou issue close 16 --comment "done"
todou comment add -p <proj> 16 --body-file f  # long bodies: --body-file /dev/stdin <<'EOF'
todou attach -p <proj> 16 file.png ...        # mime inferred from the extension
todou status list -p <proj>
todou status init -p <proj>                   # create whichever canonical statuses are missing
todou status create -p <proj> --name X --category open|closed [--color '#hex'] [--before Y|--after Y]
todou status edit X [--name N] [--category C] [--color '#hex'] [--before Y|--after Y] [--default]
todou status delete X                         # refused (409) while issues still use it
```

Forgiving forms (gh habits all work): `issue show` = `view`, `issue comment` = `comment add`,
and every `<number>` positional also accepts `<proj>/16`, `"#16"`, or a full issue URL.

## watch / poll (the agent's radar)

```bash
todou issue watch 16 --since <cursor> --timeout 43200 --json  # wait on one issue
todou watch -p <proj> --since <cursor> --timeout 43200 --debounce 60 --json  # wait on the whole project, others only
```

Use a 12-hour timeout (43200) and a 60-second debounce as the standard values.

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

- Exit codes: **0 = new entries** (stdout is `{items, next_cursor}`), **3 = timeout with nothing new**
  (normal, not an error), 1 = fatal error, **4 = gave up on a network outage** after automatic retries
  (a blocking watch retries transient failures — 5xx, refused, reset — for 2+ minutes first; `--poll`
  fails fast after 3 attempts). On exit 4 just rerun with the same cursor; nothing is lost.
- Cursors are interchangeable project-wide: `issue view`, watch output, and `--poll` all produce them.
  They survive process restarts, and events during an outage are all delivered on reconnect, without duplicates.
- Get a "now" cursor: `todou watch -p <proj> --poll --json` (exit 3 with empty items is expected).
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

**Attachments.** `todou attach` prints the URL it just created
(`shot.png → /api/projects/<proj>/attachments/12/download/shot.png`); paste that string verbatim
rather than rewriting it into an absolute URL.

- `[name](…/download/name.ext)` links the attachment.
- `![](…/download/name.ext)` embeds it inline — images, text files and markdown all render in place.
- Single-file demo pages (mockups, prototype HTML) **must** be attached to the relevant issue with
  `todou attach` — never leave them only on local disk.

**Permalinks.** Every timestamp is a link to that one entry (`#comment-<id>`, `#event-<id>`). Paste one
to send the reader straight to a specific comment or event.

**Issue refs.** Write a ref the way the CLI prints issue numbers (`T-<n>` here) — that form is the
project's active one. Fenced and inline code are exempt, so you can quote a ref without making one.

- **Reference with intent**: a ref notifies the card you point at. Use refs when the link carries
  meaning (a follow-up, a dependency, a dupe); never enumerate incidental cards — "rebased onto master
  containing T-52/T-53/T-26/T-49/T-57" sprays noise and tells nobody anything. Write "rebased onto
  latest master" instead. And **never self-reference**: inside T-36, a `T-36` is pure noise — write
  "this card" / "本卡".
- **Tracker text only.** In source and commit messages write the project's textual form (`T-<n>`) —
  in a public repo a bare `#N` autolinks to the host's own issue numbering, permanently wrong.

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

(If a project lacks some of these statuses, run `todou status init -p <proj>` — it creates the missing
ones in canonical order with the standard categories/colors, and pins Todo as the default; one-off
tweaks go through `status create/edit/delete`.)

- **Worker agents**: move the card to In Progress when starting; move it to Ready to Ship when development
  is complete (commits on their own branch, not merged), and post a summary comment.
- **The orchestrator**: moves cards to Shipped after merge + deploy.
- **Only the user** moves a card to Done, after verifying. Never do this on the user's behalf.

## Asking the user questions (native questions component)

Do not use AskUserQuestion or external review tools — post questions on the issue and wait:

```bash
cat > q.json <<'EOF'
[{"header": "Storage", "question": "Where should X live?",
  "options": [{"label": "Reuse mechanism A", "description": "pros/cons…"},
              {"label": "New entity"}],
  "multiple": false}]
EOF
todou comment add -p <proj> 16 --body-file ctx.md --questions q.json --json   # note the comment id
todou question wait 16 <commentId> -p <proj> --timeout 43200 --json           # blocks until answered
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
todou spec status <n> -p <proj> --json                                  # versions + review verdict
todou spec comments <n> --unresolved --json                             # inline annotations (file+anchor)
todou spec resolve <n> <commentIds…>                                    # mark annotations addressed
todou spec review <n> --approve | --request-changes [--body …]          # submit a verdict
```

- Review state is computed, never stored: a verdict counts only against the **latest** version, and
  the pusher of a version cannot review it.
- Wait for the user's verdict with `issue watch <n> --type spec_review --since <cursor>`.
- Annotations remap across versions (resolved/outdated tracked automatically).
- The plan workflow on top of this lives in `/todou-plan` and `/todou-impl-plan`.
