---
name: todou-cli
description: todou CLI quick reference — issue/comment/attach/watch commands, cursor semantics, status-flow conventions, and the rules for how agents interact with the tracker. Read this first before touching a todou tracker.
---

# todou CLI

todou is the team's issue tracker. Questions, reports, deliverables and reviews go through it so that
everything leaves a record. Project facts (slug, server, sandbox project, deploy command) live in the
host project's CLAUDE.md or memory; `<proj>` below stands for the slug. Details needed only sometimes
are in `references/` next to this file.

## Basics

1. Run `todou` as is. The CLI config selects the machine-account profile prepared for agents.
2. Every command talks to the server. If the harness sandbox blocks network sockets, run todou with
   the sandbox disabled.
3. Read the human output. It carries every id, ref, count and cursor you need. Use `--json` only when
   a script parses stdout (`references/scripting.md`). `todou api <method> <path>` covers anything
   the CLI lacks.
4. Wait from the cursor the write itself printed. `spec push` and `comment add` end with a `cursor:`
   line holding their own position, so every answering entry is after it; a cursor taken afterwards
   can already be past the answer, and a wait started there never returns. `--print-cursor` prints it
   bare for `cursor=$(…)`, `--since <cursor>` on the same write lists what arrived after it. Other
   writes print no cursor; `issue view` or `todou watch --poll --print-cursor` gives a current one.
5. Experiments go to the sandbox project when the deployment has one, never to the real tracker.

## Command cheat sheet

