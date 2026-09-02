# Rich content in bodies and comments

These features do not change the length rules; the comment discipline in SKILL.md still applies.

## Attachments

`todou attach -p <proj> <n> file.png …` prints `#id name → url`, for example
`#12 shot.png → /api/projects/<proj>/attachments/12/download/shot.png`. Paste the URL verbatim
instead of rewriting it into an absolute one.

- `[name](…/download/name.ext)` links the attachment; `![](…/download/name.ext)` embeds it inline.
  Images, text files and markdown all render in place.
- Attach single-file demo pages (mockups, prototype HTML) to the relevant issue instead of leaving
  them on local disk only.
- Reading them back: `attach list -p <proj> <n>` is the authoritative set, because the timeline
  records upload events and a body links only what someone chose to link. Its `#id` column is what
  `attach download -p <proj> <n> <id|name>` addresses, by id or by exact filename when unambiguous.
  Without `-o` the file lands in the current directory under its own name and never overwrites;
  `-o <dir>` writes into that directory, `-o <file>` writes exactly there, `-o -` streams to stdout.
- `attach download` and `todou api` authenticate the way every other command does, so there is no
  reason to copy a token out of `config.toml` into a hand-written `curl`. To inspect the configuration
  (which server, which profile, why this project), run `todou config show`. It answers offline and
  logged out, and prints no token value.

## Permalinks

Every timestamp is a link to that one entry (`#comment-<id>`, `#event-<id>`). Paste one to send the
reader to a specific comment or event, and paste one into `todou comment view <url-with-fragment>` to
read that comment without taking the link apart. The ids come from `comment list` and `issue events`,
which is also where a body too long for a watch line is read in full.

## Issue refs

A project writes its issues either bare (`#12`) or with a prefix (`T-12`). It is a per-project
setting, and a guessed ref links nowhere. Every command that knows an issue number prints it spelled:
the first line of `issue view` (`--brief` shows just that), the start of every `issue list` row, the
start of every watch line, and the echo of `comment add`. Fenced and inline code are exempt from ref
parsing, so a ref can be quoted without creating a link.

- Write a ref when the link carries meaning: a follow-up, a dependency, a duplicate. A ref notifies
  the card it points at, so do not enumerate incidental cards; "rebased onto latest master" says more
  than a list of the cards the branch passed. Write "this card" instead of a ref to the card you are on.
- In source and commit messages write the project's own form. In a public repo a bare `#N` autolinks
  to the host's own issue numbering, so where the project has no prefix, name the tracker in prose
  instead of writing `#N`.
- Every `<number>` positional accepts `<proj>/16`, `"#16"`, the project's own form (`T-16`) or a full
  issue URL. Input accepts any spelling; output uses the project's.
