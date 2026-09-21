/**
 * Block edges between issues (T-377): "this card waits for that one", stored
 * as one directed row in the system tier and readable from both ends.
 *
 * The pivot of the whole design is where the clearing verdict is computed:
 * always in the BLOCKER's own database, triggered by the blocker's own write,
 * with only the conclusion stored on the edge. That is what lets every read
 * path — a card, a list page, an inbox — answer "is this blocked" with one
 * system-database query and never open the other project's database.
 *
 * Cross-database writes (the timeline entries) are best effort, because there
 * is no transaction spanning two databases. `cleared_at` and
 * `cleared_notified_at` are kept apart for exactly that reason: the verdict
 * cannot fail, the announcement can, and the pair makes "cleared, but nobody
 * was told" a state the repair sweep can find and fix.
 */

import type { AgentContext, BlockRef, ChangeEvent } from "@todou/shared";
import {
  formatRef,
  parseInternalHref,
  parseRefLocator,
  resolveClaim,
} from "@todou/shared";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  issueEvents,
  issues,
  projectMeta,
  statuses,
} from "../db/project-schema.ts";
import { issueBlocks, projects } from "../db/system-schema.ts";
import {
  BlockSelfError,
  IssueNotReferenceableError,
  NotFoundError,
} from "../errors.ts";
import {
  findProjectByRef,
  type ProjectRow,
  projectRoleOf,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import { type VisibleProjects, visibleProjects } from "./cross-references.ts";
import {
  currentPrefixes,
  globalPrefixDirectory,
} from "./reference-directory.ts";
import { type Address, currentAddressOf } from "./relocation.ts";
import { assertIssueWritable, gateColumns, seesTrashed } from "./trash.ts";

type BlockRow = typeof issueBlocks.$inferSelect;

/** Which end of an edge the card a route names is standing on. */
export type BlockDirection = "blocked_by" | "blocks";

export type BlockSets = { blocked_by: BlockRef[]; blocks: BlockRef[] };

/** An edge whose verdict just moved, and where it moved to. */
export type BlockChange = { edge: BlockRow; cleared: boolean };

const EMPTY: BlockSets = { blocked_by: [], blocks: [] };

/** The two ends of an edge, as the caller named them. */
export type BlockEnds = { blocker: Address; blocked: Address };

const sameCard = (a: Address, b: Address): boolean =>
  a.projectId === b.projectId && a.number === b.number;

// ——— resolving the far end ———————————————————————————————————————————————

/**
 * The card `ref` names, in any spelling this deployment resolves: `#31`,
 * `31`, `T-31`, `acme#31`, `acme/T-31`, a stored `/projects/7/issues/31`, or
 * an absolute URL of this origin.
 *
 * Everything unresolvable is one 404, matching what the resolve pass does
 * with the same token in prose: a ref nobody may read and a ref nobody wrote
 * must not be tellable apart, or this becomes a way to probe for projects.
 * The one distinction drawn is 409 for a card the caller CAN read but which
 * takes no new edge — in the trash, or mid-move — because that one is
 * actionable and admits nothing the caller could not already see.
 */
export async function resolveBlockTarget(
  ctx: AppContext,
  actor: UserRow,
  here: ProjectRow,
  ref: string,
): Promise<Address> {
  const named = await namedProject(ctx, here, ref);
  if (named === null) throw new NotFoundError("issue not found");

  const moved = await currentAddressOf(
    ctx.router.system(),
    named.project.id,
    named.number,
  );
  const address = moved ?? {
    projectId: named.project.id,
    number: named.number,
  };
  const target =
    address.projectId === named.project.id
      ? named.project
      : ((await findProjectByRef(ctx, String(address.projectId)))?.project ??
        null);
  if (target === null) throw new NotFoundError("issue not found");

  // The address book first, read access to wherever it points second, and
  // never to the project the ref named — the order `cardAddressFor` fixes for
  // every other resolver.
  const role = await projectRoleOf(ctx, target, actor);
  if (role === null) throw new NotFoundError("issue not found");

  const db = await ctx.router.forProject(routeInfoOf(target));
  const rows = await db
    .select({
      deletedAt: issues.deletedAt,
      movedAt: issues.movedAt,
      movingSince: issues.movingSince,
      authorId: issues.authorId,
    })
    .from(issues)
    .where(
      and(eq(issues.projectId, target.id), eq(issues.number, address.number)),
    );
  const row = rows[0];
  if (row === undefined || row.movedAt !== null) {
    throw new NotFoundError("issue not found");
  }
  if (row.deletedAt !== null && !seesTrashed(row, actor, role)) {
    throw new NotFoundError("issue not found");
  }
  if (row.deletedAt !== null || row.movingSince !== null) {
    throw new IssueNotReferenceableError();
  }
  return { projectId: target.id, number: address.number };
}

type NamedCard = { project: ProjectRow; number: number };

/** The project and number a ref spells, before the address book is asked. */
async function namedProject(
  ctx: AppContext,
  here: ProjectRow,
  ref: string,
): Promise<NamedCard | null> {
  const trimmed = ref.trim();
  const href = parseInternalHref(trimmed, ctx.config.http.public_origin);
  if (href !== null) {
    if (href.kind !== "issue") return null;
    const project =
      href.project.kind === "id"
        ? await findProjectByRef(ctx, String(href.project.id))
        : await findProjectByRef(ctx, href.project.slug);
    return project === null
      ? null
      : { project: project.project, number: href.number };
  }

  const locator = parseRefLocator(trimmed);
  if (locator !== null) {
    if (locator.kind === "qualified") {
      const project = await findProjectByRef(ctx, locator.slug);
      return project === null
        ? null
        : { project: project.project, number: locator.number };
    }
    const directory = await globalPrefixDirectory(ctx);
    const holder = resolveClaim(
      directory.entries,
      directory.contested,
      locator.prefix,
    );
    if (holder === null) return null;
    const project = await findProjectByRef(ctx, holder);
    return project === null
      ? null
      : { project: project.project, number: locator.number };
  }

  // `#31` and a bare `31` name this project and have no shape question left
  // to answer, which is why the shared grammar leaves them to the caller.
  const bare = /^#?(\d{1,15})$/.exec(trimmed);
  if (bare === null) return null;
  return { project: here, number: Number(bare[1]) };
}

// ——— the routes' entry points ———————————————————————————————————————————

/**
 * Declare an edge from the card the route names, in the direction the route
 * names, and answer with that card's whole set in that direction — redrawing
 * the section is what the caller does next, and one edge would only make it
 * ask again.
 *
 * The gate is `issue.block` on the card the route names. The far end needs
 * nothing beyond being readable, which resolving it already proves.
 */
export async function addIssueBlock(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  direction: BlockDirection,
  ref: string,
  agentContext: AgentContext | null = null,
): Promise<BlockSets> {
  const { project, card } = await writableCard(ctx, actor, slug, number);
  const target = await resolveBlockTarget(ctx, actor, project, ref);
  await addBlock(
    ctx,
    actor,
    direction === "blocked_by"
      ? { blocked: card, blocker: target }
      : { blocked: target, blocker: card },
    agentContext,
  );
  return blocksForIssue(ctx, card, await visibleProjects(ctx, actor));
}

export async function removeIssueBlock(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  direction: BlockDirection,
  edgeId: number,
  agentContext: AgentContext | null = null,
): Promise<void> {
  const { card } = await writableCard(ctx, actor, slug, number);
  await removeBlock(ctx, actor, card, edgeId, direction, agentContext);
}

/**
 * The card a block route names, gated. A card in the trash or mid-move is
 * frozen for this as for every other write — and a hidden edge is still the
 * card owner's to drop, which is why nothing here asks about the far end.
 */
async function writableCard(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
): Promise<{ project: ProjectRow; card: Address }> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.block",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select(gateColumns)
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)));
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("issue not found");
  assertIssueWritable(row, actor, role);
  return { project, card: { projectId: project.id, number } };
}

