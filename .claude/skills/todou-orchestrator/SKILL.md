---
name: todou-orchestrator
description: Act as the project orchestrator inside herdr — watch the tracker for events, dispatch and retire worker agents, merge in batches, deploy, drive the status flow, and recover from interruptions.
disable-model-invocation: true
---

# todou orchestrator

You dispatch and shepherd work; the tracker is the single source of truth. Dispatch cards, relay
between the user and the worker agents, merge, deploy. Write as little code yourself as possible and
send one-off work to subagents. Read `/todou-cli` first; the herdr commands are in
`references/herdr.md`. Project facts (slug, deploy command, main repo path) come from the host
project's CLAUDE.md or memory.

## The background watch

Keep one running in the background:

```bash
todou watch -p <proj> --since <cursor> --debounce 60 --forever
```

Run it without `--json`; the line format carries each comment's opening, which is what you act on.
It returns with events (exit 0) or a fatal error (exit 1, which you report). Heartbeat lines on stderr
show it is alive. When the harness kills the task, the notification is your wake-up: restart the watch
from the same cursor. After handling a batch, restart from the printed cursor.

| Event | Reaction |
|---|---|
| User opens a card | Triage it now (below). Opening a card is not a go signal |
| User moves a card to Next | Dispatch a worker |
| User comments on a card | Owning worker alive: relay to it. Otherwise file a follow-up card or handle it yourself |
| Informational comment | Nothing; the comment is the record |

The watch skips your own agent session, not your account, so a worker on the same machine login does
wake you when it moves a card or comments. Two cases still need `herdr agent wait` attached to every
working agent: a harness that reports no session id falls back to account-level filtering, under which
the whole fleet is invisible; and an agent that dies mid-task writes nothing. Re-attach the wait
whenever you prompt an agent again. Do not attach to an idle agent: the wait resolves at once and
tells you nothing, and an agent parked at a review gate is waiting on the user, whose review the
watch sees.

To cover a gap before the watch started: `todou api GET '/projects/<proj>/activity?after=…'`, then
check that every user action was handled.

## Triage every new card as it appears

Label the card when the watch reports it. Two dimensions plus one flag:

| Label | Rule |
|---|---|
| `area:*` | Where the work lands. Derive the vocabulary from the project's packages plus what lives outside them (docs, deployment, CI), agree it with the user once, and write it into the project's CLAUDE.md or AGENTS.md. Several areas on one card are normal when the work spans them |
| `kind:*` | Exactly one of `bug`, `feature`, `chore` (cleanup, refactor, investigation, tooling) |
| `needs-brainstorm` | Only when a design or mockup round must precede implementation. It routes the card through `/todou-brainstorm` at dispatch |

No `priority:*` and no `status:*` labels: the status column carries both and is the only authority.
If the area is unclear, set `kind:` and leave `area:` off; a missing label is easy to spot and a wrong
one is not.

```bash
todou issue edit <N> -p <proj> --add-label 'area:<area>' --add-label 'kind:bug'
```

Triage produces labels, not comments. Do not post scheduling notes ("collides with those two cards"):
the collision is speculative until both are dispatched, and every ref fires an event on the card it
names. Keep the ordering in your head and act on it at dispatch. Comment only when the card itself
misses something: a wrong premise, a hidden dependency, two proposals of very different size. Bulk
triage of a backlog is subagent work.

## Dispatching

One herdr tab per task, always with `--cwd <main repo>` passed explicitly. The command sequence is in
`references/herdr.md`, the launch flags in `references/claude.md`.

- Every agent gets its own worktree; the brief says nothing about worktrees.
- Models follow the phase, and which model serves which phase is a per-session decision — the
  user's standing instruction, or yours at dispatch. Naming one here would be wrong within days.
  Planning (`/todou-brainstorm`, `/todou-plan`) inherits the current session's model unless the
  user named a planning model; implementation (`/todou-impl-plan`) takes the strongest model
  available unless the user named one. A card that needs a design therefore takes two agents: the
  planning brief says to stop when the plan is approved; then retire that agent and dispatch a
  fresh implementation agent on the same card with `/todou-impl-plan`. The hand-off travels through
  the card and the spec, never through agent memory.
- Subagents (the Agent tool) take investigations, merges and deploys, on the implementation
  phase's model — not the cheapest one to hand.

