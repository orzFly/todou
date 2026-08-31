# todou 🥔

An issue tracker built for humans and AI agents working together. The name
reads as **To-Do** and sounds like **土豆** (tǔdòu, potato) — see
[docs/codename.md](docs/codename.md) for the naming story.

todou is a self-hostable tracker — projects, kanban board, issues, labels,
markdown comments and attachments — where agents are first-class users:

- **Machine accounts.** Agents authenticate with personal access tokens
  and can do everything a member can; create them in Settings → Agents.
- **Provenance badges.** Writes made from inside an agent session carry
  self-reported context (harness, model, session id), and the timeline
  shows it — you always know which comment came from whom, running what.
- **Spec review.** Versioned markdown document sets attached to an issue,
  with inline annotations and approve/request-changes verdicts — designs
  and plans get reviewed on the card, and git never carries them.
- **Native questions.** Agents post structured multiple-choice questions
  on the issue; humans answer all of them with a couple of clicks; the
  CLI blocks until the answers arrive.
- **Watch anywhere.** Cursor-based watching over SSE, for one issue or a
  whole project — an agent parks on a card and wakes when something
  happens, surviving restarts and outages without losing events.
- **Zero-setup storage.** Embedded PGlite by default, PostgreSQL when you
  need it, per-project database placement when you need that.
- **One CLI for everyone.** The same `todou` CLI serves humans, agents,
  and CI; standalone builds run without Node.

This repository is dogfooded: todou is developed by AI agents
coordinated through todou itself.

## Conventions

References like `T-76` — in commit messages, code comments, and docs —
point to cards on this project's own (self-hosted, not public) todou
tracker. The prefixed form exists so GitHub never mistakes them for its
own issue numbers; the full story is in
[docs/external-trackers.md](docs/external-trackers.md).

## Layout

pnpm workspace, packages under `projects/*`:

| Package | Description |
| --- | --- |
| `projects/server` | Backend API server (clipanion entry) |
| `projects/web` | React + Vite frontend (shadcn/ui) |
| `projects/cli` | `todou` client CLI, for humans and agents (clipanion) |
| `projects/shared` | Shared schemas, types, and API client |

## Toolchain

- Node 24 — runs TypeScript directly via native type stripping; the codebase
  uses erasable syntax only (`erasableSyntaxOnly` is enforced by tsconfig).
- **No build step for the server and CLI**: they execute `.ts` sources
  directly. The web app runs under Vite in development and is built to static
  assets for production.
- Biome for formatting and linting, Vitest for tests.

```bash
pnpm fmt        # format + fix
pnpm lint       # check formatting and lints
pnpm typecheck  # tsc --noEmit in every package
pnpm test       # vitest in every package
pnpm build      # build the web app to projects/web/dist
```

## Running

```bash
# 1. Start the server on :8637 (single-user mode, embedded PGlite — zero setup).
node projects/server/src/index.ts serve
#    Config: ./todou.toml or --config; every key has a TODOU_* env twin.

# 2. Start the web app on :8636 (dev server proxies /api to the server).
pnpm --filter @todou/web dev
#    TODOU_API=http://localhost:PORT overrides the proxy target.
```

The REST API is documented at `/api/openapi.json`. Agents are machine
users: create one in Settings → Agents, issue it a personal access token,
and it can do everything a member can via `Authorization: Bearer todou_pat_…`.

### CLI

The `todou` CLI runs straight from the checkout (`node
projects/cli/src/index.ts`); `pnpm --filter @todou/cli exec pnpm link
--global` puts a global `todou` on your PATH.