// ——— writing ————————————————————————————————————————————————————————————

/**
 * Declare an edge, idempotently. A repeat returns the edge that is already
 * there and records nothing: the main caller is an agent that replays, and
 * turning a replay into an error only teaches it to read first.
 */
export async function addBlock(
  ctx: AppContext,
  actor: UserRow,
  ends: BlockEnds,
  agentContext: AgentContext | null,
): Promise<void> {
  if (sameCard(ends.blocker, ends.blocked)) throw new BlockSelfError();
  const system = ctx.router.system();

  // Evaluated before the insert rather than by a round through
  // `evaluateBlockerStatus` afterwards: an edge declared against a card that
  // is already past the line lands CLEARED, which is not the same event as
  // one clearing later, and nobody is owed a notification for it. Stamping
  // `cleared_notified_at` alongside is what tells the repair sweep so.
  const cleared = await clearedAtOf(ctx, ends.blocker);
  const inserted = await system
    .insert(issueBlocks)
    .values({
      blockerProjectId: ends.blocker.projectId,
      blockerNumber: ends.blocker.number,
      blockedProjectId: ends.blocked.projectId,
      blockedNumber: ends.blocked.number,
      createdBy: actor.id,
      clearedAt: cleared,
      clearedNotifiedAt: cleared,
    })
    .onConflictDoNothing({
      target: [
        issueBlocks.blockerProjectId,
        issueBlocks.blockerNumber,
        issueBlocks.blockedProjectId,
        issueBlocks.blockedNumber,
      ],
    })
    .returning();
  const edge = inserted[0];
  if (edge === undefined) return;
  await announceEdge(ctx, edge, "block_added", actor.id, agentContext);
}

