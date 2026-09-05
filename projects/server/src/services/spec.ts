import type {
  AgentContext,
  ChangeEvent,
  MemberRole,
  SpecCommentAnchor,
  SpecCommentItem,
  SpecComments,
  SpecCommentsResolveInput,
  SpecFileInput,
  SpecFiles,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
  SpecReviewResult,
  SpecReviewSubmitInput,
} from "@todou/shared";
import { diffLines } from "diff";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  specVersionFiles,
  specVersions,
} from "../db/project-schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { projectForRead, requireCapability, routeInfoOf } from "./access.ts";
import { loadReferenceInputs } from "./cross-references.ts";
import { encodeTimelineCursor } from "./cursor.ts";
import { resolveContent } from "./resolve-pass.ts";
import { microIso } from "./timeline.ts";
import {
  assertIssueReadable,
  assertIssueWritable,
  gateColumns,
  type TrashFields,
} from "./trash.ts";
import { getUserRefs } from "./users.ts";

/**
 * `gate` is the trash rule this caller reads under (T-145): every spec path
 * runs one, so a deleted card's spec is unreachable by the same rules as the
 * card itself.
 */
async function loadIssue<Role extends MemberRole | null>(
  db: Db,
  projectId: number,
  number: number,
  actor: UserRow,
  role: Role,
  // Generic in the role rather than spelled out once: the read gate takes a
  // nullable role since T-242 and the write gate does not, so either concrete
  // type would reject the other caller.
  gate: (row: TrashFields, actor: UserRow, role: Role) => void,
) {
  const rows = await db
    .select({
      ...gateColumns,
      specVersion: issues.specVersion,
      specReviewStatus: issues.specReviewStatus,
      specUnresolvedComments: issues.specUnresolvedComments,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  gate(row, actor, role);
  return row;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Newest version row of an issue's spec, or undefined when it has none. */
async function currentVersionRow(db: Db | Tx, issueId: number) {
  const rows = await db
    .select()
    .from(specVersions)
    .where(eq(specVersions.issueId, issueId))
    .orderBy(desc(specVersions.number))
    .limit(1);
  return rows[0];
}

async function filesOfVersion(db: Db | Tx, versionId: number) {
  return db
    .select()
    .from(specVersionFiles)
    .where(eq(specVersionFiles.versionId, versionId))
    .orderBy(asc(specVersionFiles.path));
}

export const utf8Size = (body: string) => Buffer.byteLength(body, "utf8");

export async function pushSpec(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: SpecPushInput,
  agentContext: AgentContext | null = null,
): Promise<SpecPushResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "spec.push",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueWritable,
  );

  // Spec files are markdown and get the same resolve pass as a body, so a
  // reference reads and edits the same way wherever it was written (T-266).
  // No events, though: a spec push has never recorded a reference, and
  // changing that is a decision of its own.
  const refInputs = await loadReferenceInputs(ctx, db, project.id);
  const files: SpecFileInput[] = [];
  for (const file of input.files) {
    const resolved = await resolveContent({
      ctx,
      db,
      project,
      actor,
      inputs: refInputs,
      text: file.body,
      self: { projectId: project.id, number: issueNumber },
    });
    files.push({ path: file.path, body: resolved.storedText });
  }

  const events: ChangeEvent[] = [];
  const result = await db.transaction(async (tx) => {
    // Serialize concurrent pushes on the issue row; the unique
    // (issue, number) index backstops anything that slips through.
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .for("update");

    const current = await currentVersionRow(tx, issue.id);
    const currentNumber = current?.number ?? 0;
    if (input.if_version !== undefined && input.if_version !== currentNumber) {
      throw new ConflictError(
        currentNumber === 0
          ? `--if-version ${input.if_version} does not match: the issue has no spec yet`
          : `--if-version ${input.if_version} does not match the current version v${currentNumber} — pull first, then retry`,
      );
    }

    const before = new Map(
      current
        ? (await filesOfVersion(tx, current.id)).map((f) => [f.path, f.body])
        : [],
    );
    const after = new Map(files.map((f) => [f.path, f.body]));
    const added = [...after.keys()].filter((p) => !before.has(p)).sort();
    const removed = [...before.keys()].filter((p) => !after.has(p)).sort();
    const changed = [...after.keys()]
      .filter((p) => before.has(p) && before.get(p) !== after.get(p))
      .sort();

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      // A push carries at least one file, so an issue with no spec yet
      // always adds one: reaching here means `current` exists.
      if (!current) throw new Error("unchanged push against no version");
      const [version] = await tx
        .select({ ts: microIso(specVersions.createdAt) })
        .from(specVersions)
        .where(eq(specVersions.id, current.id));
      if (!version) throw new Error("spec version row vanished mid-push");
      return {
        unchanged: true,
        version: currentNumber,
        added,
        changed,
        removed,
        // No new event to point at, so the waiting start is the lower
        // bound of the version's own instant: (t, 0, 0) sorts before every
        // real entry of that microsecond. Entries already at that instant
        // may be re-delivered — one extra wake-up, judged by state and
        // dismissed — which is the safe direction to err in.
        cursor: encodeTimelineCursor({ t: version.ts, k: 0, i: 0 }),
      };
    }

    const inserted = await tx
      .insert(specVersions)
      .values({
        projectId: project.id,
        issueId: issue.id,
        number: currentNumber + 1,
        authorId: actor.id,
        message: input.message ?? null,
        agentContext,
      })
      .returning();
    const version = inserted[0];
    if (!version) throw new Error("spec version insert returned no row");

    await tx.insert(specVersionFiles).values(
      files.map((f) => ({
        projectId: project.id,
        versionId: version.id,
        path: f.path,
        body: f.body,
        size: utf8Size(f.body),
      })),
    );

    const eventRows = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "spec_pushed",
        payload: {
          version: version.number,
          message: version.message,
          added,
          changed,
          removed,
        },
        agentContext,
      })
      // `created_at` comes back as µs text, not as the driver's Date: a
      // Date carries milliseconds only, and entries sharing a millisecond
      // are exactly what a cursor has to be able to tell apart.
      .returning({ id: issueEvents.id, ts: microIso(issueEvents.createdAt) });
    const event = eventRows[0];
    if (!event) throw new Error("event insert returned no row");

    // Denormalized spec state (T-23): a new version always resets the
    // review verdict — approvals never carry across pushes.
    await tx
      .update(issues)
      .set({
        specVersion: version.number,
        specReviewStatus: "unreviewed",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    events.push(
      {
        entity: "issue",
        id: issue.id,
        action: "updated",
        issue_number: issueNumber,
      },
      {
        entity: "timeline",
        id: event.id,
        action: "created",
        issue_number: issueNumber,
      },
      {
        entity: "spec",
        id: issue.id,
        action: current ? "updated" : "created",
        issue_number: issueNumber,
      },
    );
    return {
      unchanged: false,
      version: version.number,
      added,
      changed,
      removed,
      // The push event's own position. "Strictly greater" then excludes
      // the push itself and includes everything it will provoke — the
      // review verdict above all (T-182).
      cursor: encodeTimelineCursor({ t: event.ts, k: 1, i: event.id }),
    };
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  return result;
}

export async function getSpecInfo(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<SpecInfo> {
  // The spec reads below follow the card: a link to one written before the
  // card moved answers to whoever can read where it is now (T-245), which
  // takes reaching the tombstone before knowing the reader's role here. The
  // three writer entries in this file keep their own gate.
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueReadable,
  );

  const versionRows = await db
    .select({
      id: specVersions.id,
      number: specVersions.number,
      authorId: specVersions.authorId,
      message: specVersions.message,
      createdAt: specVersions.createdAt,
      // The driver's Date carries milliseconds only, and a cursor has to be
      // able to tell two entries of the same millisecond apart. `created_at`
      // below stays on the Date: it is display text, not a position.
      ts: microIso(specVersions.createdAt),
    })
    .from(specVersions)
    .where(eq(specVersions.issueId, issue.id))
    .orderBy(asc(specVersions.number));
  const current = versionRows.at(-1);
  if (!current) throw new NotFoundError("this issue has no spec");

  const refs = await getUserRefs(
    ctx.router.system(),
    versionRows.map((v) => v.authorId),
  );
  const files = await filesOfVersion(db, current.id);

  return {
    current_version: current.number,
    // (t, 0, 0) is the lower bound of the version's own instant, so a wait
    // from here also replays the `spec_pushed` event that made it — the same
    // cursor, minted the same way, an unchanged push reports.
    current_version_cursor: encodeTimelineCursor({
      t: current.ts,
      k: 0,
      i: 0,
    }),
    review_status: issue.specReviewStatus ?? "unreviewed",
    unresolved_comments: issue.specUnresolvedComments,
    files: files.map((f) => ({ path: f.path, size: f.size })),
    versions: versionRows.map((v) => {
      const author = refs.get(v.authorId);
      if (!author) throw new Error("author ref missing");
      return {
        number: v.number,
        author,
        message: v.message,
        created_at: v.createdAt.toISOString(),
      };
    }),
  };
}

export async function getSpecFiles(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  versionNumber?: number,
): Promise<SpecFiles> {
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueReadable,
  );

  let version: typeof specVersions.$inferSelect | undefined;
  if (versionNumber === undefined) {
    version = await currentVersionRow(db, issue.id);
    if (!version) throw new NotFoundError("this issue has no spec");
  } else {
    const rows = await db
      .select()
      .from(specVersions)
      .where(
        and(
          eq(specVersions.issueId, issue.id),
          eq(specVersions.number, versionNumber),
        ),
      );
    version = rows[0];
    if (!version) {
      throw new NotFoundError(`spec version v${versionNumber} does not exist`);
    }
  }

  const files = await filesOfVersion(db, version.id);
  return {
    version: version.number,
    files: files.map((f) => ({ path: f.path, body: f.body, size: f.size })),
  };
}

// — inline comments & reviews (T-23 phase 2) —

const QUOTE_LIMIT = 2000;

/**
 * The anchored source, verbatim. Columns (T-142) trim the ends: the first
 * line starts at `colStart`, the last ends at `colEnd`, everything between
 * stays whole — the same shape a browser selection has. Offsets are 1-based
 * inclusive UTF-16 code units, which is exactly `String.prototype.slice`'s
 * unit, so the quote the reviewer saw and the quote we store cannot drift.
 */
function quoteLines(
  body: string,
  start: number,
  end: number,
  colStart: number | null = null,
  colEnd: number | null = null,
): string {
  const lines = body.split("\n").slice(start - 1, end);
  const last = lines.length - 1;
  if (colStart !== null && colEnd !== null && last >= 0) {
    if (last === 0) {
      lines[0] = (lines[0] ?? "").slice(colStart - 1, colEnd);
    } else {
      lines[0] = (lines[0] ?? "").slice(colStart - 1);
      lines[last] = (lines[last] ?? "").slice(0, colEnd);
    }
  }
  const quote = lines.join("\n");
  return quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;
}

/**
 * Map a 1-based inclusive line range of `oldBody` onto `newBody`. The range
 * survives only when it sits wholly inside one unchanged region: anything
 * else — deletion overlap, insertion or deletion splitting it — means the
 * anchored text no longer reads the same, i.e. outdated (GitHub semantics).
 * Exported for tests.
 */
export function remapLineRange(
  oldBody: string,
  newBody: string,
  start: number,
  end: number,
): { outdated: boolean; start: number | null; end: number | null } {
  if (oldBody === newBody) return { outdated: false, start, end };
  let oldPos = 1;
  let newPos = 1;
  for (const part of diffLines(oldBody, newBody)) {
    const count = part.count ?? 0;
    if (part.added) {
      newPos += count;
    } else if (part.removed) {
      const oldEndEx = oldPos + count;
      if (start < oldEndEx && end >= oldPos) {
        return { outdated: true, start: null, end: null };
      }
      oldPos = oldEndEx;
    } else {
      const oldEndEx = oldPos + count;
      if (start >= oldPos && end < oldEndEx) {
        const shift = newPos - oldPos;
        return { outdated: false, start: start + shift, end: end + shift };
      }
      if (start >= oldPos && start < oldEndEx) {
        // Starts here but runs into the next change → split by an edit.
        return { outdated: true, start: null, end: null };
      }
      oldPos = oldEndEx;
      newPos += count;
    }
  }
  return { outdated: true, start: null, end: null };
}

async function versionByNumber(
  db: Db | Tx,
  issueId: number,
  number: number,
): Promise<typeof specVersions.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(specVersions)
    .where(
      and(eq(specVersions.issueId, issueId), eq(specVersions.number, number)),
    );
  return rows[0];
}

