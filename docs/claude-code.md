# todou × Claude Code

The `todou` CLI recognizes when it runs inside a Claude Code session and
does two things automatically — no flags, no configuration:

1. **Token selection.** If the server has a token stored under the
   `claude-code` profile, it is used instead of the default token:

   ```bash
   todou login https://todou.example --profile claude-code
   ```

   Claude Code sets `CLAUDECODE=1` in every shell it spawns, which is what
   triggers the auto-selection. Your own shell keeps using the default
   token. A profile named `harness` serves *every* harness, for a fleet
   that shares one machine account; `claude-code` wins wherever both
   exist. Precedence: `--profile` > `TODOU_TOKEN` > `TODOU_PROFILE` >
   `claude-code` > `harness` > default token (`--profile default` opts
   out). Neither auto rule applies outside a harness.

2. **Provenance metadata.** Every write (comments, issue events) carries
   an `X-Todou-Agent-Context` header recording
   `{ agent: "claude-code", session_id, model }`. The server stores it on
   the affected comments/events, the API returns it on timeline items, and
   the web timeline shows it as a small badge. Authorship is still the
   authenticated user — this is self-reported context for display and
   auditing, not authentication.

The command surface is also forgiving of gh-style habits: `issue show`
and `issue comment` work as aliases, and anywhere a `<number>` is
expected you can write `project/16`, `"#16"`, `T-16`, or paste the full
issue URL. Output is not left to guesswork either: `--json` spells every
issue number in the project's own reference format (see
[docs/external-trackers.md](external-trackers.md)).

## Where the metadata comes from

- `session_id` — `CLAUDE_CODE_SESSION_ID`, documented and set by Claude
  Code for Bash subprocesses.
- `model` — Claude Code exposes no environment variable for the live
  model, so the CLI reads the tail of the session transcript
  (`~/.claude/projects/*/<session-id>.jsonl`, an *unofficial* format) and
  falls back to a `CLAUDE_MODEL` variable if you export one. Detection
  failures just omit the field; they never break a command.

## Optional: a stable `CLAUDE_MODEL` via hooks

If you prefer not to rely on transcript parsing, Claude Code's SessionStart
hook receives the model and can export it through the official
`CLAUDE_ENV_FILE` mechanism:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '\"export CLAUDE_MODEL=\" + (.model // \"\")' >> \"$CLAUDE_ENV_FILE\""
          }
        ]
      }
    ]
  }
}
```

Caveats: the hook fires at session start only, so the value goes stale if
you switch models mid-session with `/model` (the transcript tail does not —
that is why the CLI prefers it), and the `model` field can be absent after
`/clear` or session restore.
