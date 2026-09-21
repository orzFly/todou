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

  const states = await cardStatesOf(db, project.id, [
    ...new Set(edges.map((e) => e.blockerNumber)),
  ]);
  return applyVerdicts(system, edges, states);
}

/**
 * Write the verdicts `states` implies onto `edges`, in two batches.
 *
 * The returned changes are re-ordered back onto `edges`: `UPDATE … RETURNING`
 * makes no promise about row order, and this list is what decides the order
 * the timeline entries land in.
 */
async function applyVerdicts(
  system: Db,
  edges: BlockRow[],
  states: Map<string, CardState>,
): Promise<BlockChange[]> {
  const now = new Date();
  const verdicts = new Map<number, boolean>();
  const clearedIds: number[] = [];
  const reblockedIds: number[] = [];
  for (const edge of edges) {
    const state = states.get(
      cardKey(edge.blockerProjectId, edge.blockerNumber),
    );
    // A number with no row left is not a verdict of "clear", and neither is
    // one whose status row will not resolve: leaving the edge where it stands
    // is the only answer that cannot invent one.
    if (state === undefined || state.cleared === undefined) continue;
    if (state.cleared === (edge.clearedAt !== null)) continue;
    verdicts.set(edge.id, state.cleared);
    (state.cleared ? clearedIds : reblockedIds).push(edge.id);
  }

  const updated = new Map<number, BlockRow>();
  for (const [ids, values] of [
    [clearedIds, { clearedAt: now }],
    // Re-blocking clears the announcement stamp with the verdict, or the next
    // clearing would look to the repair sweep like one that had already been
    // announced.
    [reblockedIds, { clearedAt: null, clearedNotifiedAt: null }],
  ] as const) {
    for (const slice of chunks(ids)) {
      const rows = await system
        .update(issueBlocks)
        .set(values)
        .where(inArray(issueBlocks.id, slice))
        .returning();
      for (const row of rows) updated.set(row.id, row);
    }
  }

  const changes: BlockChange[] = [];
  for (const edge of edges) {
    const after = updated.get(edge.id);
    const cleared = verdicts.get(edge.id);
    if (after !== undefined && cleared !== undefined) {
      changes.push({ edge: after, cleared });
    }
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
  const states = await cardStatesOf(db, project.id, [card.number]);
  return states.get(cardKey(project.id, card.number))?.cleared === true
    ? new Date()
    : null;
}

/**
 * What a card is worth to an edge: whether it is past its project's clear
 * line, and whether it is in the trash.
 *
 * The two are deliberately separate values rather than one boolean. A card
 * whose status row will not resolve yields NO verdict — `cleared` is
 * undefined — while its trash flag is still perfectly well defined, and
 * folding them together would silently stop the trash flag from syncing for
 * exactly those rows.
 */
type CardState = { cleared: boolean | undefined; deleted: boolean };

/**
 * `inArray` binds one parameter per value and PostgreSQL refuses a statement
 * with more than 65535 of them. The sweep's only caller logs and swallows,
 * so going over would not surface as a failure — it would quietly repair
 * nothing.
 */
const CHUNK = 1000;

/**
 * Yields nothing for an empty list, which is also the guard every batched
 * write here needs: drizzle 0.45.2 compiles `inArray(col, [])` to `false`
 * rather than refusing it, so an unguarded empty batch is a statement sent
 * on every sweep that found nothing to do.
 */
function* chunks<T>(values: readonly T[]): Generator<T[]> {
  for (let i = 0; i < values.length; i += CHUNK) {
    yield values.slice(i, i + CHUNK);
  }
}

/** `cardStates` for a single project, which is what the live paths ask for. */
const cardStatesOf = (
  db: Db,
  projectId: number,
  numbers: number[],
): Promise<Map<string, CardState>> =>
  cardStates(db, new Map([[projectId, numbers]]));

/**
 * The clear line and the trash flag for every wanted card, read from the one
 * database all these projects live in.
 *
 * The line is applied in the project's own database: at or past the
 * configured status by position, or — with none configured — in the closed
 * category. A configured status that is no longer there falls back to the
 * same default; `deleteStatus` refuses to remove a line, so that can only be
 * a hand-edited database, and inventing a different answer for it would be
 * a second rule nobody wrote down. A status belonging to a DIFFERENT project
 * does not resolve either, which is why the lookup is keyed by the pair.
 *
 * The projects are asked for with `inArray` rather than one `or()` branch
 * each, so the statement text stays the same size whatever the deployment
 * looks like — under shared placement one call covers every project there is.
 * The price is read amplification: `projectId IN (…) AND number IN (…)` is a
 * rectangle, so at worst projects × numbers rows come back and the pairing
 * below throws the extras away. A VALUES-derived table would cut that, but by
 * standing convention this repo inlines one in `services/calendar.ts` and
 * `services/user-issues.ts` only, and this is not a third site for it.
 */
async function cardStates(
  db: Db,
  wanted: Map<number, number[]>,
): Promise<Map<string, CardState>> {
  const out = new Map<string, CardState>();
  const pairs: [number, number][] = [];
  for (const [projectId, numbers] of wanted) {
    for (const number of numbers) pairs.push([projectId, number]);
  }

  for (const slice of chunks(pairs)) {
    const ids = [...new Set(slice.map(([projectId]) => projectId))];
    const numbers = [...new Set(slice.map(([, number]) => number))];
    const meta = await db
      .select({
        projectId: projectMeta.projectId,
        lineId: projectMeta.blockClearStatusId,
      })
      .from(projectMeta)
      .where(inArray(projectMeta.projectId, ids));
    const statusRows = await db
      .select({
        id: statuses.id,
        projectId: statuses.projectId,
        position: statuses.position,
        category: statuses.category,
      })
      .from(statuses)
      .where(inArray(statuses.projectId, ids));
    const byId = new Map(
      statusRows.map((s) => [cardKey(s.projectId, s.id), s]),
    );
    const lines = new Map(
      meta.map((m) => [
        m.projectId,
        m.lineId === null
          ? undefined
          : byId.get(cardKey(m.projectId, m.lineId)),
      ]),
    );

    const rows = await db
      .select({
        projectId: issues.projectId,
        number: issues.number,
        statusId: issues.statusId,
        deletedAt: issues.deletedAt,
      })
      .from(issues)
      .where(
        and(inArray(issues.projectId, ids), inArray(issues.number, numbers)),
      );
    const asked = new Set(
      slice.map(([projectId, number]) => cardKey(projectId, number)),
    );
    for (const row of rows) {
      const key = cardKey(row.projectId, row.number);
      if (!asked.has(key)) continue;
      const status = byId.get(cardKey(row.projectId, row.statusId));
      const line = lines.get(row.projectId);
      out.set(key, {
        cleared:
          status === undefined
            ? undefined
            : line === undefined
              ? status.category === "closed"
              : status.position >= line.position,
        deleted: row.deletedAt !== null,
      });
    }
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
 *
 * This sweep does NOT skip projects that share the system database, unlike
 * the mirror sweep next door. What it repairs has nothing to do with where a
 * project's rows live: a drifted verdict is a status in the project tier
 * disagreeing with an edge in the system tier, and there is no transaction
 * spanning those two writes even when one database holds both. Nor is the
 * announcement one: it is deliberately outside the verdict's write —
 * `evaluateBlockerStatus` says so in as many words, `landEvent` logs its
 * failures and returns false, and `cleared_notified_at` is a separate write
 * that follows a successful announcement. Colocation closes none of that.
 *
 * Two things the batching changed, said out loud rather than left to be
 * rediscovered:
 *
 * - The window between reading an edge and writing its verdict is now the
 *   whole sweep rather than one project's turn. A concurrent live write can
 *   be overwritten by a verdict computed from a slightly older read. The race
 *   is not new — `evaluateBlockerStatus` also reads edges before writing them
 *   — only wider, and it converges: the sweep writes the verdict that today's
 *   card state implies, which is the same question the live write answered,
 *   and the next sweep settles any remaining disagreement.
 * - Announcements used to interleave with the verdicts, project by project.
 *   They now all follow all of the verdicts, in `edges` order.
 */
export async function repairBlocks(
  ctx: AppContext,
): Promise<BlockRepairResult> {
  const system = ctx.router.system();
  const edges = await system.select().from(issueBlocks);
  let recomputed = 0;
  if (edges.length > 0) {
    const wantedBy = new Map<number, Set<number>>();
    for (const edge of edges) {
      const numbers = wantedBy.get(edge.blockerProjectId);
      if (numbers === undefined) {
        wantedBy.set(edge.blockerProjectId, new Set([edge.blockerNumber]));
      } else {
        numbers.add(edge.blockerNumber);
      }
    }
    // `issue_blocks.blocker_project_id` has a foreign key onto `projects.id`,
    // so this is the same set of rows the old per-edge `findProjectByRef`
    // returned — that call took its id branch and one query. A project the
    // registry cannot produce yields no card state, and its edges keep the
    // verdict they already have.
    const projectRows: ProjectRow[] = [];
    for (const slice of chunks([...wantedBy.keys()])) {
      projectRows.push(
        ...(await system
          .select()
          .from(projects)
          .where(inArray(projects.id, slice))),
      );
    }

    const states = new Map<string, CardState>();
    const groups = await ctx.router.perDatabase(
      projectRows,
      routeInfoOf,
      (db, group) => {
        const wanted = new Map<number, number[]>();
        for (const project of group) {
          const numbers = wantedBy.get(project.id);
          if (numbers !== undefined) wanted.set(project.id, [...numbers]);
        }
        return cardStates(db, wanted);
      },
    );
    for (const group of groups) {
      for (const [key, state] of group) states.set(key, state);
    }

    const changes = await applyVerdicts(system, edges, states);
    recomputed = changes.length;
    await syncBlockerTrash(system, edges, states);
    // Announced through the same path as a live change, so a verdict the
    // sweep repaired is indistinguishable from one a write produced. It has
    // to happen before the pending scan below, or the clearings this half
    // just stamped would be announced a second time by the other half.
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

/**
 * The trash flag, brought back in line with the blockers' own rows.
 *
 * Only the edges that disagree are written. Re-stamping every live edge's
 * `blocker_deleted_at` back to null was one write per project per sweep for
 * nothing: the steady state is that nothing is in the trash, and the flag is
 * only ever read for its null-ness.
 */
async function syncBlockerTrash(
  system: Db,
  edges: BlockRow[],
  states: Map<string, CardState>,
): Promise<void> {
  const trashed: number[] = [];
  const alive: number[] = [];
  for (const edge of edges) {
    const state = states.get(
      cardKey(edge.blockerProjectId, edge.blockerNumber),
    );
    if (state === undefined) continue;
    if (state.deleted === (edge.blockerDeletedAt !== null)) continue;
    (state.deleted ? trashed : alive).push(edge.id);
  }
  for (const slice of chunks(trashed)) {
    await system
      .update(issueBlocks)
      .set({ blockerDeletedAt: new Date() })
      .where(inArray(issueBlocks.id, slice));
  }
  for (const slice of chunks(alive)) {
    await system
      .update(issueBlocks)
      .set({ blockerDeletedAt: null })
      .where(inArray(issueBlocks.id, slice));
  }
}
