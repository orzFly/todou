---
name: todou-plan
description: Turn an approved design into a reviewable implementation plan as a todou spec set — proposal/design/api/plan documents pushed to the issue, refined through the inline-annotation review loop until the user approves. Invoked by /todou-brainstorm after design approval, or directly for cards whose design is already settled.
---

# todou plan

Write the implementation plan for a card as a spec set on the issue, and revise it until the user
approves. Git never carries the documents; the tracker does. Read `/todou-cli` first; `<proj>` comes
from the host project's config.

## Steps

1. Move the card to In Progress, then run `todou agent can-i-follow` and do what it says, so
   comments arriving while you work reach you. Explore the code. Unresolved design details become
   native questions on the card (`comment add --questions` + `question wait`, see `/todou-cli`),
   never guesses.
2. Write the documents below in a scratch directory made with `mktemp -d`.
3. Self-check: remove placeholders, resolve contradictions, rewrite requirements that can be read two
   ways, confirm the scope fits.
4. Push with `todou spec push <n> <dir> -p <proj> --message "plan v1" --wait` and act on the outcome.
5. After `approved`, stop and report in the terminal.

## The documents

- `proposal.md`: the user's requirements that have no tracker trace, quoted verbatim without
  commentary. The issue body, comments and question answers are referenced, never copied. If a
  brainstorm preceded this, start from its `proposal.md`. Keep the file current: new information goes
  in, corrections replace the relevant sentences, and what a review annotation established is
  recorded as the requirement it now is, not as a note about the annotation.
- `design.md`: the architecture in brief. Name every third-party library you introduce and every
  well-known algorithm you implement by hand. Carry over a brainstorm's approved design.
- `api.md`, only when API design is involved: endpoints and schemas.
- `plan.md`: the executable plan the implementer follows. Concrete steps, file-level where it helps,
  with verification in each step.

A spec document states the design as it stands, not how it got there. No "v3 said X, v4 changed it
to Y" passages, no "the review asked for Z", and no list of corrections to another document: a
correction rewrites the sentence it corrects and folds its reason into the prose. Where a change came
from is already recorded — in the card's comments and in the spec's own version history.

## Review gate

`spec push … --wait` ends with one of these lines:

- `approved` → done.
- `changes requested` → `todou spec comments <n> --unresolved` lists each annotation with id, file,
  anchor and body. Apply them, update `proposal.md`, `todou spec resolve <n> <ids…>`, push again with
  `--if-version <v> --wait`.
- `feedback` → the user amended a requirement or asked a question in a plain comment. Update the
  documents, reply if a reply is owed, push if the documents changed, otherwise `todou spec wait <n>`.

A killed wait is re-entered with `todou spec wait <n> --since <cursor>`. The verdict is read from the
spec's state, never from the event stream, and never by polling `spec status`.

## After approval

Stop and report in the terminal. Implementation is dispatched separately, normally to a fresh agent
running `/todou-impl-plan`, unless your brief says to continue yourself. Everything the implementer
needs is already on the tracker.