export async function submitSpecReview(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: SpecReviewSubmitInput,
  agentContext: AgentContext | null = null,
): Promise<SpecReviewResult> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "spec.review",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueWritable,
  );

  const events: ChangeEvent[] = [];
  const result = await db.transaction(async (tx) => {
    // Same lock as pushSpec: a review and a push racing on one issue
    // serialize, so the version check below cannot go stale mid-commit.
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .for("update");

    const current = await currentVersionRow(tx, issue.id);
    if (!current) throw new NotFoundError("this issue has no spec");
    if (input.version !== current.number) {
      throw new ConflictError(
        `the spec moved to v${current.number} while you were reviewing v${input.version} — reload and review the current version`,
      );
    }
    // The account that pushed the version under review must not sign it
    // off: agents can never approve their own spec.
    if (current.authorId === actor.id) {
      throw new ForbiddenError(
        `v${current.number} was pushed by this account — its review must come from someone else`,
      );
    }

    // Validate every anchor against its stored version and stamp quotes.
    const versionCache = new Map<
      number,
      Map<string, string> // path → body
    >();
    const fileMap = async (number: number) => {
      const cached = versionCache.get(number);
      if (cached) return cached;
      const row =
        number === current.number
          ? current
          : await versionByNumber(tx, issue.id, number);
      if (!row) {
        throw new ValidationFailedError(
          `anchor version v${number} does not exist`,
        );
      }
      const map = new Map(
        (await filesOfVersion(tx, row.id)).map((f) => [f.path, f.body]),
      );
      versionCache.set(number, map);
      return map;
    };

    const anchored: Array<{ anchor: SpecCommentAnchor; body: string }> = [];
    for (const comment of input.comments) {
      const files = await fileMap(comment.anchor.version);
      const body = files.get(comment.anchor.path);
      if (body === undefined) {
        throw new ValidationFailedError(
          `anchor ${comment.anchor.path} does not exist in v${comment.anchor.version}`,
        );
      }
      // Undefined lines = file-level comment (T-61): nothing to range-check
      // and nothing to quote — the anchor is the file itself.
      const lineStart = comment.anchor.line_start ?? null;
      const lineEnd = comment.anchor.line_end ?? null;
      let colStart = comment.anchor.col_start ?? null;
      let colEnd = comment.anchor.col_end ?? null;
      if (lineStart !== null && lineEnd !== null) {
        const lines = body.split("\n");
        if (lineEnd > lines.length) {
          throw new ValidationFailedError(
            `anchor ${comment.anchor.path}:${lineStart}-${lineEnd} exceeds the file (${lines.length} lines in v${comment.anchor.version})`,
          );
        }
        if (colStart !== null && colEnd !== null) {
          const startLen = (lines[lineStart - 1] ?? "").length;
          const endLen = (lines[lineEnd - 1] ?? "").length;
          // Both columns are 1-based inclusive indexes of a character
          // (@todou/shared's SpecCommentAnchorInput), which `quoteLines`
          // then slices with — so `len` is the largest legal one at either
          // end. `len + 1` is not "the caret at end of line", it is a
          // producer that failed to step off the newline (T-169).
          if (colStart > startLen || colEnd > endLen) {
            throw new ValidationFailedError(
              `anchor ${comment.anchor.path}:${lineStart}.${colStart}-${lineEnd}.${colEnd} exceeds the anchored lines (${startLen} and ${endLen} characters in v${comment.anchor.version})`,
            );
          }
        }
      } else {
        // A file-level anchor cannot carry columns; the schema already
        // rejects that, so this only guards a future caller that bypasses it.
        colStart = null;
        colEnd = null;
      }
      anchored.push({
        anchor: {
          path: comment.anchor.path,
          version: comment.anchor.version,
          line_start: lineStart,
          line_end: lineEnd,
          col_start: colStart,
          col_end: colEnd,
          quote:
            lineStart !== null && lineEnd !== null
              ? quoteLines(body, lineStart, lineEnd, colStart, colEnd)
              : "",
        },
        body: comment.body,
      });
    }

    const commentIds: number[] = [];
    if (anchored.length > 0) {
      const inserted = await tx
        .insert(comments)
        .values(
          anchored.map((a) => ({
            projectId: project.id,
            issueId: issue.id,
            authorId: actor.id,
            body: a.body,
            component: { type: "spec_comment" as const, anchor: a.anchor },
            agentContext,
          })),
        )
        .returning();
      for (const row of inserted) {
        commentIds.push(row.id);
        events.push({
          entity: "timeline",
          id: row.id,
          action: "created",
          issue_number: issueNumber,
        });
      }
    }

    let summaryCommentId: number | null = null;
    if (input.body !== undefined) {
      const inserted = await tx
        .insert(comments)
        .values({
          projectId: project.id,
          issueId: issue.id,
          authorId: actor.id,
          body: input.body,
          agentContext,
        })
        .returning();
      const summary = inserted[0];
      if (!summary) throw new Error("summary comment insert returned no row");
      summaryCommentId = summary.id;
      events.push({
        entity: "timeline",
        id: summary.id,
        action: "created",
        issue_number: issueNumber,
      });
    }

    const eventRows = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "spec_review",
        payload: {
          version: current.number,
          verdict: input.verdict,
          comment_id: summaryCommentId,
          annotation_count: anchored.length,
        },
        agentContext,
      })
      .returning();
    const event = eventRows[0];
    if (!event) throw new Error("event insert returned no row");

    await tx
      .update(issues)
      .set({
        specReviewStatus:
          input.verdict === "approve" ? "approved" : "changes_requested",
        specUnresolvedComments: sql`${issues.specUnresolvedComments} + ${anchored.length}`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    events.push(
      {
        entity: "timeline",
        id: event.id,
        action: "created",
        issue_number: issueNumber,
      },
      {
        entity: "spec",
        id: issue.id,
        action: "updated",
        issue_number: issueNumber,
      },
      {
        entity: "issue",
        id: issue.id,
        action: "updated",
        issue_number: issueNumber,
      },
    );

    return {
      event_id: event.id,
      version: current.number,
      verdict: input.verdict,
      summary_comment_id: summaryCommentId,
      comment_ids: commentIds,
    };
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  return result;
}

export async function resolveSpecComments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: SpecCommentsResolveInput,
  agentContext: AgentContext | null = null,
): Promise<{ resolved: number[] }> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "spec.resolve",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueWritable,
  );

  const events: ChangeEvent[] = [];
  const resolved = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.issueId, issue.id),
          inArray(comments.id, input.comment_ids),
        ),
      )
      .for("update");
    const byId = new Map(rows.map((r) => [r.id, r]));
    const paths: string[] = [];
    for (const id of input.comment_ids) {
      const row = byId.get(id);
      if (!row) throw new NotFoundError(`comment ${id} not found`);
      if (row.component?.type !== "spec_comment") {
        throw new ValidationFailedError(`comment ${id} is not a spec comment`);
      }
      if (row.resolvedAt !== null) {
        throw new ConflictError(
          `comment ${id} was already resolved at ${row.resolvedAt.toISOString()}`,
        );
      }
      paths.push(row.component.anchor.path);
    }

    const now = new Date();
    await tx
      .update(comments)
      .set({ resolvedAt: now, resolvedBy: actor.id })
      .where(inArray(comments.id, input.comment_ids));

    const eventRows = await tx
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.id,
        type: "spec_comments_resolved",
        payload: { comment_ids: input.comment_ids, paths },
        agentContext,
      })
      .returning();
    const event = eventRows[0];
    if (!event) throw new Error("event insert returned no row");

    await tx
      .update(issues)
      .set({
        specUnresolvedComments: sql`greatest(${issues.specUnresolvedComments} - ${input.comment_ids.length}, 0)`,
      })
      .where(eq(issues.id, issue.id));

    events.push(
      {
        entity: "timeline",
        id: event.id,
        action: "created",
        issue_number: issueNumber,
      },
      {
        entity: "spec",
        id: issue.id,
        action: "updated",
        issue_number: issueNumber,
      },
      {
        entity: "issue",
        id: issue.id,
        action: "updated",
        issue_number: issueNumber,
      },
    );
    return input.comment_ids;
  });

  for (const e of events) ctx.bus.publish(project.id, e);
  return { resolved };
}

