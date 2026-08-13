---
name: todou-impl-plan
description: Execute an approved todou spec plan — pull the spec set from the issue, follow plan.md step by step with a task list, and deliver through the worker flow (commit with a Spec line, Ready to Ship, summary comment). Invoked by /todou-plan after the spec is approved, or directly when a card already has an approved spec.
---

# todou implement plan

Execute a plan that lives as an **approved spec set on a todou issue**. Read `/todou-cli` first.

## Load the spec

```bash
todou spec status <n> -p <proj> --json     # confirm the latest version carries an approve verdict
todou spec pull <n> <dir> -p <proj>        # fetch the set into a scratch dir (never committed)
```

Read whichever of these exist (ignore missing ones):

- `proposal.md` — the user's original requirements
- `design.md` — the overall design
- `api.md` — the API design involved
- `plan.md` — the concrete execution plan

If the latest version is **not** approved, stop and run the review loop from `/todou-plan` instead of
implementing an unapproved plan — meaning **block on `todou issue watch <n> --type spec_review --since
<cursor>`**. Never plan to re-check `spec status` later: a status call can miss a verdict that lands
seconds afterwards, and a deferred re-check has no wake path — the agent goes idle forever.

## Execute

Follow `plan.md`. If it has multiple steps, create a task list and manage progress through it.
Move the card to In Progress if it isn't already.

Where reality contradicts the plan (an assumption was wrong, a step is impossible as written), don't
silently improvise: small deviations are fine with a note in the final summary; anything that changes
the design gets a native question on the card (`comment add --questions` + `question wait`) before
proceeding — and the answer recorded into `proposal.md` on the next spec push, if there is one.

## Deliver

Follow the standard worker wrap-up (see /todou-cli): verify per the plan's acceptance criteria,
commit on your branch (**do not merge**), move the card to Ready to Ship, post a summary comment,
report in the terminal.

The commit message carries a `Spec:` line above the `Co-Authored-By:` line, pointing at the issue
and spec version the implementation follows:

```
feat: implement the xyz feature

Spec: <proj>#23 spec v3
Co-Authored-By: <model> <noreply@anthropic.com>
```