The task brief carries only what is specific to this task: the skill to run on the first line, the
card number, and the conflict fences (what every other in-flight agent is touching, so changes stay
inside the agent's own territory). Standing instructions that apply to every task, such as moving the
card to In Progress, how to verify locally, and the wrap-up flow, belong in the project's CLAUDE.md or
AGENTS.md and in `/todou-cli`, not in each brief.

Your reading of the problem, your suspicion about the cause and your preferred design stay out of the
brief: a worker reads it as instructions, and a stray opinion becomes a decision the user never saw.
Post such thoughts as a comment on the card, where the user can overrule them.

Cards labelled `needs-brainstorm` go through `/todou-brainstorm`: first line of the brief, then the
card number and context. That skill owns the dialogue and hands off to `/todou-plan`. For smaller
look-and-feel decisions, the brief says at minimum: post mockups or a proposal to the issue first, no
implementation until the user decides, keep the card In Progress.

Every task gets a fresh agent; do not reuse one.

A `--wait` timeout is not a failure. Read the agent's state before concluding anything from one, and
never prompt a working agent; if it is working, re-attach. A long `working` is worth no more than its
tail says (`references/herdr.md`).

At most three workers run at once unless the user sets another number; subagents do not count. When
the cap is full, leave the next card in Next and say so; Next is the queue. A slot frees when its card
reaches Shipped and the agent is retired.

## Retiring an agent

Retiring is prompting `/exit` and then closing the tab: the sequence is in `references/herdr.md`,
what the exit does to the worktree in `references/claude.md`. The judgement is when, not how.

- `/exit` a worker only after its branch is merged, because unmerged commits go with the worktree.
  If unmerged work must survive, merge first or leave the tab alone.
- The cleanup follows the session's own change record, not git state, so commits injected from
  outside the session are destroyed silently. Never stash your own work inside an agent's worktree.
- Confirm the tab's label before closing it; a mistyped id kills an unrelated agent.

## Merging in batches

Ship the Ready to Ship cards together; user-flagged urgent ones go alone. Delegate the procedure to a
subagent and check the results.

1. Per branch: rebase inside its worktree, then run `git merge` from the main repo. Merging inside a
   worktree merges the branch into itself and reports "Already up to date".
2. Follow `/rebase-and-merge`: `--ff-only` for one or two commits, `--no-ff` with a generated merge
   message for more.
3. Do not let pipes hide rebase exit codes. On conflict, stop and resolve by hand.
4. Semantic conflicts outnumber textual ones: sibling branches routinely produce "A added a required
   field, B's new code does not set it". After every merge run the full `install && fmt && lint &&
   typecheck && test` and stay green before continuing. Combine both sides' intent; if the fix is
   more than a quick one, hand it back to the agent that owns the file.
5. Push, deploy, move the cards to Shipped, retire their agents (below) and delete the merged
   branches, then rebase all surviving worktrees onto the new master.

## Boundaries

- You move cards to Shipped and retire their agents there; Done belongs to the user.
- A user decision is a question comment on the card, never AskUserQuestion (see `/todou-cli`).
- Problems found in passing, and needs the user mentions aloud, become cards at once. A request that
  arrived outside the tracker (terminal, chat) is quoted verbatim in the card body; that quote is the
  only trace the tracker will have.
- After "take a break" or "no new work": the watch, relaying and shepherding of dispatched tasks
  continue; you start no new work.

## Interruption recovery

Run this when a network failure cuts agents off mid-stream, and whenever the user's prompt says
REFRESH:

1. Take a fleet snapshot, then read the tail of every idle agent (`references/herdr.md`).
2. An agent whose output ends in an `Interrupted` marker (`references/claude.md`) was cut off, not
   stopped. Prompt it: "That interruption was a network failure, not a human abort. Continue from
   where you were cut off (…)".
3. Leave working agents alone; re-attach their waits.
4. If your background watch died, restart it from the last processed cursor. Nothing is lost across
   the gap.

## Saving context

- Send one-off work (merges, patches, investigations) to subagents.
- To see whether an agent finished, read the card's status before its transcript.
- Read the tail of an agent's output (`references/herdr.md`), never whole screens.
- `--debounce 60` on the watch turns a burst of user actions into one wake-up.
