import type {
  AgentContext,
  AutolinkRule,
  PrefixDirectory,
  ScanConfig,
  SlugClaim,
} from "@todou/shared";
import { scanReferenceTokens } from "@todou/shared";
import { and, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext, DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  autolinks,
  comments,
  issueEvents,
  issues,
} from "../db/project-schema.ts";
import { projects, slugHistory } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";
import {
  accessibleProjectRows,
  getProjectBySlug,
  projectRoleOf,
  routeInfoOf,
} from "./access.ts";
import {
  globalPrefixDirectory,
  globalSlugEntries,
} from "./reference-directory.ts";
import { refPrefixAt, stripMarkdownCode } from "./references.ts";
import { referenceable } from "./trash.ts";

/**
 * Hide `cross_referenced` events whose source project the viewer cannot
 * read. A dangling "referenced by somewhere you may not go" is worse than
 * silence and leaks that the project exists at all. It has to be a SQL
 * predicate: the timeline counts and paginates over these tables, so
 * dropping rows afterwards would break both.
 *
 * The two spellings are exclusive rather than alternatives. Falling back to
 * the slug for a row that HAS an id would keep the T-156 limitation alive
 * for new events — a slug that changed hands makes its old holder's events
 * visible to the new one. Judged on the id, that cannot happen.
 *
 * Rows a move rewrote pass regardless: they were visible before the move, so
 * hiding them now would delete a line from a reader's history over a change
 * to a card they may not even be able to see. Their far side is blanked in
 * post-processing instead (`redactMovePayloads`).
 */
export function crossRefVisibleCondition(
  visibleSlugs: string[],
  visibleIds: Iterable<number> = [],
): SQL {
  const notCross = ne(issueEvents.type, "cross_referenced");
  const rewrittenByMove = sql`${issueEvents.payload} ? 'by_moved'`;
  const ids = [...visibleIds];
  if (visibleSlugs.length === 0 && ids.length === 0) {
    return or(notCross, rewrittenByMove) as SQL;
  }
  const bySlug = sql<string>`${issueEvents.payload} ->> 'by_project'`;
  const byId = sql<number>`(${issueEvents.payload} ->> 'by_project_id')::bigint`;
  const source = sql`case when ${issueEvents.payload} ? 'by_project_id'
      then ${ids.length === 0 ? sql`false` : inArray(byId, ids)}
      else ${visibleSlugs.length === 0 ? sql`false` : inArray(bySlug, visibleSlugs)}
    end`;
  return or(notCross, rewrittenByMove, source) as SQL;
}

/**
 * The slugs a `cross_referenced` event's `by_project` may match for this
 * viewer: the projects they can read, spelled every way those projects have
 * ever been spelled. Without the history, renaming a project would hide
 * every reference it made before the rename (T-156).
 *
 * Known limitation: after a slug changes hands, the old holder's events
 * stay visible to the new holder's members. The predicate cannot narrow by
 * event time without a per-row join, and what leaks is one line saying some
 * project once referenced you.
 */
export async function visibleSlugsWithHistory(
  ctx: AppContext,
  user: UserRow,
): Promise<string[]> {
  return (await visibleProjects(ctx, user)).slugs;
}

/**
 * The readable projects named both ways at once: by every slug they have
 * ever held (what the visibility predicate matches on) and by id (what
 * redaction and the newer `by_project_id` payloads compare against). One
 * `accessibleProjectRows` walk serves both — they are the same question.
 */
export type VisibleProjects = { slugs: string[]; ids: Set<number> };

export async function visibleProjects(
  ctx: AppContext,
  user: UserRow,
): Promise<VisibleProjects> {
  const rows = await accessibleProjectRows(ctx, user);
  const ids = new Set(rows.map((row) => row.id));
  if (rows.length === 0) return { slugs: [], ids };
  const slugs = new Set(rows.map((row) => row.slug));
  const history = await ctx.router
    .system()
    .select({ slug: slugHistory.slug })
    .from(slugHistory)
    .where(
      inArray(
        slugHistory.projectId,
        rows.map((row) => row.id),
      ),
    );
  for (const row of history) slugs.add(row.slug);
  return { slugs: [...slugs], ids };
}

/** Everything the grammar needs beyond the text itself, loaded once per write. */
export type ReferenceInputs = {
  directory: PrefixDirectory;
  slugs: string[];
  slugEntries: SlugClaim[];
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
  ctx: DbContext,
  db: Db,
  projectId: number,
): Promise<ReferenceInputs> {
  const system = ctx.router.system();
  const [slugRows, links, mirror, slugEntries] = await Promise.all([
    system.select({ slug: projects.slug }).from(projects),
    db
      .select({ prefix: autolinks.prefix, urlTemplate: autolinks.urlTemplate })
      .from(autolinks)
      .where(eq(autolinks.projectId, projectId)),
    globalPrefixDirectory(ctx),
    globalSlugEntries(ctx),
  ]);
  return {
    directory: mirror,
    slugs: slugRows.map((row) => row.slug),
    slugEntries,
    autolinks: links.map((row) => ({
      prefix: row.prefix,
      url_template: row.urlTemplate,
    })),
  };
}

