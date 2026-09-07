# Metadata on a card

Namespaced key/value pairs hung off an issue, for state a program keeps: which phase an orchestrator
has a card in, which run last touched it, which agent claimed it. Shaped like k8s annotations — the
namespace partitions, the value is opaque, nothing is versioned.

Not a label and not a comment. A label is a name a person picks from the project's catalog; a comment
is something someone said. This is neither, and it is deliberately invisible until asked for.

```bash
todou metadata get 16 -p <proj>                          # every namespace
todou metadata get 16 --namespace orch,ci                # only these
todou metadata namespaces 16                             # names, key counts, newest write
todou metadata set 16 --namespace orch phase=impl owner=agent-1
todou metadata set 16 --namespace ci --key report --value-file ./out.json
todou metadata unset 16 --namespace orch phase owner
```

## What a write does, and does not do

- **Only the keys named are touched.** Everything else in the namespace stays where it was.
- **Writing a value that is already stored changes nothing at all** — no timestamp moves, no
  subscriber is woken. Replaying a state after a restart is free, so a program may write what it
  believes unconditionally.
- **Nothing about it is announced.** No timeline entry, no unread marker on anyone's list, no bump of
  the card's `updated_at`. A card written to ten times a minute does not climb to the top of a list
  and does not appear in anyone's inbox.
- `value: null` — spelled `metadata unset` — deletes a key. `key=` writes the empty string, which is
  a value like any other. Deleting a key that is not there is not an error.

## Compare-and-set

`--if-match key=value` expects that key to hold exactly that value right now; `--if-absent key`
expects it not to exist. If any expectation fails, **the whole request is refused**, nothing is
stored, the current values are printed and the exit code is 1.

```bash
# Claim a card, losing cleanly to whoever got there first.
todou metadata set 16 --namespace orch owner=agent-1 --if-absent owner

# Move a state only if it is still where you last saw it.
todou metadata set 16 --namespace orch phase=impl --if-match phase=plan
```

They are two flags rather than one because the empty string is a legal value: `--if-match key=` means
"expected to be empty", and "expected to be missing" needs a spelling that cannot be confused with it.

## Reading it beside a card

`issue view` and `issue list` take `--metadata <ns…>` (`*` for all), which fetches the values along
with the card or the page — one request for a whole page, however many cards it holds. That is the
shape to reach for when a program needs the state of many cards at once; the standalone `metadata get`
is for one card.

**Without the flag neither command mentions metadata at all**, and the server reads nothing. Absent
and empty are different answers: no flag means nobody asked, an empty list means this card holds
nothing under those namespaces.

## As a search condition

`metadata:` filters which cards match. It does **not** make the values searchable — a value is never
found by a free-text term, never returned as a hit, never highlighted. See `references/search.md`.

## Limits

| Object | Limit |
|---|---|
| namespace | 1–63 characters, lowercase letters and digits, with `.` `-` `_` between them |
| key | the same character set, 1–128 characters |
| value | 4096 **bytes** of UTF-8 (a CJK character is three) |
| per card | 8 namespaces, 32 keys in each |

Case is rejected rather than folded: two keys differing only in case would be one bug waiting to
happen, and a program picking its own keys is better served by an error on the first write.

Reading needs `reader`, writing needs `writer` — there is no per-namespace permission, so any writer
in the project can change any namespace, including one another tool believes it owns.

## `todou watch` never reports it

A watch resumes from a cursor, and a cursor is a position in the timeline. Metadata writes leave no
timeline entry on purpose, so a watch could deliver them while connected and never replay the ones it
missed while it was not — half a guarantee, for an agent whose only wake-up signal this is. So it
carries none of them at all. Poll `metadata get` if a program has to follow a value.
