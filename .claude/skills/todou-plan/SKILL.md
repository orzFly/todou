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

1. Move the card to In Progress, then run `todou agent can-i-follow` and do what it says. Explore the
   code. Unresolved design details become native questions on the card (`comment add --questions` +
   `question wait`, see `/todou-cli`), never guesses.
2. Write the documents below in a scratch directory made with `mktemp -d`.
3. Self-check: remove placeholders, resolve contradictions, rewrite requirements that can be read two
   ways, confirm the scope fits.
4. Push with `todou spec push <n> <dir> -p <proj> --message "plan v1" --wait` and act on the outcome.
5. After `approved`, stop and report in the terminal.

## The documents

- `proposal.md`: the user's requirements that have no tracker trace, kept current as `/todou-cli`
  describes. If a brainstorm preceded this, start from its `proposal.md`.
- `design.md`: the architecture in brief. Name every third-party library you introduce and every
  well-known algorithm you implement by hand. Carry over a brainstorm's approved design.
- `api.md`, only when API design is involved: endpoints and schemas.
- `plan.md`: the executable plan the implementer follows. Concrete steps, file-level where it helps,
  with verification in each step.

## After approval

Stop and report in the terminal. Implementation is dispatched separately, normally to a fresh agent
running `/todou-impl-plan`, unless your brief says to continue yourself. Everything the implementer
needs is already on the tracker.
