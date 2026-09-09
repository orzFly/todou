---
name: todou-compact
description: Read a whole todou card, write down only what the discussion settled that no other artifact already holds, then hide the comments that are covered. An argument is a description of what the summary should focus on. Use when a card's middle has become exploration that has since reached a conclusion.
disable-model-invocation: true
---

# Compacting a card's discussion (todou edition)

A long card's middle is exploration: options weighed, numbers a later number overturned, a mockup
replaced twice. Its conclusion by now lives somewhere else — a spec, a commit, another card — and the
exploration is in the way. This skill reads the whole card, writes down whatever the discussion
settled that no other artifact holds, and hides the comments that are covered. Read `/todou-cli`
first: the review gate, what a spec document may hold, and the discipline governing a card's body are
there and are not repeated here. `<proj>` comes from the host project's config.

## Steps

1. Run `todou agent can-i-follow` and do what it says. **Do not move the card.** The sister skills
   open with In Progress because they are development; compacting is not, and the card may be sitting
   on Done.
2. Read the card with the one command below.
3. Rule a ledger: one line per unit of discussion, one verdict each.
4. Post the summary comment — if the ledger found anything to write.
5. Check the id list against the exemptions, then hide by id.
6. Report in the terminal: the ledger, what the summary said, and which ids this run actually moved.

The flow has no checkpoint in it. It writes one comment and performs one hide.

## When not to run

**No state of the spec refuses a card.** One still under review is compacted like any other, because
the protection is per comment rather than per card: an unanswered question and an unresolved
annotation are `live` on the ledger and are held back by the check before writing, while the settled
comments around them are not.

What that leaves you carrying: coverage is judged against the spec as it reads **now**, and a version
still under review may drop the sentence you counted on. Judge `covered` on the text in front of you
and let a later run reconcile it — that is what `--include-hidden` is for.

Where a card has no spec and what its discussion needs is a design rather than a summary, report that
and stop. Do not write a two-thousand-word comment in place of `/todou-brainstorm`.

## Reading the card

```bash
todou issue view <n> -p <proj> --include-hidden
```

One command answers everything the ledger asks: the body; every comment in full, hidden ones marked
`(hidden)`; question text, options and the answers; each inline annotation with its file, anchor,
version and resolved state; renames, references and status changes; and the `spec: vN · <verdict>`
header. `comment list`, `question list`, `spec comments` and `issue events` are narrower views of the
same timeline and add nothing, and one read also buys a consistent snapshot — a write landing between
four commands leaves the ledger describing a card that never existed. Two other commands matter and
neither is a source of discussion: `todou spec pull <n> <dir>` fetches the documents the ledger
reconciles against, `todou attach list <n>` is the authoritative set of attachments, wanted only when
the summary points at one.

**`--include-hidden` is not belt and braces.** Comments an earlier run hid are reconciled again
against the text as it stands now, because a spec rewritten since may no longer cover what one of
them concluded, and no other read would ever notice.

## The ledger

Working notes for the run, kept in no store. One line per unit — a comment, a question, an annotation
— and exactly one verdict:

| Verdict | Means | Consequence |
|---|---|---|
| `covered` | what it established is already written in another artifact | note where; hide it |
| `gap` | it established something no artifact records | into the summary; hide it |
| `live` | not settled | leave it alone |
| `mechanics` | no content of its own: "pushed v3", "watch started" | hide it |

`live` comes in three shapes, and the third is the dangerous one: an unanswered question and an
unresolved annotation are both structurally visible, but **a standing instruction** — a comment saying
how to work rather than what to build — carries no structural mark, so the `hide` selectors cannot see
it and a spec does not cover it, a spec describing the thing this card builds. The test: **a comment
about the way the work is done is `live`, unless the summary adopts it as a requirement.** One whose
practice this card's own documents already carry is `covered` by them, even where the wider lesson it
came wrapped in is recorded nowhere; what keeps one `live` is that complying would still mean reading
the comment.

With a spec present the ledger's question is one sentence: *are this card's comments, questions and
answers all written down in the spec?* An answered question counts as `covered` only where the spec or
the summary states that answer **as a requirement** — not "the user picked the card face", but "the
ledger is kept on the card face". An `answered` event cannot be hidden, so once the question comment
is away a reader without `--include-hidden` is left with a bare `q1: 1) card face`: option labels, no
question. With the requirement written down that line reads as provenance; without it, it is noise.

**A gap in the spec is reported, never fixed.** This skill does not `spec push`. The missing conclusion
goes into the summary comment, which sits on the card where whoever edits the spec next will see it,
and the terminal report names what the spec lacks. What a spec's prose should look like belongs to the
skills that write specs.

## The summary comment

It holds the ledger's `gap` lines and nothing besides. **If everything is recorded already, write no
comment at all** — a normal outcome, not a failure.

1. **Do not repeat what another artifact already holds** — the card, a spec, a PRD, a plan, an ADR, a
   commit, a diff. Point at it with a path or a URL.
