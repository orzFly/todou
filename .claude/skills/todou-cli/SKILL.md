---
name: todou-cli
description: todou CLI quick reference — issue/comment/attach/watch commands, status-flow conventions, and the rules for how agents interact with the tracker. Read this first before touching a todou tracker.
---

# todou CLI

todou is the team's issue tracker. Questions, reports, deliverables and reviews go through it so that
everything leaves a record. `<proj>` below stands for the project slug. Details needed only sometimes
are in `references/` next to this file.

## Command cheat sheet

```bash
todou search <terms…> -p <proj> [--in issues,comments,specs] [--status X] [--limit N]  # references/search.md
todou issue list -p <proj> [--open|--closed|--status X,Y|--unread|-q text]
todou issue view 16 -p <proj>
todou issue view 16 --brief
todou issue view 12 15 23 --brief             # several cards at once
todou issue view 16 --timeline --last 10
todou issue events 16 [--type referenced] [--last 5]
todou issue create -p <proj> --title T [--body-file -] [--status Next]
#   ^ the body carries the report only; your reading of it is a comment (see "Filing a card")
todou issue edit 16 --status "In Progress"    # status/title/labels/assignees
todou issue edit 12 15 23 --status Next       # one set of flags, every card; checked before it writes
todou issue transfer 16 --to <slug> [--dry-run] [-y]
todou issue close 16 --comment "done"
todou comment add -p <proj> 16 --body-file -
todou comment list 16 [--author @me] [-q text] [--last 5]
todou comment view 16 123
todou comment delete 16 123 -y                # take back a misfire; not reversible, no trash
todou attach -p <proj> 16 file.png ...
todou attach list -p <proj> 16
todou attach download -p <proj> 16 <id|name> [-o <path>|-o -]
todou config show [--json]
todou project members -p <proj>
todou status list -p <proj>
todou status init -p <proj>                   # add the missing canonical statuses
todou status create -p <proj> --name X --category open|closed [--color '#hex'] [--before Y|--after Y]
todou status edit X [--name N] [--category C] [--color '#hex'] [--before Y|--after Y] [--default]
todou status delete X
todou label list -p <proj>                    # label create/edit/delete: references/labels.md
```

## Refs

Every `<number>` accepts `<proj>/16`, `"#16"`, `T-16`, a full URL, or the address a stored reference
is written with (`/projects/7/issues/16`), and a project may be spelled as its id anywhere its slug
goes, `-p` included. Input takes any spelling; output uses the project's.

A ref notifies the card it points at, so write one only when the link carries meaning: do not
enumerate incidental cards ("rebased onto latest master" says more than a list of the cards the
branch passed), and write "this card" for the card you are on. In source and commit messages use the
project's form; where the project has no prefix, name the tracker in prose instead of writing `#N`,
because a public mirror autolinks `#N` to its own issues.

## Writing bodies

`--body-file -` reads the body from stdin:

```bash
todou issue create -p <proj> --title "…" --body-file - <<'EOF'
Multi-paragraph markdown — code blocks, CJK, blank lines — all survive verbatim.
EOF
```

`--body-file` and `--questions` also accept process substitution (`<(…)`), which is how a body and
questions travel in one call. Stdin is a single stream, so only one of the two may be `-`.

## Filing a card

A request to file a card asks for the card itself; the analysis follows on it.

1. Create the card first; reading code, reproducing and scoping happen on the card afterwards.
2. **The body holds only what a later measurement cannot overturn**: the user's own words, and
   whatever they handed over with them — a log, a DOM fragment, a link, a screenshot. Paste their
   words in as they were written, with no blockquote around them; the body's last line already says
   where they came from — `— <who>, in the terminal, <date>`. Everywhere else, a quotation is still
   quoted.
3. **Your reading of it is a comment, posted right after you create the card**: the cause you
   suspect, what you measured, the fix you would pick, the neighbouring cards. A body is the premise
   the next agent starts from; a comment can be answered and overturned in place.
4. The title names the reported symptom, never a cause you inferred. It is the one field that
   `issue list`, every watch line and every resolved ref renders.
5. Split what was said into units of work. Two unrelated complaints in one sentence are two cards;
   three bullets about the same surface are one card. Report back which card got which part.

A problem you found yourself has nothing to quote, and its body takes the observation and the
evidence instead, each measurement carrying the command or the run that produced it, with the parts
you have not measured named as unmeasured. The cause you infer from that evidence and the fix you
would pick are still a comment. What this keeps out of a body is inference, not analysis.

## Waiting: watch, question wait, spec wait

```bash
todou agent can-i-follow                                               # ask first, then do what it prints
todou issue watch 16 -p <proj> --since <cursor> --forever              # one issue
todou watch -p <proj> --since <cursor> --debounce 60 --forever         # whole project, other people's entries
todou question wait 16 <commentId> -p <proj> --forever                 # answers to one question comment
todou spec push 16 <dir> -p <proj> --message "v2" --wait               # push, then wait for the verdict
todou spec wait 16 -p <proj> [--since <cursor>]                        # re-enter that wait
```

- Run `todou agent can-i-follow` and do what it says. It prints the instructions for this harness.
- Wait from the cursor the write itself printed: `spec push` and `comment add` end with a `cursor:`
  line holding their own position, and a cursor taken afterwards can already be past the answer.
