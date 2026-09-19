---
name: todou-impl-plan
description: Execute an approved todou spec plan — pull the spec set from the issue, follow plan.md step by step with a task list, and deliver through the worker flow (commit with a Spec line, Ready to Ship, summary comment). Invoked by /todou-plan after the spec is approved, or directly when a card already has an approved spec.
---

# todou implement plan

Execute a plan that lives as an approved spec set on a todou issue. Read `/todou-cli` first.

## Steps

1. `todou spec status <n> -p <proj>`. The latest version must be `approved`; an older approval
   cannot authorize the current plan. If the current version is `withdrawn`, return to the
   investigation/rework loop in `/todou-plan`, push the ready replacement and wait for fresh approval.
   If a pending (`unreviewed`) version needs rework, withdraw the inspected version first with
   `todou spec withdraw <n> -p <proj> --if-version <v> [--reason "..."]`, then investigate and push.
   A `changes_requested` version goes directly to revision because withdrawal cannot undo a verdict.
   If still awaiting approval, run `todou spec wait <n> -p <proj>` and follow that review loop.
   Read its outcome:
   `withdrawn` and exit 0 are not permission to implement. Even an identical-content push from
   withdrawn creates a new unreviewed version. Recheck the latest status before implementing;
   do not defer this gate until after implementation starts.
2. `todou spec pull <n> <dir> -p <proj>` into a scratch directory (`mktemp -d`). Read whichever
   exist: `proposal.md` (requirements), `design.md`, `api.md`, `plan.md` (the steps).
3. Take the card (`/todou-cli`, "Taking a card"), then run `todou agent can-i-follow` and do what it
   says. Follow `plan.md`; with several steps, track them in a task list.
4. Verify against the plan's acceptance criteria, commit on your branch without merging, move the
   card to Ready to Ship, post a summary comment, report in the terminal.

## When reality contradicts the plan

Small deviations get a note in the summary comment. Anything that changes the design gets a native
question on the card (`comment add --questions` + `question wait`) before you proceed, and the answer
goes into `proposal.md` on the next spec push, if there is one — written as the requirement it now
is, not as a note about the question (`/todou-cli`, "Spec documents").

## The commit message

Add a `Spec:` line above the `Co-Authored-By:` line, naming the issue and the spec version the
implementation follows. Spell the card the way the project does: take it from the first line of
`todou issue view <n> --brief`. Where the repo's AGENTS.md sets a different convention, that wins,
because a public mirror autolinks a bare `#N` to unrelated numbering.

```
feat: implement the xyz feature

Spec: <card ref> spec v3
Co-Authored-By: <model> <noreply@anthropic.com>
```
