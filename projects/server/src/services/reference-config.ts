import type {
  Autolink,
  AutolinkCreateInput,
  ReferenceConfig,
  RefFormatSetInput,
} from "@todou/shared";
import { refToken } from "@todou/shared";
import { and, asc, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { autolinks, refFormats } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";

/** GitHub's autolink rule: no prefix may be a prefix of another. */
function overlaps(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

async function loadConfig(db: Db, projectId: number): Promise<ReferenceConfig> {
  const history = await db
    .select()
    .from(refFormats)
    .where(eq(refFormats.projectId, projectId))
    .orderBy(asc(refFormats.effectiveFrom), asc(refFormats.id));
  const links = await db
    .select()
    .from(autolinks)
    .where(eq(autolinks.projectId, projectId))
    .orderBy(asc(autolinks.id));
  return {
    format: {
      prefix: history.at(-1)?.prefix ?? null,
      history: history.map((row) => ({
        prefix: row.prefix,
        effective_from: row.effectiveFrom.toISOString(),
      })),
    },
    autolinks: links.map(toAutolink),
  };
}

function toAutolink(row: typeof autolinks.$inferSelect): Autolink {
  return { id: row.id, prefix: row.prefix, url_template: row.urlTemplate };
}

export async function getReferenceConfig(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<ReferenceConfig> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  return loadConfig(db, project.id);
}

export async function setReferenceFormat(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: RefFormatSetInput,
): Promise<ReferenceConfig> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const config = await loadConfig(db, project.id);
  // Same format again: no history row, or every no-op PUT would move the
  // cutoff boundary for content written since the real switch.
  if (input.prefix === config.format.prefix) return config;
  const token = refToken(input.prefix);
  const clash = config.autolinks.find((a) => overlaps(a.prefix, token));
  if (clash) {
    throw new ValidationFailedError(
      `internal format token "${token}" overlaps autolink prefix "${clash.prefix}"`,
    );
  }
  await db
    .insert(refFormats)
    .values({ projectId: project.id, prefix: input.prefix });
  return loadConfig(db, project.id);
}

export async function createAutolink(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: AutolinkCreateInput,
): Promise<Autolink> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const config = await loadConfig(db, project.id);
  // Only the CURRENT internal token is protected — overlapping a
  // historical one is the whole point of handing "#" to an external
  // tracker after switching to a prefixed format.
  const token = refToken(config.format.prefix);
  if (overlaps(input.prefix, token)) {
    throw new ValidationFailedError(
      `autolink prefix "${input.prefix}" overlaps internal format token "${token}"`,
    );
  }
  const clash = config.autolinks.find((a) => overlaps(a.prefix, input.prefix));
  if (clash) {
    throw new ValidationFailedError(
      `autolink prefix "${input.prefix}" overlaps existing autolink prefix "${clash.prefix}"`,
    );
  }
  const inserted = await db
    .insert(autolinks)
    .values({
      projectId: project.id,
      prefix: input.prefix,
      urlTemplate: input.url_template,
    })
    .returning();
  return toAutolink(inserted[0] as typeof autolinks.$inferSelect);
}

export async function deleteAutolink(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  autolinkId: number,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const deleted = await db
    .delete(autolinks)
    .where(
      and(eq(autolinks.projectId, project.id), eq(autolinks.id, autolinkId)),
    )
    .returning({ id: autolinks.id });
  if (deleted.length === 0) throw new NotFoundError("autolink not found");
}