/**
 * Drop an edge from the card the route named. The direction is checked as
 * well as the id: without it this would be "delete any edge by number", and
 * the id of an edge is visible to both ends.
 */
export async function removeBlock(
  ctx: AppContext,
  actor: UserRow,
  card: Address,
  edgeId: number,
  direction: BlockDirection,
  agentContext: AgentContext | null,
): Promise<void> {
  const system = ctx.router.system();
  const deleted = await system
    .delete(issueBlocks)
    .where(and(eq(issueBlocks.id, edgeId), endIs(card, direction)))
    .returning();
  const edge = deleted[0];
  // Wrong direction, wrong card and no such edge are one answer: telling
  // them apart would report which edge ids exist on other people's cards.
  if (edge === undefined)
    throw new NotFoundError("no such block on this issue");
  await announceEdge(ctx, edge, "block_removed", actor.id, agentContext);
}

/** The card a route named, standing on the end `direction` says it is. */
function endIs(card: Address, direction: BlockDirection) {
  return direction === "blocked_by"
    ? and(
        eq(issueBlocks.blockedProjectId, card.projectId),
        eq(issueBlocks.blockedNumber, card.number),
      )
    : and(
        eq(issueBlocks.blockerProjectId, card.projectId),
        eq(issueBlocks.blockerNumber, card.number),
      );
}

// ——— the clearing verdict ————————————————————————————————————————————————

/**
 * Re-decide every edge these cards block, and hand back the ones that moved.
 *
 * The caller announces; this only writes the verdict, so a failed
 * announcement leaves a repairable state rather than a wrong one. Nothing is
 * read from the project database until an edge is known to exist, which is
 * what keeps an ordinary status change on an unblocking card at one extra
 * system query.
 */
export async function evaluateBlockerStatus(
  ctx: AppContext,
  project: ProjectRow,
  db: Db,
  numbers: number[],
): Promise<BlockChange[]> {
  if (numbers.length === 0) return [];
  const system = ctx.router.system();
  const edges = await system
    .select()
    .from(issueBlocks)
    .where(
      and(
        eq(issueBlocks.blockerProjectId, project.id),
        inArray(issueBlocks.blockerNumber, numbers),
      ),
    );
  if (edges.length === 0) return [];

  const verdicts = await clearedNumbers(db, project.id, [
    ...new Set(edges.map((e) => e.blockerNumber)),
  ]);
  const now = new Date();
  const changes: BlockChange[] = [];
  for (const edge of edges) {
    const cleared = verdicts.get(edge.blockerNumber);
    // A number with no row left is not a verdict of "clear": leaving the
    // edge where it stands is the only answer that cannot invent one.
    if (cleared === undefined) continue;
    if (cleared === (edge.clearedAt !== null)) continue;
    const updated = await system
      .update(issueBlocks)
      .set(
        cleared
          ? { clearedAt: now }
          : // Re-blocking clears the announcement stamp with the verdict, or
            // the next clearing would look to the repair sweep like one that
            // had already been announced.
            { clearedAt: null, clearedNotifiedAt: null },
      )
      .where(eq(issueBlocks.id, edge.id))
      .returning();
    const after = updated[0];
    if (after !== undefined) changes.push({ edge: after, cleared });
  }
  return changes;
}

