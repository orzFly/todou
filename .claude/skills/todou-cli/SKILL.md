---
name: todou-cli
description: todou CLI quick reference — issue/comment/attach/watch commands, status-flow conventions, and the rules for how agents interact with the tracker. Read this first before touching a todou tracker.
---

# todou CLI

- Everything goes through the tracker: questions, reports, deliverables, reviews.
- Flags and examples: `todou <command> --help`.
- `<n>` takes `T-16`, `<proj>/16`, `#16` or a URL; `-p` takes a slug or id.
- Bodies: `--body-file -` with a `<<'EOF'` heredoc; `--body-file <(…) --questions <(…)` together.

## Commands

- `todou search <terms…> -p <proj> [--in issues,comments,specs]`
- `issue list -p <proj> [--open|--status X|--unread|-q text]` · `issue view <n> [--brief|--timeline --last 10]`
- `issue create -p <proj> --title T --body-file -` · `issue edit <n…> --status X [--add-label L]` · `issue close <n>`
- `issue block <n> --by <m>` · `issue unblock <n> --by <m>` · `issue transfer <n> --to <slug>`
- `comment add <n> --body-file -` · `comment list <n> [--last 5]` · `comment view <n> <id>`
- `todou me <n> is reviewing.` — IRC-style mini comment for an ACK; the result is still a full comment
- `attach <n> file…` · `attach list <n>` · `attach download <n> <id|name> [-o path]`
- `status list` · `label list` · `project members`

## Refs

- Writing a ref notifies that card: only when the link means something; "this card" for your own.
- Commits and source use the project's form (`T-16`), never a bare `#16`.

## Filing a card

- Create the card first; investigate on it afterwards.
- Body: the user's words verbatim (no blockquote) plus what they handed over, ending `— <who>, in the terminal, <date>`.
- Self-found: the observation and the command that measured it; unmeasured parts named.
- Your reading (cause, fix, related cards) is a comment right after.
- Title names the symptom, never an inferred cause.
- One unit of work per card; report which card got which part.

## Comments

- Conclusion first. No preamble, recap or closer.
- One point per comment; bold the claim; steps the reader must take are numbered.
- Don't restate what the reader can already see.
- Failure: cause, then fix; if still open, the one thing that unblocks it.

## Waiting

- `todou agent can-i-follow` — do what it prints; watch your card while you work.
- `issue watch <n> --since <cursor> --forever` · `watch -p <proj> --since <cursor> --forever [--mine]`
- Wait from the `cursor:` the write printed, not one taken afterwards.
- A wait killed from outside: restart with the same cursor. Resume from the closing `cursor:`.
- Watches skip your own agent session's entries.

## Status flow

- Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done
- Worker: Ready to Ship + summary comment. Orchestrator: Shipped. Only the user: Done.

### Taking a card

- `issue edit <n> --status "In Progress" --add-assignee @me` — one write.
- An assignee means held, never by whom (one machine account), and it is not a lock.

## Asking the user questions

- On the card, never AskUserQuestion. Every field below renders markdown:

```bash
todou comment add -p <proj> 16 --body-file <(cat <<'EOF'
Context the questions need.
EOF
) --questions <(cat <<'EOF2'
[{"header": "`--since`", "question": "Should `--since` accept a **timestamp**?",
  "options": [{"label": "Cursor only (Recommended)", "description": "Matches `spec wait`; a timestamp can skip entries."},
              {"label": "Both", "description": "Easier to type by hand."}],
  "multiple": false}]
EOF2
)
```

- Each question carries your recommendation and why.
- `question wait <n> <id> --forever`; moot → `question withdraw <n> <id> --reason …`.

## Spec documents

- Draft in a scratch dir; git never carries them.
- `spec push <n> <dir> --message vN [--if-version v] --wait` — the last stdout line is the outcome.
- `approved` (latest version only; confirm with `spec status`) · `changes_requested` · `feedback` · `withdrawn`.
- Exit 0 is not approval; only the latest version's approval allows implementing.
- Reworking a pending version: `spec withdraw <n> --if-version v` first.
- `spec comments <n> --unresolved` → revise → `spec resolve <n> <ids…>` → push again.
- Documents state the design as it stands: no history, no review notes, no copied card text.
- `proposal.md`: the user's requirements that have no tracker trace, verbatim.
- Reviewing: `spec review <n> --approve --version N | --request-changes | --comment`; the pusher may only `--comment`.
- `--annotations -`: `[{"path","body","quote"}]` (or `line_start`/`line_end`), against a `spec pull` of that version.

## Attachments

- `attach` prints `#id name → url`; paste the url verbatim.
- Demo pages and mockups go on the card, not local disk.
- No hand-written `curl` with a token from `config.toml`; use `attach download` or `todou api`.

## Markdown

- GFM: tables, `- [ ]` task lists, `~~strike~~`
- ```` ```mermaid ```` → diagram · ```` ```diff ```` → diff view · other fences highlighted
- `<details><summary>…</summary>…</details>` → fold (bare tags only)
- leading `---` YAML frontmatter → table
- `[name](/api/projects/<proj>/attachments/<id>/download/<name>)` → attachment link
- `![](…/download/shot.png)` → inline image · `![](…/download/page.html)` (any text file) → embedded document
- `T-1144` → issue (the project's own spelling; `#1144` only where it has no prefix)
- `#comment-1144` → comment 1144 of this project: comment ids are their own sequence, unrelated to issue T-1144
- `T-12#comment-34` → that comment on that card
- `<slug>#N`, `<slug>/T-N` → another project's issue
- `@login` → mentions a project member, notifies them
- Refs resolve when saved; one naming nothing stays plain text, silently.
- Code spans and fences are never linkified.
