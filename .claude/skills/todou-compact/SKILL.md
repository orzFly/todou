---
name: todou-compact
description: Read a whole todou issue, record what the discussion settled that no other artifact holds, then hide the comments that are covered. An argument sets what the summary focuses on. Use when an issue's middle has become exploration that has since reached a conclusion.
disable-model-invocation: true
---

# Compacting an issue's discussion

- Record what the discussion settled that no other artifact holds, then hide the comments covered.
- One summary comment, one hide, no checkpoint.

## Steps

1. Watch the issue now (`/todou-cli`). **Do not take it** — no status, no assignee: compacting is not
   development, and the issue may be Done or held by someone still working on it.
2. Read it once: `issue view <n> --include-hidden`. Body, every comment (hidden ones marked),
   questions and answers, annotations with anchor and resolved state, events, spec header — one
   consistent snapshot. Also `spec pull` for the documents, `attach list` for attachments.
3. Ledger: one line per comment, question or annotation; one verdict each.
4. Post the summary comment, if the ledger found gaps.
5. Check, then hide by id.
6. Report in the terminal: the ledger, the summary, the ids this run moved.

- No spec state refuses an issue; protection is per comment. Judge against the spec as it reads now.
- No spec, and the discussion needs a design rather than a summary: report and stop (`/todou-brainstorm`).

## The ledger

| Verdict | Means | Consequence |
|---|---|---|
| `covered` | what it established is written in another artifact | note where; hide it |
| `gap` | it established something no artifact records | into the summary; hide it |
| `live` | not settled | leave it alone |
| `mechanics` | no content of its own: "pushed v3", "watch started" | hide it |

- `live` includes a **standing instruction** — a comment on how to work, not what to build. It has
  no structural mark, so the hide selectors cannot see it. It stays `live` unless the summary adopts
  it as a requirement or this issue's documents already carry the practice.
- An answered question is `covered` only where the spec or summary states the answer as a
  requirement ("the ledger is kept on the card face", not "the user picked card face"): the `answered`
  event cannot be hidden, and without the question it reads as bare option labels.
- A gap in the spec is reported, never fixed: this skill does not `spec push`.

## The summary comment

- Only the `gap` lines. Nothing to add → no comment, a normal outcome.
- Point at another artifact (issue, spec, commit, diff) instead of repeating it.
- Not what will not be done, not what this run did (that goes to the terminal), no chronicle.
- Complete when every gap has a home; concise when no sentence could be replaced by a URL.
- Not hidden by the run that wrote it.

## Hiding

```bash
todou comment hide <n> -p <proj> --all --keep-last 0 --dry-run   # candidates, full skip list with reasons
todou comment hide <n> -p <proj> <id> <id> …                     # the write
```

- Ids: the candidates that the ledger marks `covered` or `mechanics`. Selectors only see whether a
  comment is structurally settled; covered is a judgement about meaning.
- `within the tail kept back` may be overridden. `question unanswered` and `spec annotation
  unresolved` never.
- **Before the write, check the ids against every `question unanswered` and `spec annotation
  unresolved` line.** Hiding by id has no guard rail, and these two are irreversible: it declines the
  question in the user's name and resolves the annotation, anyone's — which can also flip a
  `spec push --wait` outcome.
- Report the ids actually moved (sent, not already `(hidden)`); they must match `hid N comment(s)`.
- Never unhide: a hide leaves no event, so an earlier mistake cannot be told from a deliberate hide.
  Name the suspected wrong hides and stop.

## Arguments and reruns

- `/todou-compact <focus>`: the summary carries only gaps bearing on it, so the run hides less.
- A rerun needs no record of the earlier one: same read, hidden comments reconciled afresh. Nothing
  new → nothing written or hidden.
- An earlier summary may be hidden only once the new summary has taken its content over.

## Boundaries

- Body and title, status and assignee are untouched. No spec is pushed or edited.
