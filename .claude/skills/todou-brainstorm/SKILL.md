---
name: todou-brainstorm
description: Interactively brainstorm a design with the user on a todou issue — turn ideas into fully formed designs through collaborative dialogue, with the whole exchange recorded on the tracker and the user answering from the web UI. Use before starting any design-heavy issue.
disable-model-invocation: true
---

# Brainstorming on a todou issue

- The whole exchange stays on the issue, so whoever implements it can replay every decision.
- Taking the issue, questions and the spec gate: `/todou-workflow`. Commands: `/todou-cli`.

<HARD-GATE>
No code, no scaffolding, no implementation skill until the latest spec version is `approved`. This
holds for issues that look too simple to need a design: the design may be a few sentences, and it is
still pushed and approved.
</HARD-GATE>

## Steps

1. Take the issue and watch it now. Read the code, docs, recent commits and the issue.
2. Ask clarifying questions on the issue: purpose, constraints, success criteria.
3. Write the design into a scratch dir.
4. Self-review, then `spec push <n> <dir> --message "brainstorm v1" --wait`; revise until the latest
   version is approved.
5. Invoke `/todou-plan`.

## Working through the idea

- Several independent subsystems: an issue each, then brainstorm the first.
- Prefer multiple-choice questions with options you already researched; the homework is yours.
- Weigh two or three approaches. The comparison, rejected options and reasons go in the spec; ask on
  the issue only when the choice is the user's to make.
- Follow existing patterns. Fixes the work needs go in the design; an optional refactor is a question.
- Write the spec as soon as you know what you are building — not a comment summary asking whether to.
- Answers may overturn your premises; update the design.

## The documents

- `proposal.md`: as `/todou-workflow` describes.
- `brainstorm.md`: approaches weighed, chosen, rejected and why; architecture, components, data flow,
  error handling, testing — each scaled to its complexity.

## Visual material

- When a picture answers faster (mockups, layout comparisons, diagrams), attach a self-contained HTML
  page and explain it in a comment.
- Screenshots only where a browser is known to work. Looks → images; requirements, trade-offs and
  scope → text.
