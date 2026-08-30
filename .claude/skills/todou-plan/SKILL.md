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
  (issue refs — spelled as /todou-cli says, permalinks), never copied. What belongs here verbatim is only what has no tracker trace —
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
# The push answers with the cursor to wait from — no separate "now" cursor,
# and therefore no window between the two calls for the verdict to hide in.
cursor=$(todou spec push <n> <dir> -p <proj> --message "plan v1" --print-cursor)
todou issue watch <n> -p <proj> --since "$cursor" --debounce 60 --forever
```

**Re-entering the wait after a crash or a killed shell: `todou spec status <n>` first, and only
block while no verdict is in.** A wait is a bet that the thing you want is still in the future.

The watch covers the whole issue, unfiltered, so a plain comment — the user amending a requirement,
asking back — wakes you as surely as a verdict does. It also means **not every wake-up is yours**:
sibling agents on the same machine account pass the self-filter (it is per agent session, see
/todou-cli). Judge every wake-up (exit 0) with `spec status`, never by reading the event stream:

1. `todou spec status <n> -p <proj>` → its first line carries the verdict and the unresolved count.
2. `approved` → done; leave the loop.
3. `changes_requested`, or any unresolved annotations → the revision path below.
4. Neither → no verdict yet. Comments by others in the watch output are feedback: fold them into
   the documents (update proposal.md, reply if an answer is owed, push if the docs changed).
   Nothing but sibling-agent activity? Not yours — resume the wait, silently.
5. Resume with the cursor the watch printed on its last line — never a fresh "now" cursor, which would skip
   whatever landed in the gap. Under `--forever` the watch only ever returns with entries (exit 0) or
   a fatal error (exit 1); a wait killed from outside is the one case to restart by hand, same cursor.

**Two prohibitions, one per failure mode.** Never replace the blocking watch with `spec status`
polling — a deferred "check again later" has no wake path; the agent goes idle, the card stalls.
Never infer the verdict from watch items — an unrelated wake-up misread as approval is worse than
the idle wait it replaces. The watch wakes; `spec status` judges.

- **request-changes** (or annotations arrive):
  `todou spec comments <n> --unresolved` lists inline annotations with id, file + anchor, and body.
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
