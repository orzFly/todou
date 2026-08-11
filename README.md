# todou 🥔

A to-do list app — reads as **To-Do**, sounds like **土豆** (potato).
See [docs/codename.md](docs/codename.md) for the naming story.

## Layout

pnpm workspace, packages under `projects/*`:

| Package | Description |
| --- | --- |
| `projects/server` | Backend API server (clipanion entry) |
| `projects/web` | React + Vite frontend (shadcn/ui planned) |
| `projects/cli` | `todou` client CLI, for humans and agents (clipanion) |

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

# Bind this git repository to a server/project (stored in the user
# config, not the repo), then work from anywhere inside it:
todou project link my-project
todou issue list --open
todou issue create --title "Fix the potato" --body "It sprouted."
todou issue view 1
todou issue close 1 --comment "done"

# Agents/CI need no config file, and every command takes --json:
TODOU_SERVER=… TODOU_TOKEN=todou_pat_… TODOU_PROJECT=… todou issue list --json

# Store a separate identity per agent: inside Claude Code (CLAUDECODE=1)
# the "claude-code" profile is picked automatically, and every write is
# stamped with the session/model as timeline metadata.
todou login https://todou.example --profile claude-code
```

`todou --help` lists every command; `todou api <method> </path>` reaches
any endpoint the CLI doesn't wrap yet. See
[docs/claude-code.md](docs/claude-code.md) for the Claude Code integration.

### Production: one process, one port

Point `http.static_dir` at the built web app and the server serves it
alongside the API, so there is no second process and no proxy to configure:

```bash
pnpm build
node projects/server/src/index.ts serve   # :8637 serves both the SPA and /api
```

```toml
[http]
port = 8637
static_dir = "./projects/web/dist"       # relative paths resolve against the CWD
```

Hashed files under `/assets` are served immutable; `index.html` is
revalidated, and any unmatched non-`/api` path returns it so the client
router can resolve deep links. Because the SPA is then same-origin with the
API, the session cookie and the SSE stream need no CORS or reverse-proxy
buffering setup. See [docs/deploy.md](docs/deploy.md) for a full deployment.

### Database placement

```toml
[database]
system = "pglite://./data/system"        # or postgres://…

[database.projects]
placement = "shared"                     # project data lives in the system db
# placement = "dedicated"                # …or route each project by template:
# url_template = "pglite://./data/projects/${project.id}"
# url_template = "postgres://${project.id > 100 ? 'pg-b' : 'pg-a'}/todou_${project.id}"
# workers = true                         # experimental: worker-thread PGlite hosts
```

`url_template` is compiled once at startup as a JS template literal with
`project = {id, slug}` in scope — keep it deterministic; per-project moves
go through the registry's `database_url` override column.

`todou-server migrate` applies pending migrations to the system database
and every project database (pglite auto-migrates on open by default;
postgres requires the explicit command).
