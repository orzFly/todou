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
- **No build step**: server and CLI execute `.ts` sources directly; the web
  app is served by Vite.
- Biome for formatting and linting, Vitest for tests.

```bash
pnpm fmt        # format + fix
pnpm lint       # check formatting and lints
pnpm typecheck  # tsc --noEmit in every package
pnpm test       # vitest in every package
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
