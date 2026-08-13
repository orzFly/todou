# Using todou alongside an external issue tracker

On a GitHub repository, `#N` belongs to GitHub's built-in tracker — commit
messages like `close #4` are claimed by it, and anything todou-related
written as `#N` gets misread. todou solves this per project with two
settings (Project settings → References):

1. **Issue reference format** — how this project's own issues are written:
   the default `#76`, or a prefixed form like `T-76` (prefix = a capital
   letter followed by capitals, digits, or underscores).
2. **Autolinks** — GitHub-style rules that turn `prefix + number` tokens
   into external links, e.g. `#` → your GitHub issues. Autolinks are pure
   rendering: they never create `referenced` timeline events.

## Recommended setup for a project mirrored to GitHub

On the todou side:

- Set the reference format to a short prefix, e.g. `T`. New writing uses
  `T-76`; the web UI, timeline, and CLI display follow suit.
- Add an autolink `#` → `https://github.com/<org>/<repo>/issues/<num>` so
  GitHub issue/PR numbers pasted into todou link out. (The `#` prefix
  frees up only after the format switch — the settings page enforces
  non-overlapping prefixes.)

On the GitHub side (repository → Settings → Autolink references):

- Add an autolink with reference prefix `T-`, numeric IDs, and target URL
  `https://<your-todou-host>/projects/<slug>/issues/<num>`. Commit
  messages and issue text containing `T-76` then link back to todou.

## What happens to existing text

Nothing is rewritten, and nothing changes meaning. Content is parsed under
the reference format that was **in force when it was created**:

- `#12` written before the switch keeps rendering as a link to todou
  issue 12 — even after `#` is handed to GitHub. Editing an old comment
  does not change this; the anchor is its creation time.
- `T-34` that happened to appear in old text does not become a link.
- Issue numbers, existing `referenced` events, and their timelines are
  stored as bare numbers and are untouched. UI strings (rich-link
  suffixes, "referenced by …" lines, CLI headers) respell them in the
  current format.

Spec documents parse under the format in force when their version was
pushed; markdown attachments under their upload time.

## CLI

Issue positionals accept every spelling: `todou issue view 76`, `#76`,
`T-76`, `todou/T-76`, or a full URL. The prefix is not validated against
the project's configured one — the positional already names its project.
Human-readable output spells issues in the project's current format;
against servers without the config endpoint it falls back to `#N`.

## Conventions unaffected

The `Spec: <proj>#N spec vX` commit trailer is an agent convention that
todou's code never parses; it keeps working as-is. For repositories
mirrored to GitHub, prefer the prefixed form in new commit messages so
GitHub doesn't claim the reference.
