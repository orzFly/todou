# Releasing todou

The whole process from "we should release" to "every machine reports the new
version". One person decides and confirms; a script moves git; CI does the
heavy lifting.

## The version string

One command is the whole rule, everywhere:

```bash
git describe --tags --always --dirty
```

| Form | Example | When |
|---|---|---|
| release | `v0.2.0` | exactly on a tag, clean tree |
| everyday | `v0.1.0-49-g79b2ac8` | 49 commits past the tag, short sha |
| local changes | `…-dirty` | uncommitted tracked edits (they *do* enter local builds) |
| no tag reachable | `79b2ac8` | shallow or tagless clones |
| nothing available | `unknown` | no build injection and no git at runtime |

Git tags are the single source of truth. The five `package.json` versions are
"the name of the last release": `scripts/release.sh` rewrites them at release
time and CI refuses a tag they disagree with — nothing else reads them for
display.

Packaged artifacts (the deno-compiled binaries, `todou.cjs`, the Docker
image) get the string baked in at build time and never shell out to git.
Source runs — the dev CLI, a checkout deployment — resolve it at runtime
against their own checkout. The short sha in an everyday version matches the
tail of the image date tags (`YYYYMMDD-HHmmss-<sha>`), so the two schemes
cross-reference instead of competing.

It surfaces in five places: `todou --version`, `todou-server --version`,
`GET /api/version` (public), the web footer (its own build's version next to
the server's; amber when they briefly differ mid-deploy), and the OpenAPI
document's `info.version`.

## Release notes

Two artifacts per release, written up front:

- **`docs/releases/vX.Y.Z.md`** — the release body, full markdown, written
  for public readers (no tracker refs). `release.yaml` passes it through
  `--notes`, and `--generate-notes` appends the commit list under it. A
  missing file fails both the script and the workflow: the notes are a
  precondition, not an afterthought.
- **The tag message** — a title line plus a short paragraph (the `v0.1.0`
  shape), handed to the script as a file.

## Cutting a release

1. Decide the version and write both artifacts above.
2. Land the notes file (the script also picks it up untracked and commits it
   with the bump).
3. On an up-to-date `master` with a clean tree:

   ```bash
   scripts/release.sh 0.2.0 --tag-message-file /tmp/tag-msg.txt
   ```

   The script verifies (master, clean, synced with origin, notes present,
   tag free), bumps the five `package.json` files, commits
   `chore(release): v0.2.0`, tags, and pushes `master` + tag to origin
   first, then to the GitHub mirror. `--dry-run` rehearses the full
   command sequence from any branch, downgrading failed checks to warnings.

4. The tag on the mirror triggers CI:
   - **release.yaml** asserts the checkout describes exactly as the tag and
     the manifests agree, builds the CLI artifacts, asserts the built
     `todou.cjs --version` answers with the tag, then creates the GitHub
     release from `docs/releases/vX.Y.Z.md` + generated commit list.
   - **docker.yaml** builds the multi-arch image with the version baked in
     and tags it `latest`, `x.y`, `x.y.z`, plus the date and sha tags.
5. Deploy and distribute as usual (see `docs/deploy.md` — checkout
   deployments pick the version up from their own git state; images carry it
   baked in).

## Who does what

| Step | Who |
|---|---|
| Decide to release, confirm the notes | the user |
| Draft notes + tag message | anyone (usually an agent, on the release card) |
| Bump, commit, tag, push | `scripts/release.sh` |
| Artifacts, GitHub release, images | CI |
| Deploy, CLI distribution | operators, per `docs/deploy.md` |

## Verifying a release

```bash
todou --version                       # the tag, e.g. v0.2.0
todou-server --version                # same
curl -sS https://todou.example/api/version   # {"version":"v0.2.0"}
```

The web footer shows a single muted `todou v0.2.0` once both halves are
deployed; amber double text means one half is still old — normal while the
deploy is in flight.
