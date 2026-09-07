/**
 * Resolve one `PREFIX-N` for a client that cannot (T-288).
 *
 * The prefix namespace is deployment-wide, but the directory a client is
 * given is trimmed to the projects it may read — so a prefix held by a
 * project it cannot read resolves in prose and refuses as an argument, which
 * is the same token getting two answers. This closes that by answering the
 * question the resolve pass answers, with the resolve pass's own functions:
 * the global directory decides the holder, the address book decides the
 * address, and read access is asked about wherever the card landed.
 *
 * Everything it cannot tell the caller is one 404, deliberately: the resolve
 * pass leaves such a token as literal text and records nothing, so every
 * distinction drawn here would be a distinction the other path does not
 * make — and an oracle for probing projects nobody may read.
 */

import { parseRefLocator, type ResolvedRef, resolveClaim } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { issues } from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import {
  findProjectByRef,
  type ProjectRow,
  projectRoleOf,
  routeInfoOf,
} from "./access.ts";
import { globalPrefixDirectory } from "./reference-directory.ts";
import { cardAddressFor } from "./resolve-pass.ts";
import { live } from "./trash.ts";

export async function resolveRefLocator(
  ctx: AppContext,
  actor: UserRow,
  ref: string,
): Promise<ResolvedRef> {
  const locator = parseRefLocator(ref);
  if (locator === null || locator.kind !== "prefixed") {
    // The qualified forms name their project outright and `N` / `#N` name
    // the current one, so none of them has a prefix left to resolve. A
    // branch for them would be a second judgement with no caller.
    throw new ValidationFailedError(
      `"${ref}" is not a bare prefixed ref like "T-16"`,
    );
  }
  const directory = await globalPrefixDirectory(ctx);
  const holder = resolveClaim(
    directory.entries,
    directory.contested,
    locator.prefix,
    new Date().toISOString(),
  );
  if (holder === null) throw new NotFoundError();
  const named = (await findProjectByRef(ctx, holder))?.project;
  if (named === undefined) throw new NotFoundError();

  const found = await cardAddressFor(
    {
      system: ctx.router.system(),
      projectById: async (id) =>
        (await findProjectByRef(ctx, String(id)))?.project ?? null,
      mayRead: async (project) =>
        (await projectRoleOf(ctx, project, actor)) !== null,
      cardLive: (project, number) => cardLive(ctx, project, number),
    },
    named,
    locator.number,
  );
  if (found === null) throw new NotFoundError();
  return {
    names: { project_ref: String(named.id), number: locator.number },
    at: { slug: found.target.slug, number: found.address.number },
  };
}

/**
 * `live` rather than the resolve pass's `referenceable`: this is a read, and
 * a card mid-move is readable — refusing it would be a rule this path
 * invented. The two predicates differ in nothing else, so the answers still
 * agree everywhere a new reference could have been written.
 */
async function cardLive(
  ctx: AppContext,
  project: ProjectRow,
  number: number,
): Promise<boolean> {
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.number, number), live),
    );
  return rows.length > 0;
}