/** Whether one card is at or past its project's clear line, right now. */
async function clearedAtOf(
  ctx: AppContext,
  card: Address,
): Promise<Date | null> {
  const project = (await findProjectByRef(ctx, String(card.projectId)))
    ?.project;
  if (project === undefined) return null;
  const db = await ctx.router.forProject(routeInfoOf(project));
  const verdicts = await clearedNumbers(db, project.id, [card.number]);
  return verdicts.get(card.number) === true ? new Date() : null;
}

/**
 * The clear line, applied in the project's own database: at or past the
 * configured status by position, or — with none configured — in the closed
 * category. A configured status that is no longer there falls back to the
 * same default; `deleteStatus` refuses to remove a line, so that can only be
 * a hand-edited database, and inventing a different answer for it would be
 * a second rule nobody wrote down.
 */
async function clearedNumbers(
  db: Db,
  projectId: number,
  numbers: number[],
): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  if (numbers.length === 0) return out;
  const meta = await db
    .select({ lineId: projectMeta.blockClearStatusId })
    .from(projectMeta)
    .where(eq(projectMeta.projectId, projectId));
  const statusRows = await db
    .select({
      id: statuses.id,
      position: statuses.position,
      category: statuses.category,
    })
    .from(statuses)
    .where(eq(statuses.projectId, projectId));
  const byId = new Map(statusRows.map((s) => [s.id, s]));
  const lineId = meta[0]?.lineId ?? null;
  const line = lineId === null ? undefined : byId.get(lineId);

  const rows = await db
    .select({ number: issues.number, statusId: issues.statusId })
    .from(issues)
    .where(
      and(eq(issues.projectId, projectId), inArray(issues.number, numbers)),
    );
  for (const row of rows) {
    const status = byId.get(row.statusId);
    if (status === undefined) continue;
    out.set(
      row.number,
      line === undefined
        ? status.category === "closed"
        : status.position >= line.position,
    );
  }
  return out;
}

/**
 * Every edge this project's cards block, re-decided. What a change to the
 * clear line or a status reorder costs: bounded by the project's EDGE count,
 * never by its card count.
 */
export async function reevaluateProjectBlocks(
  ctx: AppContext,
  project: ProjectRow,
  db: Db,
): Promise<BlockChange[]> {
  const numbers = await blockerNumbersOf(ctx, project.id);
  return evaluateBlockerStatus(ctx, project, db, numbers);
}

async function blockerNumbersOf(
  ctx: AppContext,
  projectId: number,
): Promise<number[]> {
  const rows = await ctx.router
    .system()
    .select({ number: issueBlocks.blockerNumber })
    .from(issueBlocks)
    .where(eq(issueBlocks.blockerProjectId, projectId));
  return [...new Set(rows.map((r) => r.number))];
}

/**
 * The trash suspends an edge instead of clearing it: a card nobody can reach
 * is not a card whose work is done, and reading it as cleared would send
 * somebody to work on something that may be restored a minute later.
 *
 * No timeline entry and no change event, deliberately — the four block events
 * are about the edge's verdict, and this moves no verdict. The flag travels
 * with the next read of either card.
 */
export async function markBlockerDeleted(
  ctx: AppContext,
  project: ProjectRow,
  numbers: number[],
  deleted: boolean,
): Promise<void> {
  if (numbers.length === 0) return;
  await ctx.router
    .system()
    .update(issueBlocks)
    .set({ blockerDeletedAt: deleted ? new Date() : null })
    .where(
      and(
        eq(issueBlocks.blockerProjectId, project.id),
        inArray(issueBlocks.blockerNumber, numbers),
      ),
    );
}

// ——— announcing ————————————————————————————————————————————————————————

/**
 * Land `block_cleared` / `block_reblocked` on the blocked card and stamp the
 * ones that got through.
 *
 * Reblocking is announced as loudly as clearing: somebody may already have
 * started on the strength of the first message, and silence would leave them
 * working on a card that is blocked again.
 */
