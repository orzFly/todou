# Launching a claude agent under herdr

`herdr agent start … --kind claude -- <flags>` hands everything after `--` to claude itself. This
file covers those flags and the behaviour they buy. Which model, which card and which brief go to an
agent are dispatch decisions, and they stay in `SKILL.md`.

## Launch flags

```bash
herdr agent start <name>-<N> --kind claude --pane <pane_id> -- --worktree --model <model>
```

- `--worktree` gives the agent its own git worktree, created and cleaned up by its own session.
- `--model` always ends in the context-window suffix `[1m]`. Which model serves which phase is
  settled at dispatch and is never written down here.

## Running a brief through a skill

An agent cannot invoke a `disable-model-invocation` skill on its own. Put `/skill-name` on the first
line of the prompt and the skill loads; the rest of the brief follows underneath.

## `/exit` and worktree cleanup

`/exit` is prompted without `--wait`, because claude exits on it and no lifecycle is left to await.
On a `--worktree` launch the exit also decides the worktree's fate:

- A clean or committed worktree is removed silently, branch included. Commits already merged into
  master survive; unmerged commits are destroyed.
- A dirty worktree stops on an interactive keep/remove menu, default Keep. Answer it with `send-keys`
  (see `references/herdr.md`): the second item removes and discards, a plain `enter` keeps.
- The cleanup follows the session's own record of what it changed, not git state, so commits injected
  into the worktree from outside that session are destroyed silently however clean git looks.

## The `Interrupted` marker

An idle agent whose output ends in `Interrupted` was cut off by a network failure, not by a human
abort.
