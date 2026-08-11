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