/** The grammar as one project's numbering saw it at one instant. */
function anchorConfig(
  inputs: ReferenceInputs,
  internalPrefix: string | null,
  at: Date,
): ScanConfig {
  return {
    internalPrefix,
    autolinks: inputs.autolinks,
    cross: {
      slugs: inputs.slugs,
      directory: inputs.directory,
      slugEntries: inputs.slugEntries,
      at: at.toISOString(),
    },
  };
}

/**
 * Which project's numbering an edit of stored text is read under.
 *
 * A move respells the card's own references into project-qualified forms
 * (T-247), so text it rewrote holds no bare `#12` meaning the origin any
 * more — and once that is true, a `#12` the author types now has to mean a
 * card HERE, which is what anyone editing at the new address expects. Text
 * the respell could not safely rewrite still carries origin-local spellings,
 * and those keep the old anchor: reading them under the current project would
 * silently repoint them at a real, unrelated card.
 *
 * Judged on the stored text rather than on a flag, so the two halves cannot
 * disagree: whatever the rewrite achieved is what this reads.
 */
export async function editAnchorFor(
  db: Db,
  inputs: ReferenceInputs,
  project: { id: number; slug: string },
  origin: { id: number; slug: string },
  storedText: string,
  contentCreatedAt: Date,
): Promise<{ id: number; slug: string }> {
  if (origin.id === project.id) return project;
  const tokens = scanReferenceTokens(
    stripMarkdownCode(storedText),
    anchorConfig(
      inputs,
      await refPrefixAt(db, origin.id, contentCreatedAt),
      contentCreatedAt,
    ),
  );
  const originLocal = tokens.some(
    (token) => token.type === "issue" && token.slug === null,
  );
  return originLocal ? origin : project;
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
  /**
   * The project this text was WRITTEN in, which is not the current one once
   * the card has moved (T-231). A bare `#12` typed in A means A/12 forever;
   * reading it under the destination's numbering would silently point it at
   * a different, existing card — an error no redirect can undo. Defaults to
   * the current project, which is every case but an edit of moved text.
   */
  origin: { id: number; slug: string } = project,
): Promise<AnalyzedRefs> {
  const tokens = scanReferenceTokens(
    stripMarkdownCode(text),
    anchorConfig(
      inputs,
      await refPrefixAt(db, origin.id, contentCreatedAt),
      contentCreatedAt,
    ),
  );

  const local = new Set<number>();
  const cross = new Map<string, CrossTarget>();
  const commentIds = new Set<number>();
  for (const token of tokens) {
    if (token.type === "comment") {
      commentIds.add(token.commentId);
    } else if (token.type === "issue") {
      // An unqualified ref means "this project" as of when it was written,
      // so it resolves against the origin. Once that is no longer the
      // current project the very same text denotes a cross-project target.
      const slug = token.slug ?? origin.slug;
      if (slug === project.slug) {
        local.add(token.number);
      } else {
        cross.set(`${slug}#${token.number}`, { slug, number: token.number });
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
      and(
        eq(comments.projectId, projectId),
        inArray(comments.id, [...ids]),
        referenceable,
      ),
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
  sourceProject: { id: number; slug: string },
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
  sourceProject: { id: number; slug: string },
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
      and(
        eq(issues.projectId, target.id),
        inArray(issues.number, numbers),
        referenceable,
      ),
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
  // Keyed both ways on purpose. Events written before `by_project_id`
  // existed carry only a slug, so an id-only key would never match them —
  // and `recordCrossReferences` replays the whole set on every edit, so each
  // edit of the source would add a duplicate event to every card it names.
  const seen = new Set<string>();
  for (const row of existing) {
    const payload = row.payload as {
      by_project?: string;
      by_project_id?: number;
      by_issue?: number;
    };
    if (payload.by_project !== undefined) {
      seen.add(`${row.issueId}:slug:${payload.by_project}:${payload.by_issue}`);
    }
    if (payload.by_project_id !== undefined) {
      seen.add(
        `${row.issueId}:id:${payload.by_project_id}:${payload.by_issue}`,
      );
    }
  }

  for (const row of rows) {
    const bySlug = `${row.id}:slug:${sourceProject.slug}:${source.issueNumber}`;
    const byId = `${row.id}:id:${sourceProject.id}:${source.issueNumber}`;
    if (seen.has(bySlug) || seen.has(byId)) continue;
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
          // The slug stays for older clients and plain-text output; the id is
          // what anything resolving the source should prefer, because a slug
          // has to be read as of the event's own instant and a slug that has
          // changed hands makes that answer a guess.
          by_project_id: sourceProject.id,
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
