import type { IssueMove } from "@todou/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { comments, issueEvents, issues } from "../db/project-schema.ts";
import { issueAddresses, movedIds, projects } from "../db/system-schema.ts";
import {
  AttachmentMovedError,
  CommentMovedError,
  IssueMovedError,
  NotFoundError,
  type RelocationMarker,
} from "../errors.ts";
import { type ProjectRow, projectRoleOf, routeInfoOf } from "./access.ts";

export type Address = { projectId: number; number: number };
export type AliasKind = "comment" | "attachment";

/** Where the card that once lived at `(projectId, number)` lives now. */
export async function currentAddressOf(
  system: Db,
  projectId: number,
  number: number,
): Promise<Address | null> {
  const rows = await system
    .select({
      currentProjectId: issueAddresses.currentProjectId,
      currentNumber: issueAddresses.currentNumber,
    })
    .from(issueAddresses)
    .where(
      and(
        eq(issueAddresses.projectId, projectId),
        eq(issueAddresses.number, number),
      ),
    );
  const row = rows[0];
  return row === undefined
    ? null
    : { projectId: row.currentProjectId, number: row.currentNumber };
}

/** The card's cross-move identity, if it has ever moved. */
export async function lineageOf(
  system: Db,
  projectId: number,
  number: number,
): Promise<number | null> {
  const rows = await system
    .select({ lineage: issueAddresses.lineage })
    .from(issueAddresses)
    .where(
      and(
        eq(issueAddresses.projectId, projectId),
        eq(issueAddresses.number, number),
      ),
    );
  return rows[0]?.lineage ?? null;
}

/**
 * The number this lineage's tombstone still holds in `projectId`, so a card
 * moving back takes its old number instead of a fresh one. Single-valued
 * because `(lineage, project_id)` is unique.
 */
export async function tombstoneNumberOf(
  system: Db,
  lineage: number,
  projectId: number,
): Promise<number | null> {
  const rows = await system
    .select({ number: issueAddresses.number })
    .from(issueAddresses)
    .where(
      and(
        eq(issueAddresses.lineage, lineage),
        eq(issueAddresses.projectId, projectId),
      ),
    );
  return rows[0]?.number ?? null;
}

/** Where the comment/attachment that once had `refId` lives now. */
export async function aliasOf(
  system: Db,
  kind: AliasKind,
  projectId: number,
  refId: number,
): Promise<{ projectId: number; id: number } | null> {
  const found = await aliasesOf(system, kind, projectId, [refId]);
  return found.get(refId) ?? null;
}

/** The same lookup for many ids at once, keyed by the id asked for. */
export async function aliasesOf(
  system: Db,
  kind: AliasKind,
  projectId: number,
  refIds: number[],
): Promise<Map<number, { projectId: number; id: number }>> {
  const found = new Map<number, { projectId: number; id: number }>();
  if (refIds.length === 0) return found;
  const rows = await system
    .select({
      refId: movedIds.refId,
      currentProjectId: movedIds.currentProjectId,
      currentId: movedIds.currentId,
    })
    .from(movedIds)
    .where(
      and(
        eq(movedIds.kind, kind),
        eq(movedIds.projectId, projectId),
        inArray(movedIds.refId, refIds),
      ),
    );
  for (const row of rows) {
    found.set(row.refId, {
      projectId: row.currentProjectId,
      id: row.currentId,
    });
  }
  return found;
}

/**
 * The same table read backwards: which old addresses each of these current
 * ids still answers on. One query is enough because the table is flat —
 * every historic address points straight at where the thing is now, so
 * there is no chain to walk.
 */
