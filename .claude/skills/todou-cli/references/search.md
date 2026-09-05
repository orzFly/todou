# Searching a project

Search before paging through cards by hand.

```bash
todou search 全文搜索 -p <proj>              # anywhere in the project
todou search cursor 语义 -p <proj>           # both terms, any distance apart
todou search "中文分词" -p <proj>             # one phrase, in that order
todou search pg_trgm --in comments -p <proj> # only what was said in comments
```

- Terms are joined by AND, and each is a case-insensitive substring. `搜索` matches inside a longer
  run of Chinese, `WordDiff` matches `coalescedWordDiff`, and there is no stemming. Quote a phrase to
  keep it together; unquoted words may land anywhere in the same hit, and for an issue the title and
  the body count as one place.
- Each line reads `<ref>  <where>  <snippet>`, and `<where>` names what to read next: `comment <id>`
  leads to `comment view`, `spec <path>` to `spec pull`, and `issue` to `issue view`. Terms are
  highlighted in the snippet.
- `--in issues,comments,specs` narrows the sources; `--status`, `--label` and `--assignee` narrow as
  on `issue list`; `--limit N` caps the hits.
- Trashed items are not searchable, and only a spec's newest version is.
- Finding nothing exits 0, like every other read.
