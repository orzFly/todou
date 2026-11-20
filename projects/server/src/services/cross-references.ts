import type { AutolinkRule, PrefixDirectory, SlugClaim } from "@todou/shared";
import {
  and,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext, DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { autolinks, issueEvents, issues } from "../db/project-schema.ts";
import { projects, slugHistory } from "../db/system-schema.ts";
import {
  type AccessibleProjectRow,
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "./access.ts";
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
 * the new one. Judged on the id, that cannot happen. The `refs migrate` pass
 * gave every row an id on the deployments that ran it; the slug arm stays
 * for the ones that did not, 0.5.1 having been the last release to carry it.
 */
export function crossRefVisibleCondition(
  visibleSlugs: string[],
  visibleIds: Iterable<number> = [],
  /**
   * Projects the viewer sees only through its own cards (T-788), each with
   * the numbers of those cards. A reference written there is visible when
   * the card it was written on is one of them.
   */
  cardScoped: CardScopedProjects = new Map(),
): SQL {
  const notReference = and(
    ne(issueEvents.type, "cross_referenced"),
    ne(issueEvents.type, "referenced"),
  ) as SQL;
  const byIssue = sql`(${issueEvents.payload} ->> 'by_issue')::bigint`;
  const byOwnCard = (numbers: ReadonlySet<number>): SQL =>
    numbers.size === 0 ? sql`false` : inArray(byIssue, [...numbers]);
  let namesNoProject: SQL = sql`not (${issueEvents.payload} ?| array['by_project', 'by_project_id'])`;
  if (cardScoped.size > 0) {
    // A pre-merge local reference names no project: it was written in the
    // project the event lives in, which a card-scoped viewer still has to
    // be asked about.
    namesNoProject = and(
      namesNoProject,
      or(
        notInArray(issueEvents.projectId, [...cardScoped.keys()]),
        ...[...cardScoped].map(([projectId, numbers]) =>
          and(eq(issueEvents.projectId, projectId), byOwnCard(numbers)),
        ),
      ),
    ) as SQL;
  }
  const ids = [...visibleIds];
  if (visibleSlugs.length === 0 && ids.length === 0 && cardScoped.size === 0) {
    return or(notReference, namesNoProject) as SQL;
  }
  const bySlug = sql<string>`${issueEvents.payload} ->> 'by_project'`;
  const byId = sql<number>`(${issueEvents.payload} ->> 'by_project_id')::bigint`;
  const byIdVisible = or(
    ids.length === 0 ? sql`false` : inArray(byId, ids),
    ...[...cardScoped].map(([projectId, numbers]) =>
      and(eq(byId, projectId), byOwnCard(numbers)),
    ),
  );
  const source = sql`case when ${issueEvents.payload} ? 'by_project_id'
      then ${byIdVisible}
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
 * The readable projects named three ways at once: by every slug they have
 * ever held (what the visibility predicate matches on), by id (what
 * redaction compares against), and by each id's current slug (what read-time
 * payload enrichment returns). One `accessibleProjectRows` walk serves all
 * three — they are the same question.
 */
export type VisibleProjects = {
  slugs: string[];
  /**
   * Projects whose every card the viewer may read. A card-scoped project
   * (T-788) is deliberately absent, so that whatever asks only this set
   * treats it as unreadable; `cardScoped` is the narrower answer.
   */
  ids: Set<number>;
  /** Every readable project's current slug, card-scoped ones included. */
  currentSlugs: Map<number, string>;
  cardScoped?: CardScopedProjects;
};

/** Project id → numbers of the cards the viewer opened there. */
export type CardScopedProjects = ReadonlyMap<number, ReadonlySet<number>>;

/** Whether `visible` lets the viewer read card `number` of `projectId`. */
export function cardVisibleIn(
  visible: VisibleProjects,
  projectId: number,
  number: number,
): boolean {
  if (visible.ids.has(projectId)) return true;
  return visible.cardScoped?.get(projectId)?.has(number) ?? false;
}

export async function visibleProjects(
  ctx: AppContext,
  user: UserRow,
): Promise<VisibleProjects> {
  return visibleProjectsOf(
    ctx,
    await accessibleProjectRows(ctx, user, { cardScoped: "filter" }),
    user,
  );
}

/** The same, for a caller already holding the `accessibleProjectRows` walk. */
export async function visibleProjectsOf(
  ctx: AppContext,
  rows: AccessibleProjectRow[],
  user: UserRow,
): Promise<VisibleProjects> {
  const full = rows.filter((row) => !row.cardScoped);
  const ids = new Set(full.map((row) => row.id));
  const currentSlugs = new Map(rows.map((row) => [row.id, row.slug]));
  const cardScoped = await ownCardNumbers(
    ctx,
    rows.filter((row) => row.cardScoped),
    user,
  );
  // Left off when empty, so that a viewer with no such project gets exactly
  // the shape it always did.
  const scoped = cardScoped.size === 0 ? {} : { cardScoped };
  if (full.length === 0) return { slugs: [], ids, currentSlugs, ...scoped };
  const slugs = new Set(full.map((row) => row.slug));
  const history = await ctx.router
    .system()
    .select({ slug: slugHistory.slug })
    .from(slugHistory)
    .where(
      inArray(
        slugHistory.projectId,
        full.map((row) => row.id),
      ),
    );
  for (const row of history) slugs.add(row.slug);
  return { slugs: [...slugs], ids, currentSlugs, ...scoped };
}

async function ownCardNumbers(
  ctx: AppContext,
  rows: ProjectRow[],
  user: UserRow,
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>(
    rows.map((row) => [row.id, new Set()]),
  );
  if (rows.length === 0) return out;
  const found = await ctx.router.perDatabase(
    rows,
    routeInfoOf,
    async (db, group) =>
      db
        .select({ projectId: issues.projectId, number: issues.number })
        .from(issues)
        .where(
          and(
            inArray(
              issues.projectId,
              group.map((row) => row.id),
            ),
            eq(issues.authorId, user.id),
          ),
        ),
  );
  for (const row of found.flat()) out.get(row.projectId)?.add(row.number);
  return out;
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