export async function aliasAddressesOf(
  system: Db,
  kind: AliasKind,
  currentProjectId: number,
  currentIds: number[],
): Promise<Map<number, Array<{ projectId: number; id: number }>>> {
  const found = new Map<number, Array<{ projectId: number; id: number }>>();
  if (currentIds.length === 0) return found;
  const rows = await system
    .select({
      projectId: movedIds.projectId,
      refId: movedIds.refId,
      currentId: movedIds.currentId,
    })
    .from(movedIds)
    .where(
      and(
        eq(movedIds.kind, kind),
        eq(movedIds.currentProjectId, currentProjectId),
        inArray(movedIds.currentId, currentIds),
      ),
    );
  for (const row of rows) {
    const list = found.get(row.currentId) ?? [];
    list.push({ projectId: row.projectId, id: row.refId });
    found.set(row.currentId, list);
  }
  return found;
}

/**
 * Whether this comment id is one the project used to hold, and a
 * `CommentMovedError` if it is (T-231).
 *
 * A tombstone has to answer for its comments too. The card's own marker knows
 * only where the card went, so a comment permalink would be redirected to the
 * card with the comment dropped — the alias is the only thing that knows the
 * new id. Lives here rather than in `comments.ts` because `revisions.ts` needs
 * it as well and `comments.ts` already imports that module, so the other
 * direction would close an import cycle.
 *
 * Consulted only on a miss or on a tombstone, so the common path never
 * touches the system database.
 */
export async function throwIfCommentAliased(
  ctx: AppContext,
  projectId: number,
  commentId: number,
  sourceReadable: boolean,
): Promise<void> {
  const alias = await aliasOf(
    ctx.router.system(),
    "comment",
    projectId,
    commentId,
  );
  if (alias !== null) {
    throw new CommentMovedError(projectId, commentId, sourceReadable);
  }
}

/**
 * Record a move in the address book and flatten the whole lineage onto the
 * new address, minting a lineage on the card's first move.
 *
 * Flattening rather than chaining is what keeps resolution at one lookup:
 * every address this card ever had points straight at where it is now.
 * Idempotent, because the cross-database protocol replays this step.
 */
export async function registerMove(
  system: Db,
  move: { lineage: number | null; from: Address; to: Address },
): Promise<number> {
  const lineage =
    move.lineage ?? (await ensureLineage(system, move.from, move.to));

  await system
    .update(issueAddresses)
    .set({
      currentProjectId: move.to.projectId,
      currentNumber: move.to.number,
      updatedAt: new Date(),
    })
    .where(eq(issueAddresses.lineage, lineage));

  await system
    .insert(issueAddresses)
    .values({
      lineage,
      projectId: move.to.projectId,
      number: move.to.number,
      currentProjectId: move.to.projectId,
      currentNumber: move.to.number,
    })
    .onConflictDoUpdate({
      target: [issueAddresses.projectId, issueAddresses.number],
      set: {
        lineage,
        currentProjectId: move.to.projectId,
        currentNumber: move.to.number,
        updatedAt: new Date(),
      },
    });

  await assertLineageFlat(system, lineage, move.to);
  return lineage;
}

/**
 * The lineage of a card moving for the first time: its source address is the
 * lineage's first row, and that row's own id becomes the identity every
 * later address inherits. Written in two statements because the value is
 * the id the insert is still generating.
 */
async function ensureLineage(
  system: Db,
  from: Address,
  to: Address,
): Promise<number> {
  const existing = await lineageOf(system, from.projectId, from.number);
  if (existing !== null) return existing;

  const inserted = await system
    .insert(issueAddresses)
    .values({
      lineage: 0,
      projectId: from.projectId,
      number: from.number,
      currentProjectId: to.projectId,
      currentNumber: to.number,
    })
    .returning({ id: issueAddresses.id });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error("address insert returned no row");
  await system
    .update(issueAddresses)
    .set({ lineage: id })
    .where(eq(issueAddresses.id, id));
  return id;
}

/**
 * Every address of a lineage points at the same place, and the destination
 * has an address of its own. Checked rather than assumed: a half-flattened
 * lineage resolves old links to a plausible wrong card, and nothing
 * downstream would notice — the reader simply lands somewhere else.
 */
