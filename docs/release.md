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
- **`docs/releases/vX.Y.Z.tag.txt`** — the tag message: a title line plus a
  short paragraph (the `v0.1.0` shape), handed to the script with
  `--tag-message-file`. Commit it yourself; only the notes file gets picked up
  on its own.

### How to write the body

The reader wants "what do I care about in this version". The appended commit
list already carries the detail, so the body must not restate it.

- **Conclusion first, bullets not prose.** Bold the claim, one line of why.
  Five bullets per section; past that, split or cut.
- **No preamble, no recap, no closer.** No scene-setting paragraph on top.
- **Write for users, not a changelog** — what changed and what it means for the
  reader. Implementation detail stays in the commits.
- **Measured numbers earn their space** (before/after, latency, counts);
  explanatory build-up does not.
- **Never omitted**: behaviour changes with their caveats, breaking changes
  (say "None" outright when there are none), the upgrade order and how a
  mismatched pair degrades, and any migration a human has to run.

66 lines is the right order of magnitude. 126 is not.

## Approving the notes

Both artifacts go through the spec review gate on the release card, and nothing
is tagged before the verdict:

```bash
todou spec push <release-card> <dir>
```

A spec set rather than a comment: it carries inline annotations and a diff
between versions — the same reason designs and plans live there.

- **`spec push` takes `.md` only**, so the tag message goes up as
  `vX.Y.Z.tag.md` and lands in the repo as `vX.Y.Z.tag.txt`. Map each file to
  its repo path in the pointer comment.
- **Changes requested**: `todou spec comments <n> --unresolved` → edit →
  `spec resolve` → push the next version → wait again.
- **A verdict only counts against the latest version**, so any edit after an
  approve — including a wording fix while cutting — needs a fresh push and a
  fresh approve.

## Cutting a release

1. Decide the version and write both artifacts above.
2. Get them approved on the card (above), on the version you are shipping.
3. Land both files. Committing them yourself and leaving the notes untracked
   both work: the script's `git add` is a no-op on a file that is already
   tracked and unchanged. The tag message file it only reads, so commit that
   one yourself either way.
4. Hand over to the orchestrator, who runs the release **in the main
   checkout**. `release.sh` requires HEAD to be `master` and to equal
   `origin/master`, so it cannot run from a worktree: an agent that drafted
   the notes sits on a `worktree-*` branch, where `--dry-run` downgrades both
   checks to warnings and a real run exits 1. That agent stops with its branch
   committed and the notes approved; the orchestrator takes it from there:

   ```bash
   # the notes branch is one commit; the script pushes only at the very end,
   # so master has to be on origin before it runs
   git merge --ff-only <agent-branch>
   git push origin master
   scripts/release.sh 0.2.0 --tag-message-file docs/releases/v0.2.0.tag.txt \
     --co-author "Claude Opus 5 <noreply@anthropic.com>"
   ```

   The script verifies (master, clean, synced with origin, notes present,
   tag free), bumps the five `package.json` files, commits
   `chore(release): v0.2.0`, tags, and pushes `master` + tag to origin
   first, then to the GitHub mirror. `--co-author` adds the trailer on agent
   runs. `--dry-run` rehearses the full command sequence from any branch,
   downgrading failed checks to warnings.

5. The tag on the mirror triggers CI:
   - **release.yaml** asserts the checkout describes exactly as the tag and
     the manifests agree, builds the CLI artifacts, asserts the built
     `todou.cjs --version` answers with the tag, then creates the GitHub
     release from `docs/releases/vX.Y.Z.md` + generated commit list.
   - **docker.yaml** builds the multi-arch image with the version baked in
     and tags it `latest`, `x.y`, `x.y.z`, plus the date and sha tags.
6. Deploy and distribute as usual (see `docs/deploy.md` — checkout
   deployments pick the version up from their own git state; images carry it
   baked in).

## Who does what

| Step | Who |
|---|---|
| Decide to release | the user |
| Draft notes + tag message | anyone (usually an agent, on the release card, on its own branch) |
| Approve them (spec review) | the user — a precondition for tagging |
| Merge to `master`, push, run `scripts/release.sh` | the orchestrator, in the main checkout |
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
