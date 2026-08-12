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

Every exit wakes you (exit 0 = events, exit 3 = idle tick). **Handle the items, then immediately
restart with next_cursor.** Standard reactions:

| Event | Reaction |
|---|---|
| User opens / assigns a card | Dispatch a worker per the user's instruction (or queue it — see throttling) |
| User comments on a card | Owning worker still alive → relay to it; otherwise → file a follow-up card or handle it yourself |
| Card moves Shipped → Done | Verified: gracefully exit the agent (see below), delete the merged branch |
| Informational comment (reference links etc.) | No action — the comment itself is the record |

Cover any pre-sentinel gap proactively: craft a cursor by hand and call
`todou api GET '/projects/<proj>/activity?after=…'`, then check every user action was handled.

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
4. Wrap-up: commit (**do not merge**) → move to Ready to Ship → post a summary comment (screenshots/attachments) → report in the terminal.

Design-first cards (UI/approach decisions): state explicitly "post mockups/proposal to the issue first;
no implementation until the user decides; keep the card In Progress".

**Reuse rule**: reuse an agent only when the new task is *genuinely related* to its context (a follow-up
on the same card, the same subsystem); rename the agent and tab to match the new card. Otherwise start
fresh, or `/new` first. Unrelated old context is a liability, not an asset.

**Wait management**: a `--wait` timeout (herdr returns a timeout error) ≠ failure — run `herdr agent get`
first; if it is working, just re-attach with `herdr agent wait`. Never poke an agent that is working.

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
- Problems found in passing, or needs the user mentions aloud, become cards **immediately** (`#N` references auto-link) — never keep them in your head.
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