```bash
todou search <terms…> -p <proj> [--in issues,comments,specs] [--status X] [--limit N]
#   ^ the only read that sees comments and specs, where conclusions and verdicts are written;
#     case-insensitive substrings joined by AND (so 中文 works); each hit names what to read
#     next; issue list -q covers titles and bodies only. Details: references/search.md
todou issue list -p <proj> [--open|--closed|--status X,Y|--unread|-q text]  # ends with a count
todou issue view 16 -p <proj>       # prints a cursor at the end, for watch --since
todou issue view 16 --brief         # header + status only, no body, no timeline
todou issue view 12 15 23 --brief   # several cards at once; a bad number errors in place, exit 1
todou issue view 16 --timeline --last 10   # drop the body, keep the newest 10 entries
todou issue events 16 [--type referenced] [--last 5]   # timeline minus comments, event id first
todou issue create -p <proj> --title T [--body-file -] [--status Next]
#   ^ when filing on behalf of the user, quote their original words verbatim in the body
todou issue edit 16 --status "In Progress"    # status/title/labels/assignees
todou issue edit 12 15 23 --status Next       # one set of flags, every card; checked before it writes
todou issue transfer 16 --to <slug> [--dry-run] [-y]   # move to another project
todou issue close 16 --comment "done"
todou comment add -p <proj> 16 --body-file -  # prints the new comment's id + a wait cursor
todou comment list 16 [--author @me] [-q text] [--last 5]   # full bodies, each headed by its id
todou comment view 16 123                     # one comment by id (`#comment-123` and permalinks work)
todou comment delete 16 123 -y                # take back a misfire; not reversible, no trash
todou attach -p <proj> 16 file.png ...        # prints `#id name → url`
todou attach list -p <proj> 16                # id / filename / size / url
todou attach download -p <proj> 16 <id|name> [-o <path>|-o -]
todou config show [--json]                    # resolved config and where each part came from; no token values
todou project members -p <proj>               # logins for -a/--assignee and --exclude-actor
todou status list -p <proj>
todou status init -p <proj>                   # add the missing canonical statuses, sync existing colors
todou status create -p <proj> --name X --category open|closed [--color '#hex'] [--before Y|--after Y]
todou status edit X [--name N] [--category C] [--color '#hex'] [--before Y|--after Y] [--default]
todou status delete X                         # refused (409) while issues still use it
todou label list -p <proj>                    # label create/edit/delete: references/labels.md
```

gh spellings work too: `issue show` = `view`, `issue comment` = `comment add`, `issue update` = `edit`,
`issue status <n> <status>` = `issue move <n> <status>` = `edit --status`; `-t/-b/-F/-l/-a` on
`issue create`, `-l/-a/-L/-S/-s --state open|closed|all` on `issue list`, `-c` on `issue close`, `@me`
wherever a login goes. Every `<number>` also accepts `<proj>/16`, `"#16"`, `T-16`, a full URL, or the
address a stored reference is written with (`/projects/7/issues/16`). A project may be spelled as its
id anywhere its slug goes, `-p` included.

**A prefix is resolved, not ignored.** `T-16` means the project that holds `T` — the current one if
that is its prefix, otherwise whichever readable project claims it deployment-wide. A prefix nobody
holds, one several projects hold, and one that disagrees with `-p/--project` are all refused (exit 1)
before anything is read, so a ref pasted from another project cannot hand you a different card. `-p`
therefore stays a fence: to reach another project either drop it or write `alpha/16`. `<proj>/T-16`
is checked against that project's own prefixes, current and retired.

## Several cards at once

- `--status` and `--label` accept several names, repeated or comma-separated, and match any of them.
- `view` prints the cards in the order given, each with its own cursor. A number that cannot be read
  prints an error in its place, the others still print, and the exit code is 1.
- `edit` reads every card before it writes any, so a mistyped number fails the command with nothing
  written. Writes happen in order and stop at the first failure, naming what was not attempted;
  rerunning the whole list is safe. `--title` and `--body` are refused on several cards. `close`,
  `delete`, `comment add` and `spec status` take one card.

## Writing bodies

`--body-file -` reads the body from stdin:

```bash
todou issue create -p <proj> --title "…" --body-file - <<'EOF'
Multi-paragraph markdown — code blocks, CJK, blank lines — all survive verbatim.
EOF
```

`--body-file` and `--questions` also accept process substitution (`<(…)`), which is how a body and
questions travel in one call. Stdin is a single stream, so only one of the two may be `-`.

A path given to `--body` is caught, because that one-word slip would post a filename as the whole
body: `--body /dev/stdin`, `--body -` and `--body /dev/fd/63` are refused before anything is written;
an existing file path still posts, with a warning (`--allow-body-path` silences both). `comment add`
echoes the body's size and opening next to the new id; that line proves what was posted. Attach a
value that starts with `--` to its flag: `--title=--body …`.

## Filing what the user asked for

A request to file a card asks for the card, not for a report.

1. Create the card first; reading code, reproducing and scoping happen on the card afterwards. The
   one read to do first is `todou search`: an existing card on the same subject gets a comment
   instead of a duplicate.
2. Quote the user's original words verbatim in the body. Your reading of them goes above the quote.
3. Split what was said into units of work. Two unrelated complaints in one sentence are two cards;
   three bullets about the same surface are one card. Report back which card got which part.

## Labels

- Do not pre-create labels. A label flag on a write creates a missing label and reports it on stderr.
  `label create` is for recoloring and bulk setup.
- `--add-label` and `--remove-label` edit the set; `--label` replaces the whole set. Use `--add-label`
  unless you mean to replace. Both accept several names. Details: `references/labels.md`.

## Waiting: watch, question wait, spec wait

```bash
todou agent can-i-follow                                               # which follow mode this harness supports
todou issue watch 16 -p <proj> --since <cursor> --forever              # one issue
todou watch -p <proj> --since <cursor> --debounce 60 --forever         # whole project, other people's entries
todou question wait 16 <commentId> -p <proj> --forever                 # answers to one question comment
todou spec push 16 <dir> -p <proj> --message "v2" --wait               # push, then wait for the verdict
todou spec wait 16 -p <proj> [--since <cursor>]                        # re-enter that wait
todou watch -p <proj> --follow=uds                                     # stay resident, push each batch to this session
todou issue watch 16 -p <proj> --follow=uds                            # the same, on one card
```

- Which way of waiting this harness can use is not something to guess: run `todou agent can-i-follow`
  and do what it says. It reads no server and resolves no project, so it answers at any point in a
  session, and it is the only place that judgement is written down.
- Use `--forever` (`spec wait` always behaves this way): one call, no loop around it, ending only as
  exit 0 with entries or exit 1 on a fatal error, which you report. Timeouts and outages are handled
  inside the command, which resumes from the cursor it holds.
- A wait killed from outside (the harness stopping a background task) is not an error. The kill
  notification is your wake-up; restart the wait with the same cursor, every time. A short self-poll
  instead costs an agent turn per tick.
- `--follow` (on both commands) does not exit with the first batch: it stays resident and delivers
  every batch, so a sentinel costs one background task rather than a tool call per batch. Two
  transports, never guessed from the environment: `--follow` / `--follow=stdout` writes each batch to
  stdout; `--follow=uds` (alias `claude-code-messaging`) pushes it into the Claude Code session that
  exported `CLAUDE_CODE_MESSAGING_SOCKET`, and refuses up front if it is unset. Implies `--forever`;
  conflicts with `--poll` and `--print-cursor`, on both commands. `--debounce` defaults to **60s**
  here, because the receiving side charges every message a fixed boilerplate cost; `--debounce 0`
  restores immediate delivery.
- **Under `--follow=uds` stdout stays empty while pushing works**, because printing as well as
  pushing would hand you every batch twice. What it writes instead is the degrade: the batches it
  could not get delivered, plus a `cursor:` line, then exit 0. Each push's `since:` / `cursor:` lines
  chain into the next, and a break in that chain means a notification went missing. The degrade path,
  the sender names and the exit codes: `references/scripting.md`.
- A wait returns only for entries created after its cursor, so when you wait for a state (a verdict,
  an answer, a status), read the state first and block only while it is not there yet. `spec wait`
  and `question wait` do this themselves; before an `issue watch`, run `issue view --brief`.
- Each line reads `<ref> <who> <what> <when>: <summary>`, a comment line carrying the start of its
  body, which is what you act on (`--summary <chars>` sets the width, default 120). Resume from the
  closing `cursor:` line; a newer cursor skips what arrived in between. `--debounce N` returns one
  batch N seconds after the first entry.
- `issue watch` and `todou watch` skip entries from your own agent session, not from your whole
  account, so a sibling agent on the same machine account does wake them; `spec wait` skips the whole
  account. Entries without an agent session (the web UI) count as the account. `--any-actor` turns
  the filter off; `issue watch --exclude-actor <login>` filters one account instead.

A single-issue cursor does not cross a move: it is a row position in the project the card has left.
`issue watch` on a moved card prints `moved to …` and a cursor for its new home; reopen the watch
there with that cursor. For a wait that no write precedes, `--poll --print-cursor` gives a current
one. `issue list` marks unseen activity by others with `●`, and `--unread` filters to it. Heartbeat
and poll cadence, cursor recipes, unread state, exit codes, NDJSON and stdout/stderr separation:
`references/scripting.md`.

## Attachments, permalinks, refs

- `todou attach` prints `#id name → url`. Paste the URL verbatim: `[name](url)` links it, `![](url)`
  embeds it inline. Attach single-file demo pages (mockups, prototypes) to the issue instead of
  leaving them on local disk. `attach list` is the authoritative set; `attach download <id|name>`
  reads one back.