async function assertLineageFlat(
  system: Db,
  lineage: number,
  to: Address,
): Promise<void> {
  const rows = await system
    .select({
      projectId: issueAddresses.projectId,
      number: issueAddresses.number,
      currentProjectId: issueAddresses.currentProjectId,
      currentNumber: issueAddresses.currentNumber,
    })
    .from(issueAddresses)
    .where(eq(issueAddresses.lineage, lineage));
  const stray = rows.find(
    (row) =>
      row.currentProjectId !== to.projectId || row.currentNumber !== to.number,
  );
  if (stray !== undefined) {
    throw new Error(
      `lineage ${lineage} is not flat: ${stray.projectId}/${stray.number} ` +
        `points at ${stray.currentProjectId}/${stray.currentNumber}`,
    );
  }
  if (!rows.some((row) => row.projectId === to.projectId)) {
    throw new Error(`lineage ${lineage} has no address in its destination`);
  }
}

/**
 * Alias the ids just copied, and repoint every alias that already resolved
 * to the old ones — the same flattening the address book does, so a
 * `#comment-N` from three moves ago still resolves in one lookup.
 */
export async function recordAliases(
  system: Db,
  kind: AliasKind,
  pairs: Array<{ fromId: number; toId: number }>,
  from: { projectId: number },
  to: { projectId: number },
): Promise<void> {
  if (pairs.length === 0) return;

  for (const pair of pairs) {
    await system
      .update(movedIds)
      .set({ currentProjectId: to.projectId, currentId: pair.toId })
      .where(
        and(
          eq(movedIds.kind, kind),
          eq(movedIds.currentProjectId, from.projectId),
          eq(movedIds.currentId, pair.fromId),
        ),
      );
  }

  await system
    .insert(movedIds)
    .values(
      pairs.map((pair) => ({
        kind,
        projectId: from.projectId,
        refId: pair.fromId,
        currentProjectId: to.projectId,
        currentId: pair.toId,
      })),
    )
    // Per row, not one value for the batch: the conflict target is an old
    // address, and each of them has its own new one. A static `set` would
    // give every colliding row the same id — an alias pointing at a real
    // but unrelated comment, which nothing downstream could detect.
    .onConflictDoUpdate({
      target: [movedIds.kind, movedIds.projectId, movedIds.refId],
      set: {
        currentProjectId: sql`excluded.current_project_id`,
        currentId: sql`excluded.current_id`,
      },
    });
}

/** One arrival, with the parts of its event only a rewrite needs. */
export type MoveRecord = IssueMove & {
  /** Who performed the move: the only actor an offline rewrite can borrow. */
  actorId: number;
  /** The comment ids this move renumbered, old → new; empty if it recorded none. */
  commentIdMap: Map<number, number>;
};

/**
 * The card's arrivals, oldest first — every ownership boundary it has.
 *
 * A `moved_in` event IS the boundary, which is why none of this needs a
 * column: the payload names where the card came from and the row's own
 * timestamp says when it stopped being there. One reader for that payload
 * shape, so a field renamed in the writer breaks in one place.
 */
export async function movedInHistory(
  db: Db,
  issueId: number,
): Promise<MoveRecord[]> {
  const rows = await db
    .select({
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
      actorId: issueEvents.actorId,
    })
    .from(issueEvents)
    .where(
      and(eq(issueEvents.issueId, issueId), eq(issueEvents.type, "moved_in")),
    )
    .orderBy(asc(issueEvents.createdAt), asc(issueEvents.id));
  return rows.map((row) => {
    const payload = row.payload as {
      from_project_id?: number;
      from_project?: string;
      from_number?: number;
      id_map?: { comments?: Record<string, number> };
    };
    return {
      at: row.createdAt.toISOString(),
      from_project_id: payload.from_project_id ?? null,
      from_project: payload.from_project ?? null,
      from_number: payload.from_number ?? null,
      actorId: row.actorId,
      commentIdMap: new Map(
        Object.entries(payload.id_map?.comments ?? {}).map(([from, to]) => [
          Number(from),
          to,
        ]),
      ),
    };
  });
}

