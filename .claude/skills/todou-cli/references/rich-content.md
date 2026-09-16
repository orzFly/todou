# Rich content in bodies and comments

The rules for when to attach, when to write a ref and where tokens may not go are in SKILL.md; this
file holds the shapes. These features do not change the length rules either.

## Attachments

`todou attach -p <proj> <n> file.png …` prints `#id name → url`, for example
`#12 shot.png → /api/projects/<proj>/attachments/12/download/shot.png`.

- `[name](…/download/name.ext)` links the attachment; `![](…/download/name.ext)` embeds it inline.
  Images, text files and markdown all render in place.
- `attach list -p <proj> <n>` is the authoritative set, because the timeline records upload events and
  a body links only what someone chose to link. Its `#id` column is what
  `attach download -p <proj> <n> <id|name>` addresses, by id or by exact filename when unambiguous.
  Without `-o` the file lands in the current directory under its own name and never overwrites;
  `-o <dir>` writes into that directory, `-o <file>` writes exactly there, `-o -` streams to stdout.

## Permalinks

Every timestamp is a link to that one entry (`#comment-<id>`, `#event-<id>`). Paste one to send the
reader to a specific comment or event, and paste one into `todou comment view <url-with-fragment>` to
read that comment without taking the link apart. The ids come from `comment list` and `issue events`,
which is also where a body too long for a watch line is read in full.
