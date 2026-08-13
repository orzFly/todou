import type {
  AgentContext,
  ChangeEvent,
  SpecCommentAnchor,
  SpecCommentItem,
  SpecComments,
  SpecCommentsResolveInput,
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
import { requireProject, routeInfoOf } from "./access.ts";
import { getUserRefs } from "./users.ts";

async function loadIssue(db: Db, projectId: number, number: number) {
  const rows = await db
    .select({
      id: issues.id,
      specVersion: issues.specVersion,
      specReviewStatus: issues.specReviewStatus,
      specUnresolvedComments: issues.specUnresolvedComments,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
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

const utf8Size = (body: string) => Buffer.byteLength(body, "utf8");

export async function pushSpec(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  input: SpecPushInput,
  agentContext: AgentContext | null = null,
): Promise<SpecPushResult> {
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

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
    const after = new Map(input.files.map((f) => [f.path, f.body]));
    const added = [...after.keys()].filter((p) => !before.has(p)).sort();
    const removed = [...before.keys()].filter((p) => !after.has(p)).sort();
    const changed = [...after.keys()]
      .filter((p) => before.has(p) && before.get(p) !== after.get(p))
      .sort();

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return {
        unchanged: true,
        version: currentNumber,
        added,
        changed,
        removed,
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
      input.files.map((f) => ({
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
      .returning();
    const event = eventRows[0];
    if (!event) throw new Error("event insert returned no row");

    // Denormalized spec state (T-23): a new version always resets the
    // review verdict — approvals never carry across pushes.
    await tx
      .update(issues)
      .set({ specVersion: version.number, specReviewStatus: "unreviewed" })
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
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

  const versionRows = await db
    .select()
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
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

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

function quoteLines(body: string, start: number, end: number): string {
  const quote = body
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
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
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

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
      if (lineStart !== null && lineEnd !== null) {
        const lineCount = body.split("\n").length;
        if (lineEnd > lineCount) {
          throw new ValidationFailedError(
            `anchor ${comment.anchor.path}:${lineStart}-${lineEnd} exceeds the file (${lineCount} lines in v${comment.anchor.version})`,
          );
        }
      }
      anchored.push({
        anchor: {
          path: comment.anchor.path,
          version: comment.anchor.version,
          line_start: lineStart,
          line_end: lineEnd,
          quote:
            lineStart !== null && lineEnd !== null
              ? quoteLines(body, lineStart, lineEnd)
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
  const { project } = await requireProject(ctx, actor, slug, "writer");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

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
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issue = await loadIssue(db, project.id, issueNumber);

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
    const anchor = row.component.anchor;
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
