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

## Referencing another project's issues

A reference can name a project other than the one it is written in. The
target issue's timeline records a `cross_referenced` event, the same way a
local reference records `referenced`.

Spellings, all equivalent:

```
mirror#12       mirror/12       mirror/M-12       mirror/#12
```

The prefix inside `mirror/M-12` is decoration: the slug decides the
project and the number decides the issue, so a reference written today
survives the target changing its format tomorrow.

It survives the target changing its *slug* too. A slug a project has
retired keeps resolving to it, and text written before the rename is
read against who held that slug at the time — so if another project
later takes the spelling over, old references still mean what they said,
and only new writing goes to the new holder.

A bare foreign prefix also works. Writing `M-12` in another project
resolves to `mirror#12` when `M` had exactly one holder at the moment the
text was written. Two projects may share a prefix; while they do, the bare
form resolves to neither and stays plain text. Write the slug-qualified
form when you need certainty.

A comment can be referenced by its own id, either on its own within the
project that holds it, or hanging off any issue reference:

```
#comment-1462        T-12#comment-1462        mirror/M-12#comment-1462
```

Both link to that comment and count as a reference to the issue carrying
it.

### Which rule wins

When several rules could claim the same text, they are tried in this
order:

1. slug-qualified forms and comment anchors
2. this project's own reference format
3. this project's autolinks
4. a bare foreign prefix

Autolinks outranking foreign prefixes is deliberate: a rule an
administrator configured here beats another project happening to use the
same prefix. The shadowed side is still reachable through the qualified
form. Because a qualified form outranks everything, an autolink prefix
that collides with one (`mirror#`) is rejected when you try to create it.

### Who sees what

A reference renders richly only for a reader who can open the target
project. For everyone else it stays plain text, identical to what its
author typed — the title, the status, and the existence of the project are
never revealed.

The reverse event follows the same principle from both ends. It is only
written when its **author** can read the target project, so a reference
cannot post into a project the writer has no access to. It is only shown
to a reader who can open the **source** project, so nobody is left with a
timeline entry, an inbox row, or an unread marker pointing somewhere they
may not go.

### Existing text

All of this applies only to content created after the feature reached your
deployment. Text written before then parses exactly as it did, so
`mirror/T-12` in an old comment keeps whatever meaning it already had.

## CLI

Issue positionals accept every spelling: `todou issue view 76`, `#76`,
`T-76`, `todou/T-76`, `todou#76`, or a full URL. The prefix is not
validated against the project's configured one — the positional already
names its project.
Human-readable output spells issues in the project's current format;
against servers without the config endpoint it falls back to `#N`.

`--json` says the same thing in fields, so a script never has to guess
(T-134):

- Beside every issue number sits its spelled form — `number` → `ref`
  (`issue list`/`view`/`create`/`edit`/`close`), `issue_number` →
  `issue_ref` (`todou watch` items, `comment add`/`edit`).
- Envelopes the CLI builds — `issue list`, `issue view`, `issue watch`,
  single-project `todou watch` — also carry
  `ref_format: {prefix, token}`. Spell any number as `token + number`.
  This is the only source on an empty page or a bare timeline, where no
  `ref` exists to copy. A cross-project `todou watch` stream has no one
  format and omits the field; its items carry `issue_ref` instead.

Both degrade to the `#N` form (`{"prefix": null, "token": "#"}`) against
a server without the config endpoint.

A `cross_referenced` event carries its source as `by_project` and
`by_issue`; spell it `<by_project>#<by_issue>` and it pastes back into any
command that takes an issue.

## Conventions unaffected

The `Spec: <issue-ref> spec vX` commit trailer is an agent convention that
todou's code never parses; it keeps working whichever form the ref takes.
For repositories mirrored to GitHub, prefer the prefixed form in new
commit messages so GitHub doesn't claim the reference.
