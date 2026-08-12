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
todou issue edit 16 --status "In Progress"    # status/title/labels/assignees
todou issue close 16 --comment "done"
todou comment add -p <proj> 16 --body-file f  # long bodies: --body-file /dev/stdin <<'EOF'
todou attach -p <proj> 16 file.png ...        # mime inferred from the extension
todou status list -p <proj>
```

Forgiving forms (gh habits all work): `issue show` = `view`, `issue comment` = `comment add`,
and every `<number>` positional also accepts `<proj>/16`, `"#16"`, or a full issue URL.

## watch / poll (the agent's radar)

```bash
todou issue watch 16 --since <cursor> --timeout 43200 --json  # wait on one issue
todou watch -p <proj> --since <cursor> --timeout 43200 --debounce 60 --json  # wait on the whole project, others only
```

Use a 12-hour timeout (43200) and a 60-second debounce as the standard values.

- Exit codes: **0 = new entries** (stdout is `{items, next_cursor}`), **3 = timeout with nothing new**
  (normal, not an error), 1 = error.
- Cursors are interchangeable project-wide: `issue view`, watch output, and `--poll` all produce them.
  They survive process restarts, and events during an outage are all delivered on reconnect, without duplicates.
- Get a "now" cursor: `todou watch -p <proj> --poll --json` (exit 3 with empty items is expected).
- `--debounce N`: after the first new entry, keep collecting for N seconds and return one batch (fewer wake-ups, fewer tokens).
- Project watch skips entries made by the current account by default (so same-account sibling agents never wake each other); `--any-actor` disables the filter.
- Unread: `issue list` marks issues with unseen outside activity with `●`, `--unread` filters to them,
  and `view` marks as read (local state under `~/.local/state/todou/`).

## Rich content in bodies and comments

- `#N` renders as a rich issue link (exempt inside code blocks / inline code); pasted comment permalinks render richly too.
- Attachment references are just real download URLs: `[name](…/attachments/12/download/name.ext)` renders
  as a rich attachment link, and `![]()` images render inline.
- Single-file demo pages (mockups, prototype HTML) **must** be attached to the relevant issue with
  `todou attach` — never leave them only on local disk.
- Timestamps are permalinks (`#comment-<id>`); opening one scrolls to and highlights the entry.

## Status flow (who moves what)

```
Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done
```

(If a project lacks these statuses, create them in this order; Ready to Ship / Shipped are open-category.)

- **Worker agents**: move the card to In Progress when starting; move it to Ready to Ship when development
  is complete (commits on their own branch, not merged), and post a summary comment.
- **The orchestrator**: moves cards to Shipped after merge + deploy.
- **Only the user** moves a card to Done, after verifying. Never do this on the user's behalf.

## Asking the user questions

Do not use AskUserQuestion or external review tools. Compose the question as a comment with
**numbered options** (include your recommendation and reasoning, so the user can reply with a couple of
characters), post it on the relevant issue, then block on
`issue watch <n> --since <cursor> --timeout 43200`; on timeout re-poll a cursor and wait again —
never guess with sleep. One comment may carry 2–3 tightly related small questions.
(Once the questions component is available, switch to `comment add --questions` + `question wait`.)