export async function announceBlockChanges(
  ctx: AppContext,
  changes: BlockChange[],
  /**
   * Whoever's write moved the verdict. Null for the repair sweep, which has
   * no actor of its own and falls back to whoever declared the edge — the
   * one account on record as having asked for this relation. It matters
   * beyond the byline: unread skips a reader's own entries, so an actor
   * picked at random here would decide whose badge lights up.
   */
  actorId: number | null,
  agentContext: AgentContext | null = null,
): Promise<void> {
  for (const change of changes) {
    const landed = await landEvent(
      ctx,
      {
        projectId: change.edge.blockedProjectId,
        number: change.edge.blockedNumber,
      },
      change.cleared ? "block_cleared" : "block_reblocked",
      {
        edge_id: change.edge.id,
        blocker_project_id: change.edge.blockerProjectId,
        blocker_number: change.edge.blockerNumber,
      },
      actorId ?? change.edge.createdBy,
      agentContext,
    );
    if (landed && change.cleared) {
      await ctx.router
        .system()
        .update(issueBlocks)
        .set({ clearedNotifiedAt: new Date() })
        .where(eq(issueBlocks.id, change.edge.id));
    }
  }
}

/**
 * Both ends hear that an edge was declared or dropped. Declaring one tells
 * the blocker somebody is waiting on it, which is the point: that is a fact
 * the person holding the work should have.
 *
 * Best effort, and nothing repairs it: a lost entry costs one line of one
 * timeline, while the edge itself — and the clearing notification that hangs
 * off it — is already durable.
 */
async function announceEdge(
  ctx: AppContext,
  edge: BlockRow,
  type: "block_added" | "block_removed",
  actorId: number,
  agentContext: AgentContext | null,
): Promise<void> {
  await landEvent(
    ctx,
    { projectId: edge.blockedProjectId, number: edge.blockedNumber },
    type,
    {
      edge_id: edge.id,
      role: "blocked",
      other_project_id: edge.blockerProjectId,
      other_number: edge.blockerNumber,
    },
    actorId,
    agentContext,
  );
  await landEvent(
    ctx,
    { projectId: edge.blockerProjectId, number: edge.blockerNumber },
    type,
    {
      edge_id: edge.id,
      role: "blocker",
      other_project_id: edge.blockedProjectId,
      other_number: edge.blockedNumber,
    },
    actorId,
    agentContext,
  );
}

/** One timeline entry on one card, wherever it lives. False = it did not land. */
async function landEvent(
  ctx: AppContext,
  card: Address,
  type: "block_added" | "block_removed" | "block_cleared" | "block_reblocked",
  payload: Record<string, unknown>,
  actorId: number,
  agentContext: AgentContext | null,
): Promise<boolean> {
  try {
    const project = (await findProjectByRef(ctx, String(card.projectId)))
      ?.project;
    if (project === undefined) return false;
    const db = await ctx.router.forProject(routeInfoOf(project));
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(eq(issues.projectId, project.id), eq(issues.number, card.number)),
      );
    const issueId = rows[0]?.id;
    if (issueId === undefined) return false;
    const inserted = await db
      .insert(issueEvents)
      .values({
        projectId: project.id,
        issueId,
        actorId,
        type,
        payload,
        agentContext,
      })
      .returning({ id: issueEvents.id });
    const eventId = inserted[0]?.id;
    const events: ChangeEvent[] = [];
    if (eventId !== undefined) {
      events.push({
        entity: "timeline",
        id: eventId,
        action: "created",
        issue_number: card.number,
      });
    }
    // `activity` rather than `fields`: an edge changing moves no card
    // between the lists a subscriber is holding — `?blocked=` is a filter a
    // client asks for, not a membership the feed tracks.
    events.push({
      entity: "issue",
      id: issueId,
      action: "updated",
      issue_number: card.number,
      list_row: { kind: "activity" },
    });
    for (const e of events) ctx.bus.publish(project.id, e);
    return eventId !== undefined;
  } catch (cause) {
    console.error(
      `block event ${type} could not be landed on ${card.projectId}/${card.number}`,
      cause,
    );
    return false;
  }
}

