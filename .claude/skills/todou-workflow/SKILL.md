---
name: todou-workflow
description: How work moves through a todou tracker — the status flow and who moves what, taking and filing issues, comment discipline, asking the user, and the spec gate shared by brainstorm, plan and implementation. Read with /todou-cli before working an issue.
---

# todou workflow

- Everything goes through the tracker: questions, reports, deliverables, reviews.
- The hand-off between agents travels through the issue and its spec, never through agent memory.
- Commands: `/todou-cli`. This skill is what every role does with them.

## Status flow

- Backlog → Todo → Next → In Progress → Ready to Ship → Shipped → Done; Invalid closes a card without doing it.
- A blocker stops blocking at the project's Blocks clear at status — Shipped by default.
- Worker: Ready to Ship + summary comment. Orchestrator: Shipped. Only the user: Done.

## Taking an issue

- `issue edit <n> --status "In Progress" --add-assignee @me` — one write; then watch it, always
  (`/todou-cli`, "Waiting").
- An assignee means held, never by whom (one machine account), and it is not a lock.
- Development complete: commit on your own branch without merging, move the issue to Ready to Ship,
  post a summary comment, report in the terminal.

## Phases

- A design-heavy issue goes `/todou-brainstorm` → `/todou-plan` → `/todou-impl-plan`; one whose design
  is settled starts at `/todou-plan`.
- A planning agent's issue keeps its assignee through the hand-off to the implementation agent.

## Filing an issue

- Create the issue first; investigate on it afterwards.
- Body: the user's words verbatim (no blockquote) plus what they handed over, ending `— <who>, in the terminal, <date>`.
- Self-found: the observation and the command that measured it; unmeasured parts named.
- Your reading (cause, fix, related issues) is a comment right after.
- Title names the symptom, never an inferred cause.
- One unit of work per issue; report which issue got which part.
- A need outside the issue you hold: file it at once rather than widening yours.

## Comments

- Conclusion first. No preamble, recap or closer.
- One point per comment; bold the claim; steps the reader must take are numbered.
- Don't restate what the reader can already see.
- Failure: cause, then fix; if still open, the one thing that unblocks it.
- Demo pages and mockups are attached to the issue, not left on local disk.

## Asking the user

- On the issue (`/todou-cli`, "Asking the user questions"), never AskUserQuestion.
- Open design details become questions, never guesses.
- Each question carries your recommendation and why.

## Specs

- Draft in a scratch dir (`mktemp -d`); git never carries a spec.
- Self-review before each push: no placeholders, no contradictions, nothing readable two ways, one
  plan's worth of scope.
- Push with `--wait` and revise until the latest version is approved (`/todou-cli`, "Spec documents").
- **No code until the latest version is `approved`.** An older approval, a comment review, a
  withdrawal or a wait's exit 0 is not approval.
- Documents state the design as it stands: no history, no review notes, no copied issue text.
- `proposal.md`: the user's requirements that have no tracker trace, verbatim, split as "Filing an
  issue" splits a report.
- What an answer or annotation established goes in as the requirement it now is.
