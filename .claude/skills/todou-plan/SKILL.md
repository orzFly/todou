---
name: todou-plan
description: Turn an approved design into a reviewable implementation plan as a todou spec set — proposal/design/api/plan documents pushed to the issue, refined through the inline-annotation review loop until the user approves. Invoked by /todou-brainstorm after design approval, or directly for cards whose design is already settled.
---

# todou plan

Write the implementation plan for a card as a spec set on the issue, and revise it until the user
approves. Git never carries the documents; the tracker does. Read `/todou-cli` first — the review
gate, and what a spec document may and may not contain, are in its "Spec documents" section.
`<proj>` comes from the host project's config.

## Steps

1. Take the card (`/todou-cli`, "Taking a card"), then run `todou agent can-i-follow` and do what it
   says. Explore the code. Unresolved design details become native questions on the card
   (`comment add --questions` + `question wait`, see `/todou-cli`), never guesses.
2. Write the documents below into a scratch directory (`mktemp -d`).
3. Self-check: remove placeholders, resolve contradictions, rewrite requirements that can be read two
   ways, confirm the scope fits.
4. Push with `todou spec push <n> <dir> -p <proj> --message "plan v1" --wait` and act on the outcome.
5. Follow the review loop below. Stop and report in the terminal only after `spec status` confirms
   that the latest version is `approved`.

## Review loop

Read the outcome of `spec push --wait` or `spec wait`, then the discussion, unresolved annotations
and current spec status. Exit 0 means the wait returned a result; it does not mean approval.

- When deciding a pending (`unreviewed`) version needs investigation or rework, first run
  `todou spec withdraw <n> -p <proj> --if-version <v> [--reason "..."]` against the version you
  inspected. Then investigate and revise the plan and any affected design or requirements.
  If withdrawal conflicts, read the latest state and reassess; do not blindly target the new version.
- A `withdrawn` outcome sends you back to investigation/rework, with the existing spec and discussion
  still available. If the current status is `changes_requested`, revise directly; that verdict
  cannot be withdrawn.
- Resolve annotations you addressed, then push with
  `todou spec push <n> <dir> -p <proj> --if-version <v> --message "plan revision" --wait`.
  Resubmitting from withdrawn creates a new version even with identical content and requires fresh
  approval. Repeat the loop until the latest version is `approved`.
- If feedback requires no rework and the current version remains ready for review, resume
  `todou spec wait <n> -p <proj> --since <cursor>` from the returned cursor.

Only the latest version's approval passes the gate. Earlier approval, a comment review or withdrawal
does not authorize implementation.

## The documents

- `proposal.md`: the user's requirements that have no tracker trace, kept current as `/todou-cli`
  describes. If a brainstorm preceded this, start from its `proposal.md`.
- `design.md`: the architecture in brief. Name every third-party library you introduce and every
  well-known algorithm you implement by hand. Carry over a brainstorm's approved design.
- `api.md`, only when API design is involved: endpoints and schemas.
- `plan.md`: the executable plan the implementer follows. Concrete steps, file-level where it helps,
  with verification in each step.

## After approval

Implementation is dispatched separately, normally to a fresh agent running `/todou-impl-plan`, unless
your brief says to continue yourself. Everything the implementer needs is already on the tracker.