- Do not copy a token out of `config.toml`: `attach download` and `todou api` authenticate like every
  other command, so a hand-written `curl` with a pasted Bearer token is a credential leak for
  nothing. `todou config show` prints the resolved config without any token value.
- Every timestamp is a permalink (`#comment-<id>`, `#event-<id>`); `comment view` accepts one.
- **Write `#N` and forget about it.** The server resolves a reference when it is submitted and stores
  the answer as a link — `[#12](/projects/7/issues/12)` — so what you read back is what it means, and
  saving it again changes nothing. A token that comes back unchanged resolved to nothing: the card is
  not there, or you cannot read it. That is the answer, not a rendering failure.
- **An address in stored text pastes straight back in.** `todou issue view /projects/7/issues/12`,
  `todou comment view /projects/7/issues/12#comment-34`, and `-p 7` all work — a project id is a
  spelling every command takes.
- Do not guess how a project spells its refs: `#12` or `T-12` is a per-project setting, and every
  command that knows an issue prints it spelled. A ref notifies the card it points at, so write one
  only when the link carries meaning; do not enumerate incidental cards, and write "this card"
  instead of a ref to the card you are on. In source and commit messages use the project's form;
  where the project has no prefix, name the tracker in prose instead of writing `#N`, because a
  public mirror autolinks `#N` to its own issues.

Details: `references/rich-content.md`.

## Comment discipline

A tracker comment is a record the user scans between other work, not an essay.

- **Conclusion first.** The finding, the decision, the number. Context after, if at all.
- **No preamble, no recap, no closer.** Not "先说结论", not "综上", not "有问题随时说".
- **Bold the claim, one line of why.** Anything the reader must do becomes numbered steps. A list that
  mixes "now" and "later" is two lists.
- **One point per comment.** Two unrelated findings are two comments, or one card and one comment.
- **Do not restate what the reader can already see**: the card body, or what you did before you found
  the result. Open with the point and stop when it is made.

