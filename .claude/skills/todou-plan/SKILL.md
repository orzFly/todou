---
name: todou-plan
description: Turn an approved design into a reviewable implementation plan as a todou spec set — proposal/design/api/plan documents pushed to the issue, refined through the inline-annotation review loop until the user approves. Invoked by /todou-brainstorm after design approval, or directly for issues whose design is already settled.
---

# todou plan

- The plan is a spec set on the issue; git never carries it.
- The review loop and what a spec may hold: `/todou-cli`, "Spec documents".

## Steps

1. Take the issue and watch it now (`/todou-cli`). Read the code. Open design details become questions
   on the issue, never guesses.
2. Write the documents below into a scratch dir (`mktemp -d`).
3. Self-check: no placeholders, no contradictions, nothing readable two ways, scope fits.
4. `spec push <n> <dir> --message "plan v1" --wait`; revise until the latest version is approved.
5. Report in the terminal. Implementation is `/todou-impl-plan`.

## The documents

- `proposal.md`: as `/todou-cli` describes; start from the brainstorm's if there was one.
- `design.md`: the architecture in brief. Name every third-party library you add and every well-known
  algorithm you hand-roll. Carry over an approved brainstorm design.
- `api.md`, only when API design is involved: endpoints and schemas.
- `plan.md`: concrete steps, file-level where it helps, each with its verification.
