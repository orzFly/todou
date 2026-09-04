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

## Moving an issue to another project

A card can be moved between projects. It takes a **new number** in the
destination — numbers belong to a project, and the one it had may already be
taken — and its old address becomes a permanent tombstone that redirects.

```
todou issue transfer T-123 --to b        # asks first, showing the mapping
todou issue transfer T-123 --to b -y
todou issue transfer T-123 --to b --dry-run
```

### Old links keep working

Nothing that points at the old address is rewritten, and nothing has to be.
The tombstone answers for all of it:

- `a/123` and any `#N` or `T-123` that resolves to it → the card at its new
  address.
- `a/123#comment-1462` → the same comment under its new id.
- Attachment URLs pasted into markdown → the same file where it now lives.
  Browsers follow this on their own, so embedded images keep rendering. The
  rich attachment card travels too: the filename, the size and the inline
  preview come from the file's current home, not just its bytes.
- Every address under the card — its spec at any version, its timeline,
  questions, edit history and attachment list → the same thing at the card's
  new address. The redirect points at the address that was asked for, so a
  caller that follows it receives the resource it requested, with the query it
  sent left as it was.

Resolution is one hop however many times the card has moved: every address it
has ever had points straight at the current one, not at the previous one.

Who may follow an old address is decided by where the thing is now: anyone who
can read the project it moved to. Someone who can read neither end gets a plain
404, which admits nothing about the address ever having been used. That holds
wherever the address is typed: the CLI, an attachment URL, a `#comment-N` in a
body, and an old *card* or *spec* link opened in the web UI, which follows the
redirect without ever reading the project the link names.

### The card's own references are respelled once

A bare `#12` written while the card lived in `a` means `a/12`. Read under the
destination's numbering it would name a different card, so the move rewrites
that one spelling into `a#12`, which names its project outright and stays
correct through every later move. `PREFIX-12` and `#comment-N` written at the
old address are rewritten the same way, and so is every version of the card's
spec documents. This is the only moment the system changes text a person
wrote.

The text as its author typed it is kept as a revision, attributed to whoever
performed the move. The card is not marked as edited: an "(edited)" mark means
the author changed their words.

Only the spans holding a reference change. The rest of the markdown is byte
for byte what it was, and references inside code blocks or inline code are
left alone.

Where that rewrite cannot be made safely the old rule still applies: the text
is parsed under whoever owned the card when it was written. The main case is
text written before this deployment opened the cross-project reference syntax,
because the qualified form does not parse under the grammar in force back
then.

Cards that moved before this behaviour existed are rewritten by
`todou-server refs backfill`, which an operator runs once.

### Moving back

Moving a card back into a project it has lived in before returns it to its
original number. The tombstone never gave the number up, so there is nothing
to collide with, and the card's number in that project is stable across any
number of round trips.

### What the destination cannot take

Statuses map by name, then to the destination's default for the same
open/closed category. Labels and assignees with no counterpart there are
dropped and reported — in the command's output, in the API response, and on
the `moved in` timeline entry. `--dry-run` shows all of it before anything
happens.

### Readers without access to the destination

Someone who cannot read the destination project gets `410 Gone` at the old
address: the card existed and has moved, and nothing more. The destination
project and number are never disclosed, in the response body, the timeline
entry, or the activity stream.

### Two known limitations

- **Editing old text does not re-date it.** A `#1` *added* to a pre-move
  comment is still read under the project that owned the card when that
  comment was first written. Write the qualified form (`b#1`) to be explicit.
- **A cross-project reference committed in the same instant as the move** may
  lose its timeline entry. The reference itself is unaffected — the link
  resolves and redirects as usual — only the "referenced by" row is missed.
  This is the best-effort semantics cross-project references already have.

A single-issue watch cursor does not survive a move: it is a row position in
the project the card has left. `todou issue watch` prints the new ref and a
cursor to resume from.

## CLI

Issue positionals accept every spelling: `todou issue view 76`, `#76`,
`T-76`, `todou/T-76`, `todou#76`, or a full URL.

A prefix names a project, so a positional carrying one is resolved rather
than read as a number in the current project. `T-76` goes through the same
priority order the renderer uses:

1. the current project's own prefix, as configured right now
2. one of its autolink prefixes, which is refused — an autolink points at
   an external tracker, so there is no todou card to open
3. the cross-project directory, when exactly one project you can read
   holds the prefix
4. otherwise refused, naming the prefixes within reach and suggesting a
   near miss where there is one

A prefix held by several readable projects is refused the same way, as is
one whose holders you cannot all see. Every refusal exits 1 and happens
before any issue is fetched.

`slug/PREFIX-76` is checked too: the prefix has to be one the named project
writes now or wrote in the past, so a ref pasted out of an old commit
message still resolves while a mistyped one is caught.

Where a prefix resolves to a project other than the one `-p/--project`
names, the command is refused instead of following either. Only that flag
counts — `TODOU_PROJECT`, `.todou.toml` and the git binding are still
overridden silently, as they are by `todou/76`. So `-p` remains a fence
around the project you meant, and a cross-project positional needs the
flag dropped or the qualified spelling written out.

Against a server whose reference config cannot be read the prefix is
ignored and the number is taken as the current project's, which is what
the CLI did before prefixes resolved at all.

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

## Web

The search box in the project header reads a query that is *entirely* one
reference and offers where it points, so a pasted ref reaches the card in
one keystroke; anything else is an ordinary search, unchanged. Every
spelling a CLI positional takes works here too — `76`, `#76`, `T-76`,
`t-76`, `todou/T-76`, `todou#76`, a bare foreign prefix, a `#comment-1462`
anchor, a full URL of this deployment — resolved by the same priority order
as above. The results page carries the same offer, which is where a shared
`?q=T-76` link lands.

The card is looked up before it is offered, so a trashed card, a project
you cannot read, and a number nobody used are indistinguishable: none of
them is offered, and Enter searches for the text instead. An autolink
prefix gets a row of its own pointing out of todou — and where `#` is both
the recommended autolink and a number typed into todou's own box, `#76`
offers the card and the external tracker as two rows rather than choosing
one for you.

## Conventions unaffected

The `Spec: <issue-ref> spec vX` commit trailer is an agent convention that
todou's code never parses; it keeps working whichever form the ref takes.
For repositories mirrored to GitHub, prefer the prefixed form in new
commit messages so GitHub doesn't claim the reference.
