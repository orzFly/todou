import {
  parseRefLocator,
  type ReferenceDirectory,
  resolveClaim,
  resolveSlugAt,
} from "@todou/shared";

/**
 * Which project the `target` of a `/grant-access` link names (T-280).
 *
 * The whole resolution happens here, in the browser, with the viewer's own
 * documents — so the page adds no way to learn that a project exists: every
 * answer it can reach, the viewer could already have read off
 * `GET /projects` and `GET /me/reference-directory`. A target naming a
 * project outside that reach comes back `none`, exactly as a target naming
 * nothing at all does.
 *
 * Shaped after `ref-jump.ts`'s `projectAt`, and resolving with the same two
 * shared functions, so a link and a pasted reference cannot disagree about
 * what a spelling means. Pure, so the matrix of spellings is testable.
 */

export type GrantTargetContext = {
  /** Every project the viewer may read. */
  projects: readonly { id: number; slug: string }[];
  /** Null = the cross-project grammar stays shut, as elsewhere. */
  directory: ReferenceDirectory | null;
  /** Test seam; production resolves as of now. */
  at?: string;
};

export type GrantTarget =
  | { kind: "one"; slug: string }
  /** Several readable projects answer to this spelling; the opener picks. */
  | { kind: "several"; slugs: string[] }
  /** Nothing readable answers to it — which is all this page may say. */
  | { kind: "none" };

export function resolveGrantTarget(
  target: string,
  ctx: GrantTargetContext,
): GrantTarget {
  const readable = new Set(ctx.projects.map((p) => p.slug));
  const found = candidatesFor(target.trim(), ctx).filter((slug) =>
    readable.has(slug),
  );
  const slugs = [...new Set(found)];
  if (slugs.length === 0) return { kind: "none" };
  if (slugs.length === 1) return { kind: "one", slug: slugs[0] as string };
  return { kind: "several", slugs: slugs.sort() };
}

/**
 * Every project a spelling could mean, before the readable filter. More than
 * one only where the deployment really is ambiguous: a prefix two projects
 * hold at once, or a slug one project holds now and another held before.
 */
function candidatesFor(target: string, ctx: GrantTargetContext): string[] {
  if (target === "") return [];
  const at = ctx.at ?? new Date().toISOString();
  const entries = ctx.directory?.entries ?? [];
  const contested = ctx.directory?.contested ?? [];
  const slugEntries = ctx.directory?.slug_entries ?? [];
  const locator = parseRefLocator(target);

  if (locator?.kind === "prefixed") {
    const sole = resolveClaim(entries, contested, locator.prefix, at);
    if (sole !== null) return [sole];
    // `resolveClaim` refuses a tie rather than guessing. Here a tie is not a
    // dead end: the opener can be shown both and say which they meant.
    return entries
      .filter((e) => e.prefix === locator.prefix && covers(e, at))
      .map((e) => e.slug);
  }

  const slug = locator?.kind === "qualified" ? locator.slug : target;
  const now = resolveSlugAt(slugEntries, [...readableOf(ctx)], slug, at);
  // Anyone who held this slug and does not any more. The live holder resolves
  // above; a rename that handed the slug on leaves both worth offering, and
  // which of the two the link meant depends on when it was written.
  const past = slugEntries
    .filter((e) => e.slug === slug && !covers(e, at))
    .map((e) => e.canonical);
  const byId = ctx.projects
    .filter((p) => /^\d+$/.test(target) && p.id === Number(target))
    .map((p) => p.slug);
  return [...(now === null ? [] : [now]), ...past, ...byId];
}

function readableOf(ctx: GrantTargetContext): string[] {
  return ctx.projects.map((p) => p.slug);
}

/** `[from, to)`, the interval shape the directory hands out. */
function covers(
  claim: { from: string; to: string | null },
  at: string,
): boolean {
  const time = Date.parse(at);
  return (
    Date.parse(claim.from) <= time &&
    (claim.to === null || time < Date.parse(claim.to))
  );
}