async function projectById(
  system: Db,
  id: number,
): Promise<ProjectRow | undefined> {
  const rows = await system.select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

/** Where a marker points, once the address book and aliases are consulted. */
type Destination = {
  target: ProjectRow;
  /** The path to redirect to, relative to `/api`. */
  path: string;
  /** The 301 body; blob routes have none. */
  body: {
    moved_to: { slug: string; number: number; comment_id?: number };
  } | null;
  /** The tombstone's title — the only thing a 410 may reveal. */
  title: string | null;
  /** Present for issue markers, and what a write's 409 details carry. */
  movedTo: { slug: string; number: number } | null;
};

/**
 * Turn a relocation marker into the response the reader is entitled to:
 * 301 to the new address for anyone who can read the destination, 410 for
 * anyone who cannot — and that 410 names nothing about where the card went,
 * which is the whole reason it is not simply a 404.
 */
export async function respondRelocation(
  c: Context<AppEnv>,
  marker: RelocationMarker,
  // biome-ignore lint/suspicious/noExplicitAny: Hono types responses per status
): Promise<any> {
  const ctx = c.get("appCtx");
  const actor = c.get("user");
  const destination = await resolve(ctx, marker);
  // Unreachable by construction: `moved_at` is only set once the address
  // book has the row. A missing row means the card is simply not here.
  if (destination === null) throw new NotFoundError("not found");

  if ((await projectRoleOf(ctx, destination.target, actor)) === null) {
    // Neither end is theirs to read, so there is nothing to admit: a 410
    // would tell a stranger that this address once held something (T-242).
    if (!marker.sourceReadable) throw new NotFoundError("not found");
    if (marker instanceof AttachmentMovedError) return c.body(null, 410);
    return c.json(
      {
        moved: true,
        ...(destination.title === null ? {} : { title: destination.title }),
      },
      410,
    );
  }

  // A write cannot be redirected: whether it still means to happen against a
  // card that is no longer here is the caller's decision, not ours.
  if (marker instanceof IssueMovedError && marker.forWrite) {
    return c.json(
      {
        error: {
          code: "issue_moved",
          message: "this issue moved to another project",
          details: { moved_to: destination.movedTo },
        },
      },
      409,
    );
  }

  // Which subresource the reader asked for is in the request and nowhere
  // else, so the rewrite happens here rather than in `resolve`. Markers
  // without a body are the blob routes, whose `resolve` already built a
  // complete translated address — the same reason no `instanceof` is needed.
  const moved = destination.body?.moved_to;
  const asked =
    moved === undefined
      ? null
      : relocatedRequestPath(c.req.path, new URL(c.req.url).search, {
          slug: moved.slug,
          issueNumber: moved.number,
          commentId: moved.comment_id,
        });
  c.header("Location", asked ?? `/api${destination.path}`);
  if (destination.body === null) return c.body(null, 301);
  return c.json(destination.body, 301);
}

/** Where the thing behind an old address lives now, as far as a marker knows. */
export type RelocatedAddress = {
  slug: string;
  issueNumber: number;
  /** Comment markers only: the id that comment answers to now. */
  commentId?: number;
};

/**
 * The address the reader asked for, with the new home substituted into it.
 *
 * `…/issues/1/spec/files?version=1` has to land on the spec files rather than
 * on the card: a caller that follows the redirect would get 200 and an issue
 * body while it asked for a spec — success by status code, another resource
 * by content.
 *
 * Null when the substitution cannot be carried through, and the caller falls
 * back to the marker's own canonical path. The test is that no all-digit
 * segment is left over: those digits are project-scoped ids the move replaced,
 * so carrying one across points the redirect at a wrong but real row, which is
 * worse than pointing at the card. Phrasing the test that way also makes a
 * subresource added later fall back on its own, with nobody having to remember
 * to update a list of known shapes.
 */
export function relocatedRequestPath(
  requestPath: string,
  search: string,
  to: RelocatedAddress,
): string | null {
  const segments = requestPath.split("/");
  if (segments[1] !== "api" || segments[2] !== "projects") return null;
  segments[3] = to.slug;

  const substituted = new Set<number>();
  let rewritten = search;

  if (segments[4] === "issues") {
    if (!allDigits(segments[5])) return null;
    segments[5] = String(to.issueNumber);
    substituted.add(5);
    if (
      to.commentId !== undefined &&
      segments[6] === "comments" &&
      allDigits(segments[7])
    ) {
      segments[7] = String(to.commentId);
      substituted.add(7);
    }
  } else {
    // Nothing in this path holds the card's number, so the query is the only
    // place it can be — the attachment list addresses its issue that way. A
    // rewrite that dropped it would name a project and not a card.
    const params = new URLSearchParams(search);
    const asked = Number(params.get("issue_number"));
    if (!Number.isInteger(asked) || asked <= 0) return null;
    params.set("issue_number", String(to.issueNumber));
    rewritten = `?${params.toString()}`;
  }

  for (let i = 4; i < segments.length; i++) {
    if (!substituted.has(i) && allDigits(segments[i])) return null;
  }
  return `${segments.join("/")}${rewritten}`;
}

function allDigits(segment: string | undefined): boolean {
  return segment !== undefined && /^\d+$/.test(segment);
}

async function resolve(
  ctx: AppContext,
  marker: RelocationMarker,
): Promise<Destination | null> {
  const system = ctx.router.system();

  if (marker instanceof IssueMovedError) {
    const address = await currentAddressOf(
      system,
      marker.issue.projectId,
      marker.issue.number,
    );
    if (address === null) return null;
    const target = await projectById(system, address.projectId);
    if (target === undefined) return null;
    const movedTo = { slug: target.slug, number: address.number };
    return {
      target,
      path: `/projects/${target.slug}/issues/${address.number}`,
      body: { moved_to: movedTo },
      title: await tombstoneTitle(ctx, marker),
      movedTo,
    };
  }

  if (marker instanceof CommentMovedError) {
    const alias = await aliasOf(
      system,
      "comment",
      marker.projectId,
      marker.commentId,
    );
    if (alias === null) return null;
    const target = await projectById(system, alias.projectId);
    if (target === undefined) return null;
    const number = await issueNumberOfComment(ctx, target, alias.id);
    if (number === null) return null;
    return {
      target,
      path: `/projects/${target.slug}/issues/${number}/comments/${alias.id}`,
      // The comment id travels in the body so a client translating a
      // `#comment-N` anchor does not need a second round trip.
      body: {
        moved_to: { slug: target.slug, number, comment_id: alias.id },
      },
      title: null,
      movedTo: { slug: target.slug, number },
    };
  }

  const alias = await aliasOf(
    system,
    "attachment",
    marker.projectId,
    marker.attachmentId,
  );
  if (alias === null) return null;
  const target = await projectById(system, alias.projectId);
  if (target === undefined) return null;
  const name =
    marker.filename === null ? "" : `/${encodeURIComponent(marker.filename)}`;
  return {
    target,
    path: `/projects/${target.slug}/attachments/${alias.id}/${marker.variant}${name}`,
    body: null,
    title: null,
    movedTo: null,
  };
}

/** The tombstone keeps its title; it is all the 410 body may say. */
async function tombstoneTitle(
  ctx: AppContext,
  marker: IssueMovedError,
): Promise<string | null> {
  const source = await projectById(ctx.router.system(), marker.issue.projectId);
  if (source === undefined) return null;
  const db = await ctx.router.forProject(routeInfoOf(source));
  const rows = await db
    .select({ title: issues.title })
    .from(issues)
    .where(eq(issues.id, marker.issue.id));
  return rows[0]?.title ?? null;
}

async function issueNumberOfComment(
  ctx: AppContext,
  target: ProjectRow,
  commentId: number,
): Promise<number | null> {
  const db = await ctx.router.forProject(routeInfoOf(target));
  const rows = await db
    .select({ number: issues.number })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(eq(comments.id, commentId));
  return rows[0]?.number ?? null;
}
