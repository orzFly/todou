# todou × Hermes Agent

The `todou` CLI recognizes when it runs inside a
[Hermes Agent](https://github.com/nousresearch/hermes-agent) gateway turn
and does two things automatically — no flags, no configuration:

1. **Token selection.** If the server has a token stored under the
   `hermes-agent` profile, it is used instead of the default token:

   ```bash
   todou login https://todou.example --profile hermes-agent
   ```

   Without such a profile the auto rule stays inert and the default token
   is used. Precedence: `--profile` > `TODOU_TOKEN` > `TODOU_PROFILE` >
   auto-selection > default token (`--profile default` opts out).

2. **Provenance metadata.** Every write (comments, issue events) carries
   an `X-Todou-Agent-Context` header recording
   `{ agent: "hermes-agent", session_id, model }`. The server stores it on
   the affected comments/events, the API returns it on timeline items, and
   the web timeline shows it as a small badge. Authorship is still the
   authenticated user — this is self-reported context for display and
   auditing, not authentication.

Run `todou whoami` inside a gateway turn to see what would be reported:

```
token: profile "hermes-agent" (auto-detected harness)
detected harness: hermes-agent (session agent:main:telegram:dm:1000001)
```

## Where the metadata comes from

- **Detection** — a turn counts as hermes when `HERMES_SESSION_KEY` is set
  (the gateway bridges its session context into every child environment),
  or `_HERMES_GATEWAY=1` marks a keyless process in the gateway tree.
  `HERMES_HOME` alone is *not* a signal: an ordinary shell may export it
  permanently just to relocate hermes state.
- `session_id` — the hermes session key
  (`agent:<agent>:<platform>:<chat_type>:<chat_id>`, e.g.
  `agent:main:telegram:dm:1000001`). It is the durable identity of the
  chat the agent acts for, and already encodes the platform and chat type.
  Note that `hermes --tui --resume` takes the *rotating* per-conversation
  session id, not this key, so the web badge copies the key itself rather
  than a resume command.
- `model` — hermes exposes no environment variable for the live model, so
  the CLI looks it up in `$HERMES_HOME/state.db` (an *unofficial*,
  hermes-internal sqlite database) via the `node:sqlite` builtin, opened
  read-only: the durable session id comes from `HERMES_SESSION_ID`, or is
  resolved from the session key through the gateway routing index. The
  routing index is the normal path — a gateway turn bridges
  `HERMES_SESSION_ID` through as an empty string, since the gateway binds
  only the session key. On
  older Node versions without `node:sqlite`, or whenever any step fails,
  the field is simply omitted; detection never breaks a command.

## Adding the next harness

Detectors live in `projects/cli/src/harness/`, one file per harness behind
a common interface, ordered innermost-first in `index.ts` (a harness whose
environment variables are inherited by agents it spawns goes after the
harnesses it can spawn). A new harness needs: the detector file, its
registry entry, tests under `projects/cli/test/harness/`, optionally a
resume-command entry in `projects/web/src/lib/harness.ts` (without one the
badge copies the session id), optionally a token profile on the host —
and a page like this one.
