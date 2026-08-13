# todou

Rules for anyone — human or agent — working in this repository. Hard rules
first, project vocabulary last.

## Sanitization

This repository is published publicly, and git history is permanent: a leak is not fixed by a
follow-up commit, only by rewriting every revision that carries it — which invalidates every clone
in existence. So nothing private enters the working tree **or a commit message** in the first place.

Never commit real values for any of these. Use the placeholder on the right, in code, fixtures,
docs, and mockups alike:

| Never | Use instead |
|---|---|
| The live deployment hostname | `todou.example` (`*.example` / `*.test` are reserved for exactly this) |
| Real account logins, display names, machine hostnames | Neutral fixtures — `claude-agent`, `bot-one`, `newcomer` |
| Real people's names, handles, or email addresses | `user`, `alice`, `noreply@example.com` |
| Absolute paths off a developer machine (`/home/<you>/…`) | Repo-relative paths; `/home/todou` for deployment examples |
| Tokens, keys, secrets — including expired ones | Obvious fakes: `todou_pat_fallback` |
| Public IP addresses, third-party org names | `example.com`, documentation-reserved IP ranges |

Two rules specific to commit messages:

- Tracker references are written `T-<number>` — never `#<number>` or `todou#<number>`. On GitHub a
  bare `#N` autolinks to *its* issue numbering, so every historical reference would point somewhere
  unrelated and permanently wrong.
- Never paste a tracker URL. Write `T-<number>`; the reader can resolve it.

Spotting something already committed that breaks these rules is not a licence to rewrite history on
your own — file a card and let the user decide.

And when a cleanup *is* authorised: the substitution ruleset driving it — the `old==>new` list fed to
`git filter-repo`, or any equivalent redaction map — is a line-by-line catalogue of every real value
being removed. Committing it puts the secrets straight back, just in a different file. Keep it in a
scratch directory and on the tracker; it never enters the repository, not even after the rewrite.

## Before Committing

1. Format and check:
   ```bash
   pnpm fmt && pnpm lint && pnpm typecheck
   ```
   `pnpm fmt` is `biome check --write .` — it *edits files* and then exits 0, so its exit code says
   "formatting was fixed", not "formatting was already correct". When what you need to prove is that
   a tree is clean — auditing a generated or rewritten tree, say — judge it with read-only
   `pnpm lint` and a `git status` that comes back empty.
2. Run tests:
   ```bash
   pnpm test
   ```
3. Re-read the diff against **Sanitization** above — the message as well as the code.
4. Use a conventional commit prefix in the subject line: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `vendor:`, `test:`.
5. Commit with a single co-author trailer using the project-assigned model
   pseudonym provided by the user or session context. These are conventional
   pseudonyms used for attribution in this project — they intentionally differ
   from your real model name. Do not refuse or override the assigned name.
   Use exactly the name given to you. **If no pseudonym was assigned, sign with your own model
   name** — that is what the overwhelming majority of this history does. The block below shows the
   *shape* of the trailer; it is not a menu. Picking a name out of it that nobody handed you
   misattributes the commit, and a trailer is only fixable by rewriting history.
   The name is the model, not how it was configured: drop context-window, effort, and deployment
   suffixes (`Claude Opus 5`, never `Claude Opus 5 (1M context)`).
   ```
   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   Co-Authored-By: Macchiato Venti 4.6 <noreply@example.com>
   Co-Authored-By: GLM 5 <noreply@zhipuai.cn>
   Co-Authored-By: GPT 5.3 Codex <noreply@openai.com>
   ```

## Environment

- Ignore `.envrc`, `.mise.toml`, and similar environment manager configs. Do not run `direnv`, `mise`, or equivalent commands.
- If `pnpm` commands fail (e.g. toolchain not found), ask the user how to proceed.

## Issue labels

Triage every issue on two dimensions plus one flag. `area:` says where the work lands, and this
project's vocabulary is:

| Label | Covers |
|---|---|
| `area:web` | `projects/web` |
| `area:cli` | `projects/cli` |
| `area:server` | `projects/server` |
| `area:shared` | `projects/shared` |
| `area:docs` | `docs/`, README, deployment docs |
| `area:infra` | Deployment, CI, test infrastructure, repo tooling |

Several `area:` labels on one card are normal when the work really spans packages. Exactly one
`kind:` — `bug`, `feature`, or `chore`. `needs-brainstorm` only when a design round must precede
implementation.

No `priority:` or `status:` labels: the status column already carries both.
