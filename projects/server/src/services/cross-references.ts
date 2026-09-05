import type { AutolinkRule, PrefixDirectory, SlugClaim } from "@todou/shared";
import { and, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext, DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { autolinks, issueEvents } from "../db/project-schema.ts";
import { projects, slugHistory } from "../db/system-schema.ts";
import { accessibleProjectRows } from "./access.ts";
import {
  globalPrefixDirectory,
  globalSlugEntries,
} from "./reference-directory.ts";

/**
 * Hide a reference event whose referring project the viewer cannot read. A
 * dangling "referenced by somewhere you may not go" is worse than silence and
 * leaks that the project exists at all. It has to be a SQL predicate: the
 * timeline counts and paginates over these tables, so dropping rows
 * afterwards would break both.
 *
 * One rule since T-266, judged on the project the reference was written in.
 * The alternative — judging by where the referring card lives now — would
 * take a cross-database join or a post-filter that breaks pagination, and it
 * would protect nothing: the link is in the stored text, which every reader
 * of this card can already see. This is exactly as strict as the text.
 *
 * `by_issue` alone, with no project named, is a local reference written
 * before the two event types merged. Those are visible by construction —
 * the reader is already reading this project.
 *
 * The two project spellings are exclusive rather than alternatives. Falling
 * back to the slug for a row that HAS an id would keep the T-156 limitation
 * alive — a slug that changed hands makes its old holder's events visible to
 * the new one. Judged on the id, that cannot happen. `refs migrate` gives
 * every row an id, after which the slug arm is dead weight to be retired.
 */
export function crossRefVisibleCondition(
  visibleSlugs: string[],
  visibleIds: Iterable<number> = [],
): SQL {
  const notReference = and(
    ne(issueEvents.type, "cross_referenced"),
    ne(issueEvents.type, "referenced"),
  ) as SQL;
  const namesNoProject = sql`not (${issueEvents.payload} ?| array['by_project', 'by_project_id'])`;
  const ids = [...visibleIds];
  if (visibleSlugs.length === 0 && ids.length === 0) {
    return or(notReference, namesNoProject) as SQL;
  }
  const bySlug = sql<string>`${issueEvents.payload} ->> 'by_project'`;
  const byId = sql<number>`(${issueEvents.payload} ->> 'by_project_id')::bigint`;
  const source = sql`case when ${issueEvents.payload} ? 'by_project_id'
      then ${ids.length === 0 ? sql`false` : inArray(byId, ids)}
      else ${visibleSlugs.length === 0 ? sql`false` : inArray(bySlug, visibleSlugs)}
    end`;
  return or(notReference, namesNoProject, source) as SQL;
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