// ——— reading ————————————————————————————————————————————————————————————

/**
 * Both directions for a page of cards in one project, in one system-database
 * query — the cost is per page, not per card, which is what lets every issue
 * read carry these without a second thought.
 *
 * `visible` is a thunk so a page with no edges at all pays nothing for the
 * visibility lookup, and so the one `bundleIssues` already needs for `moves`
 * is shared rather than repeated.
 */
export async function blocksForIssues(
  ctx: AppContext,
  projectIds: number[],
  numbers: number[],
  visible: () => Promise<VisibleProjects>,
): Promise<Map<string, BlockSets>> {
  const out = new Map<string, BlockSets>();
  if (numbers.length === 0 || projectIds.length === 0) return out;
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(issueBlocks)
    .where(
      or(
        and(
          inArray(issueBlocks.blockedProjectId, projectIds),
          inArray(issueBlocks.blockedNumber, numbers),
        ),
        and(
          inArray(issueBlocks.blockerProjectId, projectIds),
          inArray(issueBlocks.blockerNumber, numbers),
        ),
      ),
    );
  if (rows.length === 0) return out;

  const visibleIds = (await visible()).ids;
  const spelling = await spellingOf(
    system,
    new Set(rows.flatMap((r) => [r.blockerProjectId, r.blockedProjectId])),
  );
  const here = new Set(projectIds);
  const wanted = new Set(numbers);
  const at = (projectId: number, number: number): BlockSets => {
    const key = cardKey(projectId, number);
    const found = out.get(key);
    if (found !== undefined) return found;
    const fresh: BlockSets = { blocked_by: [], blocks: [] };
    out.set(key, fresh);
    return fresh;
  };

  for (const row of rows) {
    if (here.has(row.blockedProjectId) && wanted.has(row.blockedNumber)) {
      at(row.blockedProjectId, row.blockedNumber).blocked_by.push(
        toBlockRef(
          row,
          row.blockerProjectId,
          row.blockerNumber,
          visibleIds,
          spelling,
        ),
      );
    }
    if (here.has(row.blockerProjectId) && wanted.has(row.blockerNumber)) {
      at(row.blockerProjectId, row.blockerNumber).blocks.push(
        toBlockRef(
          row,
          row.blockedProjectId,
          row.blockedNumber,
          visibleIds,
          spelling,
        ),
      );
    }
  }
  for (const sets of out.values()) {
    sets.blocked_by.sort(compareBlockRefs);
    sets.blocks.sort(compareBlockRefs);
  }
  return out;
}

export const cardKey = (projectId: number, number: number): string =>
  `${projectId}/${number}`;

export const blockSetsOf = (
  map: Map<string, BlockSets>,
  projectId: number,
  number: number,
): BlockSets => map.get(cardKey(projectId, number)) ?? EMPTY;

/** One card's two directions, for the write routes' response. */
export async function blocksForIssue(
  ctx: AppContext,
  card: Address,
  visible: VisibleProjects,
): Promise<BlockSets> {
  const map = await blocksForIssues(
    ctx,
    [card.projectId],
    [card.number],
    async () => visible,
  );
  return blockSetsOf(map, card.projectId, card.number);
}

type Spelling = Map<number, { slug: string; prefix: string | null }>;

/**
 * How each project spells a card of its own. Read from the system tier's
 * prefix mirror rather than from every project's `ref_formats`, which would
 * be a database to open per project named on the page.
 */
async function spellingOf(system: Db, ids: Set<number>): Promise<Spelling> {
  const out: Spelling = new Map();
  if (ids.size === 0) return out;
  const list = [...ids];
  const rows = await system
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, list));
  for (const row of rows) out.set(row.id, { slug: row.slug, prefix: null });
  for (const [projectId, prefix] of await currentPrefixes(system, list)) {
    const entry = out.get(projectId);
    if (entry !== undefined) entry.prefix = prefix;
  }
  return out;
}

