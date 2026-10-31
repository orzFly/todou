# DSH

todou identifies DeepSeek Harness writes with `DSH_SESSION_ID` and uses the
`dsh` credential profile, falling back to `harness`. No plugin installation or
replacement launcher is required.

```sh
todou login https://todou.example --profile dsh
```

## Detection

`dsh-shell-env` rebuilds the trusted `DSH_*` environment for every model shell
call. `DSH_SESSION_ID` is the id of the session whose turn is calling, and
`DSH_HOME` is the harness home the overlay came from; a nested agent gets its
own id rather than inheriting the caller's. That id is what the timeline badge
shows and what a reader copies.

## Model

DSH publishes no model variable. todou reads the live pair from the session
projection cache DSH keeps for its desktop UI:

`$DSH_HOME/storages/session_projcache/sessions/<session_id>.json`, row
`modelSelection.lastUsed.model`.

That cache is an internal format and may move. When it is missing, stale, or
unreadable, the write still reports `dsh` and the session id; only the model is
omitted, so detection never turns a probe failure into a failed command.

## Session badge

The badge copies the session id. DSH resumes sessions in its own desktop
window, so there is no portable resume command for todou to offer.
