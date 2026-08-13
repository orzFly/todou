---
name: todou-plan
description: Turn an approved design into a reviewable implementation plan as a todou spec set — proposal/design/api/plan documents pushed to the issue, refined through the inline-annotation review loop until the user approves. Invoked by /todou-brainstorm after design approval, or directly for cards whose design is already settled.
---

# todou plan

Produce the implementation plan for a card as a **spec set on the issue**, and drive it through
todou's spec review loop (inline annotations + approve/request-changes verdicts) until approved.
This replaces the old specs/-directory + external-review flow: git never carries the documents,
the tracker does. Read `/todou-cli` first; `<proj>` comes from the host project's config.

## The spec set

Work in a scratch directory (temp dir or an untracked path — these files are **never committed to git**):

- `proposal.md` — the user's original requirements, **excluding anything already recorded on the
  tracker**: the issue body, comments, and question answers live in the timeline and are referenced
  (`#N`, permalinks), never copied. What belongs here verbatim is only what has no tracker trace —
  requirements the user stated in the terminal/chat, decisions from outside channels — recorded like
  a transcript, with no judgment added. If a brainstorm preceded this (see /todou-brainstorm), start
  from its proposal.md.
- `design.md` — the system/architecture design in brief. Note any third-party library you introduce
  or well-known algorithm you hand-implement. If a brainstorm produced a validated design, carry it over.
- `api.md` — only when API design is involved: the endpoints/schemas.
- `plan.md` — the detailed executable plan. This is the deliverable the implementer follows;
  concrete steps, file-level where it helps, with verification baked in.

**Keep proposal.md current.** New information from the user during planning updates it in place;
corrections modify the relevant sections directly (never append conflicting entries). The meaning of
review annotations gets recorded there too. That counts as a user-requested modification, so it is allowed.

While planning, explore the code first; unresolved design details become **native questions** on the
card (`comment add --questions` + `question wait`, see /todou-cli) — not guesses.

## Success criteria

1. `proposal.md` holds the original requirements (existing content preserved, only user-driven edits).
2. `design.md` holds the system/architecture design.
3. `api.md` exists when API design is involved.
4. `plan.md` holds executable, detailed steps.
5. The spec set is pushed to the issue and the latest version carries an **approve** verdict.

After writing, self-check 1–4 (placeholders? contradictions? two-way-readable requirements? scope fit?)
and fix inline — iterate up to 5 times before presenting.

## Push and the review loop

```bash
todou spec push <n> <dir> -p <proj> --message "plan v1"          # upload the set
cursor=$(todou watch -p <proj> --poll --json | jq -r .next_cursor)
todou issue watch <n> -p <proj> --type spec_review --since "$cursor" --timeout 43200 --json
```

The watch returns when the user submits a verdict (exit 3 = timeout: re-poll a cursor and wait again).

**Never substitute `spec status` polling for this watch.** A status call issued seconds before the
verdict lands reports "unreviewed", and an agent that reacts by deciding to "check again in a few
minutes" has no wake path at all — it goes idle, nothing ever re-invokes it, and the card stalls until
a human notices. The blocking watch is the only thing that returns *when the verdict exists*.

- **request-changes** (or annotations arrive):
  `todou spec comments <n> --unresolved --json` lists inline annotations with file + anchor.
  Apply them to the documents, sync requirement changes into proposal.md, then
  `todou spec resolve <n> <commentIds…>` for each addressed annotation and
  `todou spec push <n> <dir> --if-version <v> --message "plan v2"` (the guard catches concurrent
  pushes; annotations remap across versions automatically). Wait again. Repeat until approved.
- **approve** → proceed.
- Review rules the server enforces: verdicts only apply to the latest version, and the pusher of a
  version cannot review it — the reviewer is the user, by construction.

## After approval

Invoke the **todou-impl-plan** skill to execute the plan. Do not invoke anything else; that is the
only next step. (Implementation is normally the same agent in the same worktree — you already hold
the full context.)