- A wait killed from outside (the harness stopping a background task) is your wake-up, not an error:
  restart it with the same cursor, every time.
- Resume from the closing `cursor:` line.
- `issue watch`, `todou watch` and `spec wait` skip entries from your own agent session rather than
  your whole account.

Exit codes, cursor recipes, NDJSON and stdout/stderr separation: `references/scripting.md`.

## Attachments

- `todou attach` prints `#id name → url`. Paste the URL verbatim: `[name](url)` links it, `![](url)`
  embeds it inline. Attach single-file demo pages (mockups, prototypes) to the issue instead of
  leaving them on local disk.
- Do not copy a token out of `config.toml`: `attach download` and `todou api` authenticate like every
  other command, so a hand-written `curl` with a pasted Bearer token is a credential leak for
  nothing.

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

- Worker agents take a card (below) when starting, and move it to Ready to Ship when development is
  complete (commits on their own branch, not merged), with a summary comment.
- The orchestrator moves cards to Shipped after merge and deploy.
- Only the user moves a card to Done, after verifying. Never do this on the user's behalf.

### Taking a card

Starting work is one write, status and assignee together:

```bash
todou issue edit <n> -p <proj> --status "In Progress" --add-assignee @me
```

**The assignee says that a card is held, never by whom.** Every agent on a machine authenticates as
one machine account, so yours and another agent's are the same login. That is enough, because the
orchestrator never assigns itself — an assignee at all means held, by an agent or by the user. Read
it back from `issue view --brief`, from the `issue list` column that appears once any card in the
project has one, or from `issue list -a @me`.

It is a marker rather than a lock: `--add-assignee @me` on a card another agent already took returns
`updated` and writes no event, so it neither fails nor warns. What keeps two agents off one card is
the orchestrator declining to dispatch a card that has an assignee.

The assignee comes off when the agent holding the card is retired, which is the orchestrator's step.
A card stays assigned across Ready to Ship and through the merge, and a planning agent's card keeps
its assignee through the hand-off to the implementation agent that replaces it.

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

One comment carries as many closely related questions as the decision needs — asking more beats
guessing — each with your recommendation and its reasoning, so the user can answer with a few
characters.

## Spec documents (plans, proposals, reviewable docs)

A spec set is a group of versioned markdown files attached to an issue. It replaces specs/
directories and external review tools. Write the documents in a scratch directory made with
`mktemp -d` and push them; git never carries them.

```bash
todou spec push <n> <dir> -p <proj> --message "v2" [--if-version <v>] [--wait]
todou spec wait <n> -p <proj> [--since <cursor>]           # re-enter that wait
todou spec pull <n> <dir> -p <proj> [--version <v>] [--prune]
todou spec list -p <proj> [--state open|closed|all]        # which cards have specs, and where each stands
todou spec status <n> -p <proj>                            # versions, verdict, unresolved count
todou spec comments <n> --unresolved                       # inline annotations (file + anchor)
todou spec resolve <n> <commentIds…>
todou spec review <n> --approve | --request-changes | --comment [--body …] [--annotations <file|->]
```

`--comment` is a review that judges nothing: it records the summary and the annotations and leaves
the version awaiting a verdict. It is the only form the account that pushed the version may submit —
`--approve` and `--request-changes` from that account are refused, which is what stops a fleet of
agents sharing one machine account from signing off its own specs.

`--annotations` stages inline comments with any of the three verdicts. The file is a JSON array;
each entry needs `path` and `body` and points with exactly one of `quote` (verbatim text, located
locally, must match the file exactly once — this also derives the columns), `line_start` +
`line_end` (optionally `col_start` + `col_end`), or neither key, which anchors the whole file. The
anchor is always the version being reviewed. Write them against a `spec pull` of that version:

```bash
todou spec pull 23 ./spec -p <proj>
printf '%s' '[{"path":"design.md","quote":"one read-time count","body":"why not a column?"}]' \
  | todou spec review 23 -p <proj> --comment --annotations - --body "three spots"
```

A spec document states the design as it stands, and never how it got there: no "v3 said X, v4 changed
it to Y", no "the review asked for Z", no list of corrections to another document — a correction
rewrites the sentence it corrects and folds its reason into the prose. `proposal.md` holds the user's
requirements that have no tracker trace, quoted verbatim without commentary, split as `Filing a card`
splits a report. The card body, comments and question answers are never copied, and referenced only
where the reference does work — repeating what the reader has already read serves nobody. What a
review annotation established is recorded as the requirement it now is, never as a note about the
annotation.

**The review gate is one command**: `spec push … --wait`. It pushes, waits on the whole issue from the
push's own position, and reads the verdict from the spec's state at every wake-up. The last stdout
line is the outcome.

Revision loop:

1. `todou spec comments <n> -p <proj> --unresolved` lists each annotation with id, file, anchor and
   body.
2. Revise the documents. Requirement changes go into `proposal.md` as well.
3. `todou spec resolve <n> <ids…>` for each annotation you addressed.
4. Push again with `--if-version <v> --wait`. The guard rejects a concurrent push; annotations follow
   the text across versions.

A verdict counts only against the latest version, and the account that pushed a version cannot give
it one (`--comment` excepted).
