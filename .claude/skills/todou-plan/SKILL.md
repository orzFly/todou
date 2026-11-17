---
name: todou-plan
description: Turn an approved design into a reviewable implementation plan as a todou spec set — proposal/design/api/plan documents pushed to the issue, refined through the inline-annotation review loop until the user approves. Invoked by /todou-brainstorm after design approval, or directly for issues whose design is already settled.
---

# todou plan

- The plan is a spec set on the issue. Taking the issue, questions and the spec gate:
  `/todou-workflow`. Commands: `/todou-cli`.

## Steps

1. Take the issue and watch it now. Read the code.
2. Write the documents below into a scratch dir.
3. Self-review, then `spec push <n> <dir> --message "plan v1" --wait`; revise until the latest version
   is approved.
4. Report in the terminal. Implementation is `/todou-impl-plan`.

## The documents

- `proposal.md`: as `/todou-workflow` describes; start from the brainstorm's if there was one.
- `design.md`: the architecture in brief. Name every third-party library you add and every well-known
  algorithm you hand-roll. Carry over an approved brainstorm design.
- `api.md`, only when API design is involved: endpoints and schemas.
- `plan.md`: concrete steps, file-level where it helps, each with its verification.
