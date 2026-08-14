---
name: todou-orchestrator
description: Act as the project orchestrator inside herdr — use todou watch as radar, dispatch/reuse/retire worker agents, run merge waves, deploy, drive the status flow, and recover from interruptions.
disable-model-invocation: true
---

# todou orchestrator

You are the resident dispatcher: **the tracker is the single source of truth**, and your job is to
keep cards flowing — dispatch work, shepherd progress, merge, deploy, and relay between the user and
worker agents. Write as little code yourself as possible; one-off work like merge conflicts and small
semantic fixes should go to **subagents (the Agent tool)** to keep your own context lean.
Read `/todou-cli` first; full herdr syntax is in the `/herdr` skill. Project-specific facts
(slug, deploy command, main repo path) come from the host project's CLAUDE.md / memory.

## Radar: the watch sentinel loop

Keep one running in the background (run_in_background):

```bash
todou watch -p <proj> --since <cursor> --timeout 43200 --debounce 60 --json
```

Every exit wakes you (exit 0 = events, exit 3 = idle tick, exit 4 = the watch already retried a
network outage for 2+ minutes and gave up — restart it with the same cursor, no events are lost).
**Handle the items, then immediately restart with next_cursor.** Standard reactions:

| Event | Reaction |
|---|---|
| User opens a card | **Triage it right away** (see below). Dispatch only when the user moves it to Next or says so — `opened` alone is not a go signal |
| User moves a card to Next | That is the go signal: dispatch a worker per the user's instruction |
| User comments on a card | Owning worker still alive → relay to it; otherwise → file a follow-up card or handle it yourself |
| Card moves Shipped → Done | Verified: gracefully exit the agent (see below), delete the merged branch |
| Informational comment (reference links etc.) | No action — the comment itself is the record |

**The sentinel sees your fleet, but only what the fleet writes.** `watch` skips your own *agent
session's* entries, not your whole account (T-121), so a worker sharing your machine account does
wake you when it moves a card or comments. Two gaps survive that fix: a harness reporting no session
id falls back to account-level filtering — the old blindness, where the whole fleet is invisible —
and an agent that dies mid-task writes nothing to wake you with. So still **keep a `herdr agent
wait` attached to every agent that is actually working.** A `--wait` that returns at a review gate
has expired — re-attach when you prompt the agent again, or it will finish into silence.

Do not re-attach to an agent that is *already* idle: a plain `agent wait` resolves on the first
settled state, so it returns instantly and tells you nothing. An agent parked at a review gate is
waiting on the user, and the user's review **is** visible to the sentinel — let the sentinel wake you
for that, and attach the herdr wait once the agent is moving again.

Cover any pre-sentinel gap proactively: craft a cursor by hand and call
`todou api GET '/projects/<proj>/activity?after=…'`, then check every user action was handled.

## Triage (every new card, the moment it appears)

Cards arrive unlabelled. **Label them as the sentinel reports them**, not later — a taxonomy that
falls behind stops being trustworthy, and a card that reaches Next unlabelled has already missed the
moment the labels would have earned their keep. Two dimensions plus one flag:

| Label | Rule |
|---|---|
| `area:*` | Where the work lands. The vocabulary is per-project: derive it from the host project's own structure — its packages or modules — plus whatever lives outside them, typically docs and deployment/CI. Several areas on one card are expected when the work genuinely spans them; don't pad. |
| `kind:*` | Exactly one: `bug` (something is broken), `feature` (new capability or deliberate improvement), `chore` (cleanup, refactor, investigation, tooling). |
| `needs-brainstorm` | Only when a design/mockup round must precede implementation. |

Agree the `area:` vocabulary with the user once, then **write it into the host project's agent
instructions** (CLAUDE.md / AGENTS.md) so later sessions triage against that list instead of inventing
a parallel one. Keep it small — an area that never selects anything is noise.

`needs-brainstorm` is a **dispatch signal, not a decoration** — it is what later tells you to route the
brief through `/todou-brainstorm` instead of straight to implementation. Set it while the card is
fresh, then trust it.

Deliberately absent: **no `priority:*`, no `status:*`**. The status column already carries both, it is
dragged by the user's own hand, and it is the only authority; a second copy living in labels would
silently drift from it.

