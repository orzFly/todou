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

`HARNESS_IDS` in `projects/shared/src/schemas/agent-context.ts` is the list
both registries key off. Add the id there first; the CLI and web builds then
name what is still missing.

1. **Detector** — `projects/cli/src/harness/<id>.ts` plus its entry in
   `index.ts`, and tests under `projects/cli/test/harness/`. That array is
   ordered innermost-first: a harness whose environment variables are
   inherited by the agents it spawns goes *after* the harnesses it can
   spawn, so the nearest host wins.
2. **Logo** — a mark in `projects/web/src/lib/harness-logos.tsx` and its
   `logo` entry in `projects/web/src/lib/harness.ts`. Not optional:
   `HARNESS_META` is a `Record` over the whole id union with `logo`
   required, so the web build fails until the mark exists, and every
   harness todou detects wears its own logo rather than the generic bot.

   Take the upstream mark rather than drawing one —
   [lobe-icons](https://github.com/lobehub/lobe-icons) carries most agent
   brands as 24×24 `currentColor` SVGs. Vendor the paths into
   `harness-logos.tsx`; do not add the package, which peer-depends on a
   whole UI stack this app does not use. Keep the path verbatim, and copy
   its licence into the mark's doc comment: this repository is public, and
   a permissive licence still has terms — MIT requires the copyright and
   permission notice to travel with the copy. Note that a licence over a
   brand-icon collection is not a trademark grant from the brand owner.
3. **Resume command** — optional `resume` in that same entry. Without one
   the badge copies the raw session id, which is the right answer when the
   harness cannot resume from what it reports.
4. **Token profile** on the host, and a page like this one — both optional.
