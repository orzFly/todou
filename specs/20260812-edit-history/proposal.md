# Proposal: edit support with history and diffs

Source: [todou#16](https://todou.example/projects/todou/issues/16) — "comment 要支持修改，还有修改历史", filed by the user, status Next.

## Original requirements (issue body, verbatim)

> 1. issue title要有修改event
> 2. issue body和comment body都要支持修改，和修改历史
> 3. 要有 diff，参考 npm:@pierre/diffs https://diffs.com/docs

During the session the user added:

> https://github.com/pierrecomputer/pierre/tree/main/apps/docs/app/(diffs)/docs
>
> the doc is at

(pointing at the source location of the @pierre/diffs documentation.)

## Findings established during exploration

- `title_changed` timeline events already exist end-to-end: the server emits
  them with `{from, to}` payloads and the web renders "renamed … → …".
  Verified live with a probe issue in the `dogfood` project. The CLI, however,
  prints the event raw: `title_changed (to=… from=…)`.
- Issue body edits currently leave no event and no history; comment edits set
  `edited_at` but overwrite the old text irrecoverably.
- The web UI has no comment-edit control at all; only the PATCH endpoint and
  shared-client method exist.

## Questions asked and answers

### Q1 — Where should edit history and diffs surface in the web UI?

Options offered (with ASCII mockup previews):

- **GitHub-style (Recommended)** — The "(edited)" marker on a body/comment
  becomes clickable and opens a revision list with diffs. Issue body edits
  also add a compact timeline row; comment edits stay out of the timeline.
- **Timeline-centric** — Every body and comment edit becomes a timeline event
  row that expands inline to show the diff. No dropdown on the items
  themselves.
- **Both** — Revision dropdown with diffs on each body/comment, plus timeline
  event rows for every edit (body and comments alike). Most visibility, most
  noise.

**Answer:** no option selected; note: "GitHub-style, but \"edited the
description/comment\" event is not needed."

(So: history lives on each item's "(edited)" control only; no new timeline
event rows for body or comment edits. Existing `title_changed` events stay.)

### Q2 — How much CLI work should be in scope? Today the CLI has `issue edit --body` but no way to edit a comment, and no way to view edit history (it also prints title events raw: `title_changed (to=… from=…)`).

Options offered:

- **Edit + polish (Recommended)** — Add `todou comment edit <issue>
  <commentId> --body`, and make `issue view` print title events nicely
  (renamed "a" → "b") plus an (edited) marker on edited comments. No history
  viewing in the CLI — `todou api` can fetch revisions raw if ever needed.
- **Full parity** — Everything from "Edit + polish" plus a history command
  (e.g. `todou issue history` / `comment history`) that lists revisions and
  prints unified text diffs in the terminal.
- **Web only** — No CLI changes in this spec. The PATCH endpoints already
  exist; CLI work happens later if wanted.

**Answer:** Edit + polish (Recommended).

### Q3 — Which storage approach for edit history?

Options offered:

- **A: Snapshot table (Recommended)** — New body_revisions table, one row per
  edit storing the superseded body + editor + agent context. Diffs rendered
  client-side from adjacent snapshots.
- **B: Hidden timeline events** — Store from/to in issue_events with new
  types, filtered out of the timeline. No new table, but pagination filtering
  and 2× body per edit.
- **C: Patch-only storage** — Server computes and stores unified diffs;
  smallest storage but chained reconstruction and a server-side diff
  dependency.

**Answer:** "A。不过表的设计可以斟酌一下，我可以预想到本项目之后还会有别的东西有
diff——后续会把spec加入todou，我们不再在硬盘上写spec，而是把spec提交到todou来
review和追踪。届时每个spec里的每个文件，也会有版本追踪的需求"

(So: approach A, but design the table generically — specs will be added to
todou later, written and reviewed in todou rather than on disk, and every file
in every spec will need version tracking with diffs too.)

### Q4 — Does the data model look right — generic polymorphic `revisions` table (snapshot-before-edit per row), extendable to spec files later, titles staying on timeline events?

Options offered:

- **Looks right** — Proceed to the API section on this foundation.
- **Needs changes** — Something about the table shape, subject typing, or
  title handling should be different — I'll say what.

**Answer:** Looks right.

### Q5 — API & server behavior — two reader-role revision endpoints with server-side before/after pairing, revision capture inside the existing PATCH transactions, only on real changes?

Options offered:

- **Looks right** — Proceed to the web UI section.
- **Needs changes** — Something about the endpoints, response shape, or write
  path should be different — I'll say what.

**Answer:** Looks right.

### Q6 — Web UI (popover → diff dialog, comment editing added) and CLI/test scope — all good?

Options offered:

- **Looks right** — I'll write the design doc (brainstorm.md + proposal.md),
  commit, and open the redline review.
- **Needs changes** — Something in the web UI, CLI, or test plan should be
  different — I'll say what.

**Answer:** Looks right.