```bash
# Log in once — opens the browser to authorize the CLI and stores the
# token in ~/.config/todou/config.toml (0600). --manual pastes a token.
todou login https://todou.example

# On a machine with no browser of its own (SSH, container, headless VM):
# prints a one-time code to authorize from a browser anywhere, and waits.
todou login https://todou.example --no-browser

# Bind this git repository to a server/project (stored in the user
# config, not the repo), then work from anywhere inside it:
todou project link my-project

# No usable git remote? link writes a directory config instead —
# .config/todou.toml or .todou.toml at the repo root (or cwd) — which
# commands find by walking upward, stopping at repository roots, $HOME,
# and filesystem boundaries. --local/--global force either behavior.
cd ~/scratch/notes && todou project link my-project
todou issue list --open
# Search titles, bodies, comments and spec documents at once. Terms are
# ANDed and each is a substring, so a word inside a run of Chinese is found
# and `WordDiff` finds `coalescedWordDiff`; quote a phrase to keep it whole.
todou search 全文搜索
todou search pg_trgm --in comments
todou issue create --title "Fix the potato" --body "It sprouted."
todou issue view 1
todou issue view my-project/1   # project/number, "#1", "T-1", or an issue
                                # URL work anywhere <number> does; `show` = `view`
todou issue close 1 --comment "done"

# Which server, which profile, why this project — resolved, with the
# source of each. Purely local, so it answers when nothing is configured
# and when the server is down; it never prints a token value.
todou config show

# Agents/CI need no config file, and every command takes --json:
TODOU_SERVER=… TODOU_TOKEN=todou_pat_… TODOU_PROJECT=… todou issue list --json

# Store a separate identity per agent: inside Claude Code (CLAUDECODE=1)
# the "claude-code" profile is picked automatically, and every write is
# stamped with the session/model as timeline metadata. The "harness"
# profile serves every harness that has none of its own.
todou login https://todou.example --profile claude-code
todou login https://todou.example --profile harness
```

`todou --help` lists every command; `todou api <method> </path>` reaches
any endpoint the CLI doesn't wrap yet. See
[docs/claude-code.md](docs/claude-code.md) for the Claude Code integration.

#### Standalone builds

`pnpm run build:cli` (or `scripts/build-cli.sh` directly) produces
dependency-free CLI artifacts in `dist/` (git-ignored, not published to the
repo):

| File | Runtime needed | Size |
| --- | --- | --- |
| `todou-linux-amd64` / `todou-linux-arm64` | none (glibc) | ~108–109 MB |
| `todou-macos-arm64` | none | ~70 MB |
| `todou-windows-amd64.exe` | none | ~81 MB |
| `todou.cjs` | Node ≥ 20.12 on `PATH` | ~750 KB |

The four executables are built with `deno compile`, cross-compiled from a
single Linux machine — `deno` and `pnpm` are the only build prerequisites,
and the CLI sources need no adaptation to stay compilable. `todou.cjs` is an
esbuild bundle for size-sensitive users who already have Node: copy that one
file anywhere and run it, either as `node todou.cjs …` or directly
(`./todou.cjs`, it carries a shebang and the executable bit). Node 20.12 is
a hard floor (`util.styleText`), and older versions fail deceptively: piped
and `--json` output work fine, then interactive TTY use crashes. The `.cjs`
extension is deliberate — a `.js` bundle would be read as ESM and crash
inside any project whose `package.json` sets `"type": "module"`.

The Linux executables are dynamically linked against glibc, so they do not
run on musl-based images (Alpine). Deno publishes no musl target; use a
glibc base image (`debian-slim`, `ubuntu`, `*-slim` Node images) or ship
`todou.cjs` there instead.

macOS executables are only ad-hoc signed (not notarized): a `curl`/CI
download runs fine, but a browser download gets Gatekeeper-quarantined — run
`xattr -d com.apple.quarantine todou-macos-arm64` once before executing it.

The build never mutates the workspace: the prod-only dependency tree that
`deno compile` needs is staged in a scratch copy under `dist/.stage`, so
your `node_modules` keeps its devDependencies throughout.

Tagging `v*` runs the same script on a Linux runner and attaches `dist/*`
plus a `SHA256SUMS` file to the GitHub release
(`.github/workflows/release.yaml`; the procedure for cutting one is
[docs/release.md](docs/release.md)).

Releases are not the only source: every deployment hands out the builds it
was made from, over `GET /api/cli`, so a machine can fetch a CLI that matches
its server exactly — including `edge` and per-commit builds, which have no
release to download. The docker image carries all five; a checkout deployment
opts in with `scripts/pack-cli.sh`. See
[docs/deploy.md](docs/deploy.md#serving-the-cli).

### Production

One process serves both the SPA and the API: `pnpm build`, point
`http.static_dir` at `projects/web/dist`, run the server. The full guide —
systemd unit, reverse proxy, database placement and scaling — is
[docs/deploy.md](docs/deploy.md).

## License

[BSD-3-Clause](LICENSE).
