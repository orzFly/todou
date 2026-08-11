# Edit history with diffs

Design for [todou#16](https://todou.example/projects/todou/issues/16): issue
body and comment body edits keep a browsable history rendered as diffs, and
edit affordances exist everywhere they should. Title changes already produce
`title_changed` timeline events end-to-end; they stay as-is (short one-line
values whose history is fully recorded in the event payloads), with only CLI
rendering polish.

## Goals

1. Every content-changing edit of an issue body or comment body is recorded
   with who edited, when, and agent provenance — from the moment this ships
   (history for pre-feature edits is unrecoverable).
2. History is browsable per item in the web UI, GitHub-style, with diffs
   rendered by `@pierre/diffs`. No new timeline event rows for body/comment
   edits.
3. Comments become editable from the web UI; the CLI gains `comment edit`.
4. The storage design generalizes: spec files will later be tracked and
   reviewed inside todou, and their per-file version history reuses the same
   table.

## Non-goals

- Revision deletion/redaction (GitHub's "delete sensitive revision") — later
  if ever.
- Cursor pagination of history; a `limit` cap suffices.
- CLI history viewing (`todou api` reaches the endpoints raw if needed).
- Title history via revisions — stays on timeline events.

## Data model

One generic project-tier table, polymorphic over the versioned subject:

```
revisions
  id            identity PK
  project_id    bigint
  subject_type  text          'issue_body' | 'comment'
  subject_id    bigint        issues.id / comments.id
  body          text          superseded content (snapshot BEFORE the edit)
  actor_id      bigint        who performed the edit that replaced it
  agent_context jsonb null    provenance of that edit
  created_at    timestamptz   when it was replaced
  index revisions_subject_idx (project_id, subject_type, subject_id, id)
```

- One row per content-changing edit; no seed row at creation and the current
  content is never duplicated. Newest-first, row 0's diff is
  `row0.body → current body`; row n's diff is `rowN.body → row(n-1).body`.
- `subject_type` is a TypeScript-level enum on a plain text column (this
  codebase's convention), so adding `'spec_file'` later is a code change with
  no migration. Grouped spec versions ("spec v3 = these five files") would
  live in future spec tables pointing at revision ids; this table stays a
  flat content-version store.
- No FKs to issues/comments — polymorphism forbids it. Service code cleans
  up: deleting a comment deletes its revisions in the same transaction.
- `issues` gains nullable `body_edited_at` (timestamptz), the description's
  counterpart to `comments.edited_at`, set whenever a body-changing edit
  lands.

Migration: `drizzle-kit generate` against `project-schema.ts` (new table +
new column), auto-applied at boot for PGlite as usual.

## API

Two read endpoints, reader role, OpenAPI-documented like the rest:

```
GET /api/projects/{slug}/issues/{number}/revisions
GET /api/projects/{slug}/issues/{number}/comments/{commentId}/revisions
```

Query: `limit` (default 50, max 100). Response, newest-first:

```jsonc
{
  "items": [
    {
      "id": 12,
      "actor": { /* UserRef */ },
      "created_at": "2026-08-12T10:00:00Z",
      "body_before": "…",
      "body_after": "…",   // paired server-side: next-newer snapshot, else current body
      "agent_context": { /* AgentContext | null */ }
    }
  ]
}
```

Server-side pairing keeps clients trivial: the web passes the two strings
straight to the diff component. Deleted-user actors get the existing ghost
fallback.

Shared schemas (`@todou/shared`): `Revision`, `RevisionPage`,
`RevisionQuery`; `Issue` gains `body_edited_at: Timestamp.nullable()`.
`TodouClient` gains `getIssueRevisions` / `getCommentRevisions`.

## Server behavior

No new write endpoints — the existing PATCHes grow history capture:

- `updateIssue`: when `input.body` is provided and differs from the current
  body, insert a revision (`subject_type='issue_body'`, old body, actor,
  agent context of the editing request) and set `body_edited_at`, inside the
  existing transaction. No timeline event.
- `updateComment`: same only-on-real-change guard; insert the revision and
  set `edited_at` in one transaction. (Fixes today's behavior of stamping
  `edited_at` on no-op saves.)
- No-op saves (identical body) still succeed and return the unchanged item;
  they just record nothing.
- `deleteComment`: also deletes the comment's revisions in the transaction.
- New `services/revisions.ts` owns recording + listing; issue/comment
  services call into it.

Timeline queries, cursors, and SSE are untouched. The web fetches history on
popover open, so it needs no cache invalidation wiring.

## Web UI

History viewing (GitHub-style):

- "(edited)" on comments — and now on the issue description whenever
  `body_edited_at` is set — becomes a trigger opening a popover that lists
  revisions: editor chip, agent badge, relative time, newest first, fetched
  on open.
- Selecting an entry opens a dialog rendering the diff with `MultiFileDiff`
  from `@pierre/diffs/react`: `oldFile`/`newFile` contents named
  `description.md` / `comment.md` (markdown highlighting), stacked layout,
  `{ dark: 'pierre-dark', light: 'pierre-light' }` theme following the
  system. Options/objects memoized per the library's stability guidance.
- One shared `RevisionHistory` component serves both the description block
  and comment items (takes a fetch function and a label).

Comment editing (new):

- Pencil icon on comments the viewer may edit (author, or project admin —
  server enforces; UI mirrors via `me` + members). Inline textarea with
  Save/Cancel matching the `BodyBlock` pattern, calling the existing
  `api.updateComment`, then invalidating the timeline query.

New dependency: `@pierre/diffs` in `projects/web` (peer deps react/react-dom
only; React 19 compatible).

## CLI

- New `todou comment edit <issueNumber> <commentId> --body/--body-file`
  (plus the standard `--json`/`--server`/`--profile`/`--project` flags),
  wrapping the existing PATCH.
- `issue view` polish: `title_changed` renders as `renamed "old" → "new"`;
  comments with `edited_at` show an `(edited)` marker.

## Testing

- **Server** (vitest, existing service-test style): revision recorded on
  real change only (no row, no `edited_at` bump on no-op saves);
  before/after pairing across multiple edits; `limit`; comment deletion
  cascades revisions; reader can list history; non-author non-admin cannot
  edit a comment.
- **Web**: pure-function tests for revision pairing/labelling helpers (same
  style as `describeEvent` tests).
- **CLI**: formatting tests for the `renamed` rendering and `(edited)`
  marker.

## Future: spec files

When specs move into todou, each spec file becomes a new `subject_type`
(e.g. `'spec_file'`) writing to the same `revisions` table with identical
snapshot-per-edit semantics. The revision list/diff UI and the
server-side pairing logic are subject-agnostic by construction, so that
feature adds routes and subject wiring, not a new history mechanism.