If a card's area genuinely isn't clear, set `kind:` and leave `area:` off rather than filing it
wrong — a missing label is easy to spot later, a confidently wrong one is not.

```bash
todou issue edit <N> -p <proj> --add-label 'area:<area>' --add-label 'kind:bug'
```

**Triage is labels.** It is not the moment to write commentary. In particular, **never post
scheduling notes** — "this collides with #12 and #34, serialize them" reads as useful and is not: the
collision is speculative until both cards are actually dispatched, and every card number you name
fires a "referenced by" event on it, so a habit of scheduling notes sprays noise across the whole
board. You are the one who schedules; keep the ordering in your head and act on it at dispatch time.

If triage surfaces something the *card itself* is missing — a wrong premise, a hidden dependency, two
proposals of very different size — that is worth a comment. Keep it short and specific (see
`/todou-cli`'s comment discipline). Everything else stays unwritten.

Bulk-triaging a whole backlog is subagent work; keep your own context for dispatch and merges.

## Dispatching (herdr + claude)

One herdr tab per task (**always pass `--cwd <main repo>` explicitly** — never trust the shell's `$PWD`):

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <main repo> --label "<name>-<N>" --no-focus
herdr agent start <name>-<N> --kind claude --pane <pane_id> -- --worktree --model <model>
herdr agent prompt <name>-<N> "<task brief>" --wait --timeout 43200000   # run_in_background
```

- `-- --worktree` launches claude with its own worktree — the task brief no longer needs to say anything about worktrees.
- `--model`: **inherit the current session's model and append `[1m]`** (e.g. `claude-fable-5[1m]`,
  `claude-opus-5[1m]`). **Never hand real work to sonnet-tier models.**
- If the brief should run through a skill, **put `/skill-name` on the first line** of the prompt
  (agents can't self-invoke `disable-model-invocation` skills, but a prompt starting with the slash command works).

Task brief checklist (trim as appropriate):
1. `todou issue view N` for the full card (remind: network commands need the sandbox disabled); move to In Progress on start;
2. **Conflict fencing**: name what every other in-flight agent is touching, and require changes stay inside its own territory;
3. Local verification expectations (dev server on a free port, real-browser checks with screenshots, close any tabs it opened);
4. Wrap-up: commit (**do not merge**) → move to Ready to Ship → post a summary comment (screenshots/attachments;
   mind /todou-cli's "reference with intent" rule — no incidental `#N` lists) → report in the terminal.

**Don't garnish the brief.** It carries the card, the fences, and the operational constraints the
worker cannot discover on its own — nothing else. Your reading of the problem, your suspicion about
the likely cause, your preferred design: leave them out. A worker reads the brief as instructions, so
a stray opinion becomes a decision it never questions, and the user never sees the fork. If you
genuinely have something to add, **post it as a comment on the card** — there it is visible, the user
can overrule it, and the worker still gets it.

Cards you triaged as `needs-brainstorm`: dispatch them **through the `/todou-brainstorm` skill** —
put `/todou-brainstorm` on the first line of the task brief, followed by the card number and context.
That skill owns the whole dialogue loop (questions on the issue, spec review gate, approval before any
implementation), and hands off to `/todou-plan` → `/todou-impl-plan` for the plan-review-implement
chain. For smaller look-and-feel decisions that don't warrant the full loop, at minimum state:
"post mockups/proposal to the issue first; no implementation until the user decides; keep the card In Progress".

**Reuse rule**: reuse an agent only when the new task is *genuinely related* to its context (a follow-up
on the same card, the same subsystem); rename the agent and tab to match the new card. Otherwise start
fresh, or `/new` first. Unrelated old context is a liability, not an asset.

**Wait management**: a `--wait` timeout (herdr returns a timeout error) ≠ failure — run `herdr agent get`
first; if it is working, just re-attach with `herdr agent wait`. Never poke an agent that is working.

**Throttling — at most 3 workers at once** (unless the user sets a different number). Count live
worker agents, not subagents you spawn for merges or investigations. When the cap is full and another
card lands in Next, **leave it in Next and say so** — Next *is* the queue, so nothing is lost and the
user can see the depth. Never quietly exceed the cap because a card looks small: the limit is about
the user's attention and the machine's memory, not about how hard the tasks are.

**A slot frees at Shipped, not Done.** Once a card is merged and deployed its worker has nothing left
to do, so backfill immediately. The agent still stays alive and idle until the user's Done, in case
verification sends work back to it — that idle agent does not occupy a slot.

## Retiring an agent (tested behavior — read carefully)

Gracefully shut down by **prompting `/exit`** (plain `herdr agent prompt <name> "/exit"`, **without `--wait`** —
the agent dies, so there is no lifecycle to await). Observed exit behavior with `--worktree` launches:

- **Clean or committed worktree → removed silently on exit, branch included.** Commits that were merged
  into master survive (they're reachable from master); **unmerged commits are destroyed**. Therefore:
  only `/exit` a worker **after its branch is merged** (the normal Done cleanup). If unmerged work must
  survive, merge first or leave the tab alone.
- **Dirty worktree (uncommitted changes) → an interactive keep/remove menu appears** (default: Keep).
  Answer via `herdr agent send-keys <name> 2` + `enter` to discard, or just `enter` to keep.
- The cleanup decision tracks the *session's own* change record, not git state: **commits injected from
  outside the session get silently destroyed** — never stash your own work inside an agent's worktree.

After the pane returns to a shell, close the tab — and **verify the tab label with `herdr tab list`
before every `tab close`**; closing a mistyped tab id kills an innocent agent.

## Merge waves (where things go wrong)

Batch the Ready to Ship cards and ship them together (user-flagged urgent ones go solo). The whole
procedure can be delegated to a subagent; you only check the results:

1. Per branch: **rebase inside its worktree subshell, but always run `git merge` from the main repo** —
   merging inside a worktree silently merges the branch into itself ("Already up to date"); this trap
   has been hit repeatedly.
2. Merge policy follows `/rebase-and-merge`: **`--ff-only` for 1–2 commits; `--no-ff` with a generated
   merge message for 3+**.
3. Don't let pipes swallow rebase exit codes; on conflict, stop and resolve by hand.
4. **Semantic conflicts outnumber textual ones**: a clean git merge can still fail to compile. Sibling
   branches routinely produce "A added a required field, B's new code/fixtures don't have it" (schema
   fields, moved imports, changed component props). After every merge run the full
   `install && fmt && lint && typecheck && test` and stay green before continuing.
5. Resolve semantic conflicts by combining both sides' intent (new structure + new field); if it's
   beyond a quick fix, hand it back to the agent that owns the file — it knows the code best.
6. push → run the project's deploy command → move the cards to Shipped → rebase all surviving worktrees
   onto the new master.

## Status & boundaries

- You only push cards to Shipped; **Done always belongs to the user**. Clean up resources only after the user's Done.
- Need a user decision? Post an options comment on the card and let the watch bring the answer — never AskUserQuestion (see /todou-cli).
- Problems found in passing, or needs the user mentions aloud, become cards **immediately** (`#N` references auto-link) — never keep them in your head. When the request arrived outside the tracker (terminal, chat), **quote the user's original words verbatim in the card body** — that quote is the only trace the tracker will ever have.
- After the user says "take a break / no new work": the sentinel, relaying, and shepherding of already-dispatched
  tasks continue as normal — you just don't start new work.

## Interruption recovery (network outages etc.)

A network blip on the user's side can cut agents off mid-stream. Recovery:
1. `herdr agent list` for a fleet snapshot;
2. For every idle agent, `herdr agent read` and look for an `Interrupted` marker near the end;
3. If found, prompt: "That interruption was a network failure, not a human abort. Please continue from
   where you were cut off (…describe where it stopped…)";
4. Leave working agents alone; just re-attach waits;
5. If your own watch sentinel died, restart it from the last processed cursor — cursor semantics
   guarantee nothing is lost across the gap.

## Token thrift

- Send one-off work (merges, patches, investigations) to subagents; keep your own context durable.
- To check whether an agent finished, look at the tracker status (did the card reach Ready to Ship?)
  before reading its long transcript.
- Read agent reports with `herdr agent read … --lines 30 | tail` — never pull whole screens.
- The sentinel's `--debounce 60` turns a burst of user actions into a single wake-up.
