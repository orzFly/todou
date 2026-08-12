import type {
  AgentContext,
  ChangeEvent,
  SpecFiles,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
} from "@todou/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  issueEvents,
  issues,
  specVersionFiles,
  specVersions,
} from "../db/project-schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
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

    // Denormalized spec state (#23): a new version always resets the
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