State failures plainly: cause, then fix. If something stays open, name the single thing that unblocks
it. Length follows evidence: a shipped-summary with test counts, shas and a surprising diff can run
long; a triage note cannot.

## Status flow (who moves what)

```
Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done
```

New projects are seeded with all of these; `todou status init -p <proj>` adds the missing ones to an
older project in canonical order.

- Worker agents move a card to In Progress when starting, and to Ready to Ship when development is
  complete (commits on their own branch, not merged), with a summary comment.
- The orchestrator moves cards to Shipped after merge and deploy.
- Only the user moves a card to Done, after verifying. Never do this on the user's behalf.

## Asking the user questions

Post the questions on the issue and wait. Do not use AskUserQuestion or external review tools.

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
todou question wait 16 <commentId> -p <proj> --forever   # blocks until answered
```

- `question wait` reads the answer state before it blocks, so an answer that arrived first is
  returned at once. The `cursor:` line the comment prints is for waiting on a plain reply instead:
  `todou issue watch 16 --since "$cursor" --forever`.
- All text fields are markdown; validation is strict, and an unknown field fails with its path named.
  The user answers all questions of one comment together; "decline to answer" is built in; options and
  a free-text "other" can coexist. `question list <n> --unanswered` shows what is still open.
- One comment carries two or three closely related questions, each with your recommendation and its
  reasoning, so the user can answer with a few characters.

## Spec documents (plans, proposals, reviewable docs)

A spec set is a group of versioned markdown files attached to an issue. It replaces specs/
directories and external review tools. Write the documents in a scratch directory made with
`mktemp -d` (a fixed path collects another card's leftovers) and push them; git never carries them.

```bash
todou spec push <n> <dir> -p <proj> --message "v2" [--if-version <v>] [--wait]
todou spec wait <n> -p <proj> [--since <cursor>]           # re-enter a killed wait
todou spec pull <n> <dir> -p <proj> [--version <v>] [--prune]
todou spec list -p <proj> [--state open|closed|all]        # which cards have specs, and where each stands
todou spec status <n> -p <proj>                            # versions, verdict, unresolved count
todou spec comments <n> --unresolved                       # inline annotations (file + anchor)
todou spec resolve <n> <commentIds…>
todou spec review <n> --approve | --request-changes [--body …]
```

A spec document states the design as it stands, not how it got there. No "v3 said X, v4 changed it to
Y" passages, no "the review asked for Z", and no list of corrections to another document: a correction
rewrites the sentence it corrects and folds its reason into the prose. Where a change came from is
already recorded — in the card's comments and in the spec's own version history. `proposal.md` holds
the user's requirements that have no tracker trace, quoted verbatim without commentary; the card body,
comments and question answers are referenced, never copied; and what a review annotation established
is recorded as the requirement it now is, not as a note about the annotation.

**The review gate is one command**: `spec push … --wait`. It pushes, waits on the whole issue from the
push's own position, and reads the verdict from the spec's state at every wake-up. The last stdout
line is the outcome; all three exit 0, only a fatal error exits 1.

| Last line | Meaning | Then |
|---|---|---|
| `approved · spec v2` (with `· N unresolved annotations` when any remain) | approve verdict on the current version; remaining annotations are nits to fix while implementing | proceed |
| `changes requested · spec v3 · N unresolved annotations` | request-changes verdict, or annotations left unresolved on an unreviewed version (a revision pushed without `spec resolve`) | revision loop |
| `feedback · no verdict on spec v2 yet` | someone else wrote on the card; their entries print above | fold them into the documents, reply if a reply is owed, point the user at the review controls, then push if the documents changed and `spec wait` again if they did not |

Revision loop:

1. `todou spec comments <n> -p <proj> --unresolved` lists each annotation with id, file, anchor and body.
2. Revise the documents. Requirement changes go into `proposal.md` as well.
3. `todou spec resolve <n> <ids…>` for each annotation you addressed.
4. Push again with `--if-version <v> --wait`. The guard rejects a concurrent push; annotations follow
   the text across versions.

Re-entry after a killed wait: `todou spec wait <n> --since <cursor>` with the cursor from the
`cursor:` line; without `--since` the wait starts where the current version was pushed and replays
what was said since. The server enforces two rules: a verdict counts only against the latest version,
and the account that pushed a version cannot review it. Do not poll `spec status` instead of waiting,
and do not read a verdict off the event stream; `spec wait` reads the spec's state for you.
