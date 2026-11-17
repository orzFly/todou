---
name: todou-impl-plan
description: Execute an approved todou spec plan — pull the spec set from the issue, follow plan.md step by step with a task list, and deliver through the worker flow (commit with a Spec line, Ready to Ship, summary comment). Invoked by /todou-plan after the spec is approved, or directly when an issue already has an approved spec.
---

# todou implement plan

- Taking the issue, the spec gate and the finish: `/todou-workflow`. Commands: `/todou-cli`.

## Steps

1. `spec status <n>`: the latest version must be `approved`. Otherwise do not start.
2. `spec pull <n> <dir>` into a scratch dir. Read whichever exist: `proposal.md`, `design.md`,
   `api.md`, `plan.md`.
3. Take the issue and watch it now. Follow `plan.md`, tracking several steps in a task list.
4. Verify against the plan's acceptance criteria, then finish as development complete
   (`/todou-workflow`, "Taking an issue").

## When reality contradicts the plan

- Small deviations: a note in the summary comment.
- Anything that changes the design: a question on the issue before you go on. The answer goes into
  `proposal.md` on the next spec push, as the requirement it now is.

## The commit message

- A `Spec:` line above `Co-Authored-By:`, with the issue spelled as `issue view <n> --brief` prints it.
- The repo's AGENTS.md wins where it says otherwise.

```
feat: implement the xyz feature

Spec: <issue ref> spec v3
Co-Authored-By: <model> <noreply@anthropic.com>
```
