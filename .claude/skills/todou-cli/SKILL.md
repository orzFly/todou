---
name: todou-cli
description: todou CLI quick reference — issue/comment/attach/watch commands and the rules for filing, commenting, asking and writing specs on a todou tracker. Read this first before touching a todou tracker; the agent workflow (status flow, taking an issue, the spec gate) is /todou-workflow.
---

# todou CLI

- Everything goes through the tracker: questions, reports, deliverables, reviews.
- Status flow, taking an issue and the spec gate: `/todou-workflow`.
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

- Writing a ref notifies that issue: only when the link means something; "this issue" for your own.
- Commits and source use the project's form (`T-16`), never a bare `#16`.

## Filing an issue

- Create the issue first; investigate on it afterwards.
- Body: the user's words verbatim (no blockquote) plus what they handed over, ending `— <who>, in the terminal, <date>`.
- Self-found: the observation and the command that measured it; unmeasured parts named.
- Your reading (cause, fix, related issues) is a comment right after.
- Title names the symptom, never an inferred cause.
- One unit of work per issue; report which issue got which part.

## Comments

- Conclusion first. No preamble, recap or closer.
- One point per comment; bold the claim; steps the reader must take are numbered.
- Don't restate what the reader can already see.
- Failure: cause, then fix; if still open, the one thing that unblocks it.

## Waiting

- Run `todou agent how-to-watch` first and do what it prints.
- `issue watch <n> --since <cursor> --forever` · `watch -p <proj> --since <cursor> --forever [--mine]`
- Wait from the `cursor:` the write printed, not one taken afterwards.
- A wait killed from outside: restart with the same cursor. Resume from the closing `cursor:`.
- Watches skip your own agent session's entries.

## Asking the user questions

- On the issue, never AskUserQuestion. Every field below renders markdown:

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
- `not waiting`: a mermaid diagram does not parse (stderr names `file:line`); fix it and push again
  with `--if-version`. Comment and issue writes print the same warning with the command to update.
- Exit 0 is not approval.
- Reworking a pending version: `spec withdraw <n> --if-version v` first.
- `spec comments <n> --unresolved` → revise → `spec resolve <n> <ids…>` → push again.
- Documents state the design as it stands: no history, no review notes, no copied issue text.
- `proposal.md`: the user's requirements that have no tracker trace, verbatim.
- Reviewing: `spec review <n> --approve --version N | --request-changes | --comment`; the pusher may only `--comment`.
- `--annotations -`: `[{"path","body","quote"}]` (or `line_start`/`line_end`), against a `spec pull` of that version.

## Attachments

- `attach` prints `#id name → url`; paste the url verbatim.
- Demo pages and mockups go on the issue, not local disk.
- No hand-written `curl` with a token from `config.toml`; use `attach download` or `todou api`.

## Markdown

- GFM: tables, `- [ ]` task lists, `~~strike~~`
- Fences that render: ```` ```mermaid ```` → diagram; ```` ```diff ```` / ```` ```patch ```` → diff view. Other fences are highlighted.
- `<details><summary>…</summary>…</details>` → fold (bare tags only)
- leading `---` YAML frontmatter → table
- `[name](/api/projects/<proj>/attachments/<id>/download/<name>)` → attachment link
- `![](…/download/<file>)` embeds an attachment: any image; `.md` rendered; `.patch` / `.diff` as a diff; `.html`, `.txt` and other text files as a document.
- `![before](/...) -> ![plan A](/...)` on a separated paragraph → compare images (side by side, swipe, …); each alt labels its side
- `T-1144` → issue (the project's own spelling; `#1144` only where it has no prefix)
- `#comment-1144` → comment 1144 of this project: comment ids are their own sequence, unrelated to issue T-1144
- `T-12#comment-34` → that comment on that issue
- `<slug>#N`, `<slug>/T-N` → another project's issue
- `@login` → mentions a project member, notifies them
- Refs resolve when saved; one naming nothing stays plain text, silently.
- Code spans and fences are never linkified.
