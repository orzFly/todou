# Driving agents through herdr

herdr owns the terminal: tabs, panes, and the agent processes inside them. This file holds the
command forms only. When to dispatch, whom to dispatch to, what goes in the brief and when to retire
are decisions, and they stay in `SKILL.md`. herdr's own complete reference is `herdr --skill`.

## Opening a task

One tab per task, and `--cwd` is always passed explicitly.

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <main repo> --label "<name>-<N>" --no-focus
herdr agent start <name>-<N> --kind claude --pane <pane_id> -- --worktree --model <model>
herdr agent prompt <name>-<N> "<task brief>" --wait --timeout 43200000   # run_in_background
```

`tab create` prints the `<pane_id>` that `agent start` needs, and `--no-focus` leaves your own tab in
front. Everything after `--` belongs to the agent being launched, not to herdr; for `--kind claude`
those flags are in `references/claude.md`. The prompt runs in the background, where the 12h
`--timeout 43200000` is a ceiling, not an expectation.

## Waiting on an agent

Run `herdr agent get <name>` and read the state before concluding anything from a `--wait` that
returned.

- `working` means a process is running, and a blocked wait is a running process too.
- A `--forever` wait prints a heartbeat to stderr, so a terminal with no heartbeat and no new output
  for hours is stuck whatever the state says.

`herdr agent wait <name>` blocks until that agent is idle and resolves exactly once. Prompting the
agent again does not revive it: attach a fresh wait each time, because the one that returned at a
review gate has expired. Which agents get a wait attached is decided in `SKILL.md`.

## Reading a screen

```bash
herdr agent read <name> --lines 30 | tail    # the tail, never a whole screen
herdr agent list                             # one snapshot of the whole fleet
```

## Answering a menu in the pane

`herdr agent send-keys <name> 2` followed by `herdr agent send-keys <name> enter` picks the second
item; `herdr agent send-keys <name> enter` on its own takes the default.

## Closing a task

```bash
herdr agent prompt <name> "/exit"   # no --wait
herdr tab list                      # confirm the label belongs to this task
herdr tab close <tab_id>
```

Close the tab only after the pane has returned to a shell. Verify the label with `tab list` before
every `tab close`: a mistyped id kills an unrelated agent. What `/exit` does to the agent's worktree
is in `references/claude.md`.
