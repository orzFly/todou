import type {
  AgentContext,
  AutolinkRule,
  PrefixDirectory,
} from "@todou/shared";
import { scanReferenceTokens } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  autolinks,
  comments,
  issueEvents,
  issues,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";
import { getProjectBySlug, projectRoleOf, routeInfoOf } from "./access.ts";
import {
  crossRefsSince,
  globalPrefixDirectory,
} from "./reference-directory.ts";
import { refPrefixAt, stripMarkdownCode } from "./references.ts";

/** Everything the grammar needs beyond the text itself, loaded once per write. */
export type ReferenceInputs = {
  since: string | null;
  directory: PrefixDirectory;
  slugs: string[];
  autolinks: AutolinkRule[];
};

export type CrossTarget = { slug: string; number: number };

export type AnalyzedRefs = {
  /** Issue numbers in the source project, self-reference already dropped. */
  local: number[];
  cross: CrossTarget[];
};

export type CrossSource = {
  issueNumber: number;
  commentId?: number;
};

/**
 * Cross-project inputs come from the system database, which a project
 * transaction has no business holding a second connection for — load them
 * before the write opens.
 */
export async function loadReferenceInputs(
  ctx: AppContext,
  db: Db,
  projectId: number,
): Promise<ReferenceInputs> {
  const system = ctx.router.system();
  const [since, slugRows, links, mirror] = await Promise.all([
    crossRefsSince(system),
    system.select({ slug: projects.slug }).from(projects),
    db
      .select({ prefix: autolinks.prefix, urlTemplate: autolinks.urlTemplate })
      .from(autolinks)
      .where(eq(autolinks.projectId, projectId)),
    globalPrefixDirectory(ctx),
  ]);
  return {
    since,
    directory: mirror,
    slugs: slugRows.map((row) => row.slug),
    autolinks: links.map((row) => ({
      prefix: row.prefix,
      url_template: row.urlTemplate,
    })),
  };
}

/**
 * Split a body's references into this project's issues and other projects'.
 * A qualified form naming this project is local — the spelling is a way to
 * be explicit, not a way to reference yourself from outside.
 */
export async function analyzeReferences(
  db: Db,
  inputs: ReferenceInputs,
  project: { id: number; slug: string },
  text: string,
  contentCreatedAt: Date,
  source: CrossSource,
): Promise<AnalyzedRefs> {
  const prefix = await refPrefixAt(db, project.id, contentCreatedAt);
  const tokens = scanReferenceTokens(stripMarkdownCode(text), {
    internalPrefix: prefix,
    autolinks: inputs.autolinks,
    cross: {
      slugs: inputs.slugs,
      directory: inputs.directory,
      since: inputs.since,
      at: contentCreatedAt.toISOString(),
    },
  });

  const local = new Set<number>();
  const cross = new Map<string, CrossTarget>();
  const commentIds = new Set<number>();
  for (const token of tokens) {
    if (token.type === "comment") {
      commentIds.add(token.commentId);
    } else if (token.type === "issue") {
      if (token.slug === null || token.slug === project.slug) {
        local.add(token.number);
      } else {
        cross.set(`${token.slug}#${token.number}`, {
          slug: token.slug,
          number: token.number,
        });
      }
    }
  }
  for (const number of await issuesOfComments(db, project.id, commentIds)) {
    local.add(number);
  }
  local.delete(source.issueNumber);
  return { local: [...local], cross: [...cross.values()] };
}

/** A bare `#comment-M` references whatever issue the comment lives on. */
async function issuesOfComments(
  db: Db,
  projectId: number,
  ids: Set<number>,
): Promise<number[]> {
  if (ids.size === 0) return [];
  const rows = await db
    .select({ number: issues.number })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(
      and(eq(comments.projectId, projectId), inArray(comments.id, [...ids])),
    );
  return rows.map((row) => row.number);
}

/**
 * Land `cross_referenced` events on the targets, after the source write has
 * committed — the target lives in another database, so it can never join
 * that transaction. Best-effort by consequence: a target that fails costs
 * one timeline entry, never the content that mentioned it, and the next
 * edit replays the whole set.
 */
export async function recordCrossReferences(
  ctx: AppContext,
  actor: UserRow,
  sourceProject: { slug: string },
  source: CrossSource,
  targets: CrossTarget[],
  agentContext: AgentContext | null = null,
): Promise<void> {
  const bySlug = new Map<string, number[]>();
  for (const target of targets) {
    bySlug.set(target.slug, [
      ...(bySlug.get(target.slug) ?? []),
      target.number,
    ]);
  }
  for (const [slug, numbers] of bySlug) {
    try {
      await recordInProject(
        ctx,
        actor,
        sourceProject,
        source,
        slug,
        numbers,
        agentContext,
      );
    } catch (err) {
      if (err instanceof NotFoundError) continue;
      console.error(`cross-reference into "${slug}" failed`, err);
    }
  }
}

async function recordInProject(
  ctx: AppContext,
  actor: UserRow,
  sourceProject: { slug: string },
  source: CrossSource,
  slug: string,
  numbers: number[],
  agentContext: AgentContext | null,
): Promise<void> {
  const target = await getProjectBySlug(ctx, slug);
  // The author gate: nobody writes into a project they cannot read, so a
  // reference can neither spam a stranger's timeline nor probe whether a
  // project exists.
  if ((await projectRoleOf(ctx, target, actor)) === null) return;

  const db = await ctx.router.forProject(routeInfoOf(target));
  const rows = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(
      and(eq(issues.projectId, target.id), inArray(issues.number, numbers)),
    );
  if (rows.length === 0) return;

  const existing = await db
    .select({ issueId: issueEvents.issueId, payload: issueEvents.payload })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, target.id),
        eq(issueEvents.type, "cross_referenced"),
        inArray(
          issueEvents.issueId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const seen = new Set(
    existing.map((row) => {
      const payload = row.payload as { by_project?: string; by_issue?: number };
      return `${row.issueId}:${payload.by_project}:${payload.by_issue}`;
    }),
  );

  for (const row of rows) {
    const key = `${row.id}:${sourceProject.slug}:${source.issueNumber}`;
    if (seen.has(key)) continue;
    const inserted = await db
      .insert(issueEvents)
      .values({
        projectId: target.id,
        issueId: row.id,
        actorId: actor.id,
        type: "cross_referenced",
        agentContext,
        payload: {
          by_project: sourceProject.slug,
          by_issue: source.issueNumber,
          ...(source.commentId === undefined
            ? {}
            : { by_comment: source.commentId }),
        },
      })
      .returning({ id: issueEvents.id });
    const id = inserted[0]?.id;
    if (id !== undefined) {
      ctx.bus.publish(target.id, {
        entity: "timeline",
        id,
        action: "created",
        issue_number: row.number,
      });
    }
  }
}