function toBlockRef(
  row: BlockRow,
  otherProjectId: number,
  otherNumber: number,
  visibleIds: Set<number>,
  spelling: Spelling,
): BlockRef {
  const named = spelling.get(otherProjectId);
  const hidden = !visibleIds.has(otherProjectId);
  return {
    edge_id: row.id,
    project_id: hidden ? null : otherProjectId,
    project: hidden ? null : (named?.slug ?? null),
    number: hidden ? null : otherNumber,
    ref: hidden ? null : formatRef(named?.prefix ?? null, otherNumber),
    hidden,
    cleared_at: row.clearedAt?.toISOString() ?? null,
    blocker_deleted: row.blockerDeletedAt !== null,
  };
}

/** Still blocking first, then the hidden ones, then by project and number. */
function compareBlockRefs(a: BlockRef, b: BlockRef): number {
  const cleared = Number(a.cleared_at !== null) - Number(b.cleared_at !== null);
  if (cleared !== 0) return cleared;
  const hidden = Number(a.hidden) - Number(b.hidden);
  if (hidden !== 0) return hidden;
  const project = (a.project_id ?? 0) - (b.project_id ?? 0);
  if (project !== 0) return project;
  const number = (a.number ?? 0) - (b.number ?? 0);
  return number !== 0 ? number : a.edge_id - b.edge_id;
}

/**
 * The numbers in this project still held by an unresolved edge — the list
 * filter's input.
 *
 * Two steps rather than a SQL join, because the edges are in another
 * database from the cards: the set is bounded by this project's edge count,
 * and it feeds the paginated query as an `IN`, so pagination stays whole.
 */
export async function blockedNumbersIn(
  ctx: AppContext,
  projectId: number,
): Promise<number[]> {
  const rows = await ctx.router
    .system()
    .select({ number: issueBlocks.blockedNumber })
    .from(issueBlocks)
    .where(
      and(
        eq(issueBlocks.blockedProjectId, projectId),
        isNull(issueBlocks.clearedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.number))];
}

// ——— repair ——————————————————————————————————————————————————————————————

export type BlockRepairResult = { recomputed: number; announced: number };

/**
 * Recompute every edge's verdict and send the clearings nobody was told
 * about.
 *
 * The second half is the reason this exists: landing the entry is a
 * cross-database write that can fail, and "tell the blocked card when its
 * blocker is done" is the whole feature — one silently lost notification is
 * the feature failing once with nobody the wiser. Edges are far fewer than
 * cards, so a full recompute is affordable.
 */
export async function repairBlocks(
  ctx: AppContext,
): Promise<BlockRepairResult> {
  const system = ctx.router.system();
  const blockerProjects = [
    ...new Set(
      (
        await system
          .select({ projectId: issueBlocks.blockerProjectId })
          .from(issueBlocks)
      ).map((r) => r.projectId),
    ),
  ];
  let recomputed = 0;
  for (const projectId of blockerProjects) {
    const project = (await findProjectByRef(ctx, String(projectId)))?.project;
    if (project === undefined) continue;
    const db = await ctx.router.forProject(routeInfoOf(project));
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    recomputed += changes.length;
    await syncBlockerDeleted(ctx, project, db);
    // Announced through the same path as a live change, so a verdict the
    // sweep repaired is indistinguishable from one a write produced.
    await announceBlockChanges(ctx, changes, null);
  }

  const pending = await system
    .select()
    .from(issueBlocks)
    .where(
      and(
        isNotNull(issueBlocks.clearedAt),
        isNull(issueBlocks.clearedNotifiedAt),
      ),
    );
  for (const edge of pending) {
    await announceBlockChanges(ctx, [{ edge, cleared: true }], null);
  }
  return { recomputed, announced: pending.length };
}

/** The trash flag, recomputed from the blockers' own rows. */
async function syncBlockerDeleted(
  ctx: AppContext,
  project: ProjectRow,
  db: Db,
): Promise<void> {
  const numbers = await blockerNumbersOf(ctx, project.id);
  if (numbers.length === 0) return;
  const rows = await db
    .select({ number: issues.number, deletedAt: issues.deletedAt })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), inArray(issues.number, numbers)),
    );
  const trashed = rows.filter((r) => r.deletedAt !== null).map((r) => r.number);
  const alive = rows.filter((r) => r.deletedAt === null).map((r) => r.number);
  await markBlockerDeleted(ctx, project, trashed, true);
  await markBlockerDeleted(ctx, project, alive, false);
}
