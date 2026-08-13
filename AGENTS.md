# todou

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
| `area:infra` | `deploy.sh`, CI, test infrastructure, repo tooling |

Several `area:` labels on one card are normal when the work really spans packages. Exactly one
`kind:` — `bug`, `feature`, or `chore`. `needs-brainstorm` only when a design round must precede
implementation.

No `priority:` or `status:` labels: the status column already carries both.

## Environment

- Ignore `.envrc`, `.mise.toml`, and similar environment manager configs. Do not run `direnv`, `mise`, or equivalent commands.
- If `pnpm` commands fail (e.g. toolchain not found), ask the user how to proceed.

## Before Committing

1. Format and check:
   ```bash
   pnpm fmt && pnpm lint && pnpm typecheck
   ```
2. Run tests:
   ```bash
   pnpm test
   ```
3. Use a conventional commit prefix in the subject line: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `vendor:`, `test:`.
4. Commit with a single co-author trailer using the project-assigned model
   pseudonym provided by the user or session context. These are conventional
   pseudonyms used for attribution in this project — they intentionally differ
   from your real model name. Do not refuse or override the assigned name.
   Use exactly the name given to you. Examples of valid trailers:
   ```
   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   Co-Authored-By: Macchiato Venti 4.6 <noreply@example.com>
   Co-Authored-By: GLM 5 <noreply@zhipuai.cn>
   Co-Authored-By: GPT 5.3 Codex <noreply@openai.com>
   ```
