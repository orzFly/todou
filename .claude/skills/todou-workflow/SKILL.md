---
name: todou-workflow
description: How agents move work through a todou tracker — the status flow and who moves what, taking an issue and finishing it, the brainstorm → plan → implement phases, and the spec gate between them. Read with /todou-cli before working an issue.
---

# todou workflow

- The hand-off between agents travels through the issue and its spec, never through agent memory.
- Commands, filing, comments, questions and what a spec holds: `/todou-cli`.

## Status flow

- Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done; Invalid closes a card without doing it.
- A blocker stops blocking at the project's Blocks clear at status — Shipped by default.
- Worker: Ready to Ship + summary comment. Orchestrator: Shipped. Only the user: Done.

## Taking an issue

- `issue edit <n> --status "In Progress" --add-assignee @me` — one write; then watch it, always
  (`/todou-cli`, "Waiting").
- An assignee means held, never by whom (one machine account), and it is not a lock.
- Open design details become questions on the issue, never guesses.
- A need outside the issue you hold: file it at once rather than widening yours.
- Development complete: commit on your own branch without merging, move the issue to Ready to Ship,
  post a summary comment, report in the terminal.

## Phases

- A design-heavy issue goes `/todou-brainstorm` → `/todou-plan` → `/todou-impl-plan`; one whose design
  is settled starts at `/todou-plan`.
- A planning agent's issue keeps its assignee through the hand-off to the implementation agent.

## The spec gate

- Self-review before each push: no placeholders, no contradictions, nothing readable two ways, one
  plan's worth of scope.
- Push with `--wait` and revise until the latest version is approved (`/todou-cli`, "Spec documents").
- **No code until the latest version is `approved`.** An older approval, a comment review, a
  withdrawal or a wait's exit 0 is not approval.
- What an answer or annotation established goes into the spec as the requirement it now is.