export async function listSpecComments(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
): Promise<SpecComments> {
  const { project, role } = await projectForRead(ctx, actor, slug);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(
    db,
    project.id,
    issueNumber,
    actor,
    role,
    assertIssueReadable,
  );

  const current = await currentVersionRow(db, issue.id);
  if (!current) throw new NotFoundError("this issue has no spec");
  const currentFiles = new Map(
    (await filesOfVersion(db, current.id)).map((f) => [f.path, f.body]),
  );

  const rows = (
    await db
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, issue.id), isNotNull(comments.component)))
      .orderBy(asc(comments.createdAt), asc(comments.id))
  ).filter((row) => row.component?.type === "spec_comment");

  const refIds = rows.flatMap((r) =>
    r.resolvedBy === null ? [r.authorId] : [r.authorId, r.resolvedBy],
  );
  const refs = await getUserRefs(ctx.router.system(), refIds);
  const oldBodies = new Map<string, string>(); // `${version}:${path}` → body

  const items: SpecCommentItem[] = [];
  for (const row of rows) {
    if (row.component?.type !== "spec_comment") continue;
    // Anchors stored before T-142 have no column keys at all — the JSONB is
    // whatever was written that day, and drizzle casts rather than parses.
    // Normalizing here is what makes every response carry the same shape.
    const stored = row.component.anchor;
    const anchor: SpecCommentAnchor = {
      ...stored,
      col_start: stored.col_start ?? null,
      col_end: stored.col_end ?? null,
    };
    const author = refs.get(row.authorId);
    if (!author) throw new Error("author ref missing");

    let outdated = true;
    let mapped: { start: number | null; end: number | null } = {
      start: null,
      end: null,
    };
    const currentBody = currentFiles.get(anchor.path);
    if (currentBody !== undefined) {
      if (anchor.line_start === null || anchor.line_end === null) {
        // File-level comments (T-61) stay live as long as the file exists;
        // there are no lines to remap or to outdate.
        outdated = false;
      } else if (anchor.version === current.number) {
        outdated = false;
        mapped = { start: anchor.line_start, end: anchor.line_end };
      } else {
        const key = `${anchor.version}:${anchor.path}`;
        let oldBody = oldBodies.get(key);
        if (oldBody === undefined) {
          const versionRow = await versionByNumber(
            db,
            issue.id,
            anchor.version,
          );
          oldBody = versionRow
            ? (await filesOfVersion(db, versionRow.id)).find(
                (f) => f.path === anchor.path,
              )?.body
            : undefined;
          if (oldBody !== undefined) oldBodies.set(key, oldBody);
        }
        if (oldBody !== undefined) {
          const result = remapLineRange(
            oldBody,
            currentBody,
            anchor.line_start,
            anchor.line_end,
          );
          outdated = result.outdated;
          mapped = { start: result.start, end: result.end };
        }
      }
    }

    let resolved: SpecCommentItem["resolved"] = null;
    if (row.resolvedAt !== null && row.resolvedBy !== null) {
      const by = refs.get(row.resolvedBy);
      if (!by) throw new Error("resolver ref missing");
      resolved = { by, at: row.resolvedAt.toISOString() };
    }

    items.push({
      comment_id: row.id,
      author,
      created_at: row.createdAt.toISOString(),
      body: row.body,
      anchor,
      resolved,
      outdated,
      current_line_start: mapped.start,
      current_line_end: mapped.end,
    });
  }

  return { current_version: current.number, items };
}
