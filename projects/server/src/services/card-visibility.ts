import { cardScoped, type MemberRole } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { issues } from "../db/project-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";

/**
 * Which of `project`'s cards `actor` may read, as a predicate over card
 * numbers (T-788). Every card, for any role but a card-scoped one; for that
 * one, the cards it opened — read in one query, because a guest's own cards
 * are few and a page asks about many numbers.
 */
export async function cardVisibility(
  ctx: AppContext,
  actor: UserRow,
  role: MemberRole | null,
  project: ProjectRow,
): Promise<(number: number) => boolean> {
  if (role === null) return () => false;
  if (!cardScoped(role)) return () => true;
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select({ number: issues.number })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.authorId, actor.id)),
    );
  const own = new Set(rows.map((row) => row.number));
  return (number) => own.has(number);
}