2. **Do not write what will not be done.**
3. **Do not write what this run did.** How much was read, what was measured, how many comments went
   away: none of it. The summary says what the card's discussion settled; the run's own account goes
   to the terminal.
4. **No chronicle.** Who said what and when, the path the exploration took, an intermediate number a
   later number overturned — all out.

No word limit. It is complete when every `gap` on the ledger has a home in it, and concise when no
sentence in it could be replaced by a URL.

## Hiding

Two selectors, one job each:

```bash
todou comment hide <n> -p <proj> --all --keep-last 0 --dry-run   # candidates and exemptions
todou comment hide <n> -p <proj> <id> <id> …                     # the write
```

`--keep-last 0` because the tail is a convenience count and this run wants the **complete** exemption
list rather than one truncated by it; the `would skip` block, each line carrying its reason, is the
authoritative one. The write then names ids — the candidates intersected with the ledger's `covered`
and `mechanics` — because the selectors judge only whether a comment is **structurally** settled
(question answered, annotation resolved, new enough) while covered is a judgement about meaning, and a
standing instruction looks settled in every structural way, so a selector will always pick it up.

The skip reasons get two different attitudes:

- `within the tail kept back` — **overridable**. A convenience count, not a claim that anything is
  unsettled; a compacted card should read as body plus summary.
- `question unanswered`, `spec annotation unresolved` — **never overridden**. This is the alignment
  with T-281: no second set of exemptions, and no using "ids override the selectors" to get past these
  two.

### Check before writing

**The id list must be disjoint from every `question unanswered` and `spec annotation unresolved` line
in that skip block. Verify it, then write.** This is the last step before the write, not a review
after it, and **annotations are not sorted by author** — a third party's opinion is as unsettled as
your own.

It has to be an explicit act, because writing by id has no guard rail: `todou comment hide <n> <id>
--dry-run` says nothing at all about an id a selector would have exempted, only `would hide 1
comment(s)`. Only the `--all` path lists skips and reasons. The CLI will neither stop you nor warn you.

Nothing upstream screens these two out. No card is refused on the state of its spec, so an unanswered
question and an unresolved annotation both reach this point on an ordinary run, and this check is the
only thing standing between them and the write.

What makes it mandatory is the stakes, not the test. Hiding is becoming "hide and settle on the way
past" — an unanswered question auto-declined and hidden with the rest, an unresolved annotation
auto-resolved, **including one somebody else wrote**. A mistake is then no longer a hidden comment that
was still alive, which `unhide` takes back; it is a refusal to answer submitted in the user's name and
a third party's review dismissed, and neither comes back. The damage also travels: a count of zero
unresolved annotations then means either that somebody dealt with them or that a hide resolved them in
passing, and `spec push --wait` routes its outcome on that count, so a bad hide can flip a revision
round's verdict instead of merely dirtying a number.

**Never reach for a spelling that does not honour the exemptions**, whatever surface offers one.

Report as soon as the write returns. The report must name **the ids this run actually moved**: those
sent that the read did not already show as `(hidden)`. The CLI gives that as a count, `hid N
comment(s)`, which the list must match. That list is the argument for a precise reversal, and it is
needed because `unhide --all` is not one — it would also restore whatever a person hid by hand earlier.

**This skill does not unhide.** Hiding records no timeline event and does not move `updated_at`, so who
hid a comment cannot be established afterwards, and T-281 deliberately allows an operator to hide one
good settled comment by id. There is no telling that decision from an earlier run's mistake, so the
report names the comments it believes were hidden wrongly and stops there.

The summary comment is not hidden by the run that wrote it.

## Arguments

`/todou-compact <argument>` describes **what the summary should focus on**, and the summary is written
to that focus, carrying only the `gap` lines bearing on it. A focused run therefore **hides less, not
more**: coverage is what licenses a hide, so a `gap` left out of the summary is not covered and its
comments stay.

## Running it twice

A second run on the same card needs no record of the first; the ledger derives the answer from the
same `--include-hidden` read, hidden comments reconciled afresh against the text as it stands. No new
`gap` and no line that should have been hidden and was not means zero words written, zero comments
hidden, and a report of nothing to do. An earlier run's summary comment may be hidden by a later one
on one condition: **the later run's own summary has taken its content over.** Age alone is not a
reason.

## Boundaries

- **The body and the title are not touched.** The body is the original report — the user's own words
  and the evidence they handed over — and nothing covers it, so the summary goes to a comment rather
  than into it; a title naming a symptom is not rewritten because the cause was later found.
  `/todou-cli`'s "Filing a card" governs the moment a card is opened, this skill the discussion after.
- **The status is not touched.**
- **No spec is pushed and none is edited.** This skill reads specs. How a spec should be written
  belongs to the skills that write them; the only question asked here is whether the discussion's
  conclusions are recorded somewhere.
- **No new exemptions.** The storage, the default read, the write endpoint and "nothing unsettled gets
  hidden" are T-281's. This skill adds one semantic condition on top — settled is not enough, it must
  also be covered by text somebody wrote down — and asks T-281 to change nothing.
