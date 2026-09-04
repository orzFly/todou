import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  ChangeEvent,
  MoveIssueInput,
  MoveIssueResult,
} from "@todou/shared";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { UserRow } from "../../auth/pat.ts";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  projectMeta,
} from "../../db/project-schema.ts";
import {
  issueAddresses,
  issueMoves,
  projects,
} from "../../db/system-schema.ts";
import { IssueMovingError } from "../../errors.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "../access.ts";
import { analyzeReferences, loadReferenceInputs } from "../cross-references.ts";
import { getIssue } from "../issues.ts";
import { lineageOf, recordAliases, registerMove } from "../relocation.ts";
import { clearIssueChildren, copyIssueTree, type IdMap } from "./copy.ts";
import {
  loadSlugResolver,
  type MoveContext,
  normalizeOwnEvents,
  normalizeReferencesTo,
  normalizeThirdParties,
} from "./normalize.ts";
import { type MovePlan, planMove } from "./plan.ts";

/**
 * Move an issue to another project.
 *
 * Everything that can refuse the move happens in `planMove`, before a single
 * row is written — which is what lets `dry_run` promise that its preview is
 * what will actually happen.
 */
export async function moveIssue(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  input: MoveIssueInput,
  agentContext: AgentContext | null = null,
): Promise<MoveIssueResult> {
  const plan = await planMove(ctx, actor, slug, number, input.to_project);
  const mapping = {
    status: { from: plan.status.from.name, to: plan.status.to.name },
    dropped_labels: plan.dropped.labels,
    dropped_assignees: plan.dropped.assignees,
  };

  if (input.dry_run) {
    return {
      moved_to: { slug: plan.target.project.slug, number: plan.reinhabit },
      reinhabited: plan.reinhabit !== null,
      mapping,
      issue: null,
    };
  }

  const landed =
    plan.sameProjectDb && plan.systemColocated
      ? await moveWithinDb(ctx, actor, plan, agentContext)
      : await moveAcrossDbs(ctx, actor, plan, agentContext);

  await afterCommit(ctx, actor, plan, landed);

  return {
    moved_to: { slug: plan.target.project.slug, number: landed.number },
    reinhabited: plan.reinhabit !== null,
    mapping,
    // Re-read rather than assembled here, so the response goes through the
    // same redaction every other read of this card does.
    issue: await getIssue(ctx, actor, plan.target.project.slug, landed.number),
  };
}

type SlugLookup = Awaited<ReturnType<typeof loadSlugResolver>>;

export type Landed = {
  number: number;
  issueId: number;
  idMap: IdMap;
  movedOutEventId: number | undefined;
  movedInEventId: number | undefined;
  tombstoneId: number;
};

/**
 * Both projects and the system tables share one database, so the whole move
 * is one transaction: no intermediate state is ever observable, and there is
 * nothing for the recovery sweep to find.
 */
async function moveWithinDb(
  ctx: AppContext,
  actor: UserRow,
  plan: MovePlan,
  agentContext: AgentContext | null,
): Promise<Landed> {
  const db = plan.source.db;
  const resolver = await loadSlugResolver(ctx);
  const moveToken = randomUUID();

  return db.transaction(async (tx) => {
    // Pins the row for the whole move. Reference recording takes a share
    // lock on the same row (see recordReferences), so an event cannot land
    // on the card between the copy and the cleanup that would delete it.
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, plan.row.id))
      .for("update");

    const number =
      plan.reinhabit ?? (await nextNumber(tx, plan.target.project.id));
    // The system tables are in this database too — that is what
    // `systemColocated` means — so they join the transaction through `tx`.
    // Reaching for `router.system()` here would take a second connection and
    // block on the row this transaction has already locked.
    const lineage = await registerMove(tx, {
      lineage: plan.lineage,
      from: { projectId: plan.source.project.id, number: plan.row.number },
      to: { projectId: plan.target.project.id, number },
    });
    const idMap = await copyIssueTree(tx, tx, plan, {
      number,
      reinhabit: plan.reinhabit !== null,
    });

    const move = moveContext(plan, number, idMap, resolver);
    await normalizeOwnEvents(
      tx,
      {
        projectId: plan.target.project.id,
        issueId: idMap.issueId,
        writtenUnder: plan.source.project.id,
      },
      move,
    );
    await normalizeReferencesTo(
      tx,
      {
        projectId: plan.target.project.id,
        oldNumber: plan.row.number,
        attributedTo: plan.source.project.id,
        exceptIssueId: idMap.issueId,
      },
      move,
    );

    const movedInEventId = await writeMovedIn(
      tx,
      plan,
      { number, issueId: idMap.issueId },
      idMap,
      moveToken,
      actor,
      agentContext,
      lineage,
    );

    await clearIssueChildren(tx, plan.row.id);
    await raiseTombstone(tx, plan);
    const movedOutEventId = await writeMovedOut(
      tx,
      plan,
      number,
      moveToken,
      actor,
      agentContext,
    );
    await normalizeReferencesTo(
      tx,
      {
        projectId: plan.source.project.id,
        oldNumber: plan.row.number,
        attributedTo: plan.source.project.id,
        exceptIssueId: plan.row.id,
      },
      move,
    );

    await recordAllAliases(tx, plan, idMap);
    await tx.insert(issueMoves).values({
      lineage,
      moveToken,
      fromProjectId: plan.source.project.id,
      fromNumber: plan.row.number,
      toProjectId: plan.target.project.id,
      toNumber: number,
      actorId: actor.id,
      movedAt: plan.movedAt,
      state: "done",
      finishedAt: new Date(),
    });

    return {
      number,
      issueId: idMap.issueId,
      idMap,
      movedOutEventId,
      movedInEventId,
      tombstoneId: plan.row.id,
    };
  });
}

/**
 * Two databases, so no transaction covers the whole move. The registration
 * row in `issue_moves` is the coordinator instead: its `state` is the only
 * truth about how far the move got, and every step is replayable, so a
 * crash anywhere is finished by `sweepMoves` rather than left half-done.
 *
 * Step 4 is the commit point — before it the card is still at its old
 * address, after it every link resolves to the new one.
 */
async function moveAcrossDbs(
  ctx: AppContext,
  actor: UserRow,
  plan: MovePlan,
  agentContext: AgentContext | null,
): Promise<Landed> {
  const system = ctx.router.system();
  const moveToken = randomUUID();
  const step = async (n: 1 | 2 | 3 | 4 | 5 | 6) =>
    ctx.testHooks?.afterMoveStep?.(n);

  // 1. Register, so a crash from here on is something the sweep can find.
  await system.insert(issueMoves).values({
    lineage: plan.lineage,
    moveToken,
    fromProjectId: plan.source.project.id,
    fromNumber: plan.row.number,
    toProjectId: plan.target.project.id,
    actorId: actor.id,
    movedAt: plan.movedAt,
    state: "copying",
  });
  await step(1);

  // 2. Freeze the source. Reads carry on; writes get a 409 until this ends.
  const frozen = await plan.source.db
    .update(issues)
    .set({ movingSince: plan.movedAt })
    .where(
      and(
        eq(issues.id, plan.row.id),
        isNull(issues.movingSince),
        isNull(issues.movedAt),
      ),
    )
    .returning({ id: issues.id });
  if (frozen.length === 0) {
    // Another move got there first. The registration row has to go before
    // the 409, or the sweep would later thaw a freeze that is not ours.
    await system.delete(issueMoves).where(eq(issueMoves.moveToken, moveToken));
    throw new IssueMovingError();
  }
  await step(2);

  // 3. The whole copy, in one transaction in the destination.
  const copied = await copyInDestination(
    ctx,
    plan,
    actor,
    agentContext,
    moveToken,
  );
  await step(3);

  // 4. Publish it: the address book and the aliases. Commit point.
  await finishCopying(ctx, plan, copied, moveToken);
  await step(4);

  // 5. Empty the source and raise the tombstone.
  await retireSource(ctx, plan, copied, moveToken, actor, agentContext);
  await step(5);

  // 6. Nothing left for the sweep to do.
  await markDone(system, moveToken);
  await step(6);

  return {
    number: copied.number,
    issueId: copied.idMap.issueId,
    idMap: copied.idMap,
    movedOutEventId: undefined,
    movedInEventId: copied.movedInEventId,
    tombstoneId: plan.row.id,
  };
}

type Copied = {
  number: number;
  idMap: IdMap;
  movedInEventId: number | undefined;
};

async function copyInDestination(
  ctx: AppContext,
  plan: MovePlan,
  actor: UserRow,
  agentContext: AgentContext | null,
  moveToken: string,
): Promise<Copied> {
  const resolver = await loadSlugResolver(ctx);
  const lineage =
    plan.lineage ??
    // Minted here rather than at step 4 because the `moved_in` payload
    // carries it, and that event is written inside this transaction.
    (await registerLineageOnly(ctx, plan));

  return plan.target.db.transaction(async (tx) => {
    const number =
      plan.reinhabit ?? (await nextNumber(tx, plan.target.project.id));
    // When both projects live in one database the source has to be read
    // through this transaction as well. Reaching for the outer handle would
    // block on the transaction that is waiting for the read — and it is the
    // same database, so the source attachment delete belongs in here anyway.
    const src = plan.sameProjectDb ? tx : plan.source.db;
    const idMap = await copyIssueTree(src, tx, plan, {
      number,
      reinhabit: plan.reinhabit !== null,
    });
    const move = moveContext(plan, number, idMap, resolver);
    await normalizeOwnEvents(
      tx,
      {
        projectId: plan.target.project.id,
        issueId: idMap.issueId,
        writtenUnder: plan.source.project.id,
      },
      move,
    );
    await normalizeReferencesTo(
      tx,
      {
        projectId: plan.target.project.id,
        oldNumber: plan.row.number,
        attributedTo: plan.source.project.id,
        exceptIssueId: idMap.issueId,
      },
      move,
    );
    const movedInEventId = await writeMovedIn(
      tx,
      plan,
      { number, issueId: idMap.issueId },
      idMap,
      moveToken,
      actor,
      agentContext,
      lineage,
    );
    return { number, idMap, movedInEventId };
  });
}

/**
 * The lineage alone, without flattening anything onto an address that does
 * not exist yet — step 4 does that once the copy has actually landed.
 */
async function registerLineageOnly(
  ctx: AppContext,
  plan: MovePlan,
): Promise<number> {
  const system = ctx.router.system();
  const existing = await lineageOf(
    system,
    plan.source.project.id,
    plan.row.number,
  );
  if (existing !== null) return existing;
  const inserted = await system
    .insert(issueAddresses)
    .values({
      lineage: 0,
      projectId: plan.source.project.id,
      number: plan.row.number,
      currentProjectId: plan.source.project.id,
      currentNumber: plan.row.number,
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

/** Step 4: the redirects start working here. */
async function finishCopying(
  ctx: AppContext,
  plan: MovePlan,
  copied: Copied,
  moveToken: string,
  // The sweep replays this step while holding a lease on the registration
  // row, and that lease is a transaction — so its writes have to go through
  // the same handle or they would queue behind the lock it already holds.
  system: Db = ctx.router.system(),
): Promise<void> {
  await registerMove(system, {
    lineage: plan.lineage,
    from: { projectId: plan.source.project.id, number: plan.row.number },
    to: { projectId: plan.target.project.id, number: copied.number },
  });
  await recordAllAliases(system, plan, copied.idMap);
  await system
    .update(issueMoves)
    .set({ state: "copied", toNumber: copied.number })
    .where(eq(issueMoves.moveToken, moveToken));
}

/** Step 5: replayable, because the sweep may run it again. */
async function retireSource(
  ctx: AppContext,
  plan: MovePlan,
  copied: Copied,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
  /** The sweep passes its own: loading one reads the system tables, and it
   * calls this while holding a transaction open on them. */
  resolver?: SlugLookup,
): Promise<void> {
  const move = moveContext(
    plan,
    copied.number,
    copied.idMap,
    resolver ?? (await loadSlugResolver(ctx)),
  );
  await plan.source.db.transaction(async (tx) => {
    await clearIssueChildren(tx, plan.row.id);
    await raiseTombstone(tx, plan);
    // `move_token` carries no unique index, and this step is replayed, so
    // the guard is what keeps the source's one remaining trace from
    // becoming two.
    await tx.execute(sql`
      insert into issue_events
        (project_id, issue_id, actor_id, type, payload, agent_context,
         created_at)
      select ${plan.source.project.id}, ${plan.row.id}, ${actor.id},
             'moved_out', ${JSON.stringify({
               move_token: moveToken,
               to_project_id: plan.target.project.id,
               to_project: plan.target.project.slug,
               to_number: copied.number,
             })}::jsonb,
             ${agentContext === null ? null : JSON.stringify(agentContext)}::jsonb,
             ${plan.movedAt.toISOString()}::timestamptz
      where not exists (
        select 1 from issue_events
        where issue_id = ${plan.row.id}
          and type = 'moved_out'
          and payload ->> 'move_token' = ${moveToken}
      )
    `);
    await normalizeReferencesTo(
      tx,
      {
        projectId: plan.source.project.id,
        oldNumber: plan.row.number,
        attributedTo: plan.source.project.id,
        exceptIssueId: plan.row.id,
      },
      move,
    );
  });
}

async function markDone(system: Db, moveToken: string): Promise<void> {
  await system
    .update(issueMoves)
    .set({ state: "done", finishedAt: new Date() })
    .where(eq(issueMoves.moveToken, moveToken));
}

/**
 * Drive every unfinished cross-database move to a conclusion.
 *
 * Safe to run concurrently from several instances and safe to replay, which
 * `housekeeping.ts` requires of everything it sweeps. Three things buy that:
 * the row lease below, the `NOT EXISTS` guard on `moved_out`, and thawing a
 * freeze only when it still carries this row's own `moved_at`.
 */
export async function sweepMoves(ctx: AppContext): Promise<number> {
  const system = ctx.router.system();
  const pending = await system
    .select()
    .from(issueMoves)
    .where(ne(issueMoves.state, "done"));
  let finished = 0;
  if (pending.length === 0) return finished;
  // Read before the lease is taken: recovery needs it, and it reads the
  // very tables the lease holds a transaction open on.
  const resolver = await loadSlugResolver(ctx);

  for (const row of pending) {
    try {
      // The lease has to span the recovery, not just the SELECT that takes
      // it: a row lock acquired outside a transaction is released the
      // moment that statement returns, which would leave a second instance
      // free to replay step 5 alongside this one — and `moved_out` carries
      // no unique index, so its NOT EXISTS guard is not a race the database
      // arbitrates on its own.
      const recovered = await system.transaction(async (tx) => {
        const leased = await tx
          .select({ id: issueMoves.id })
          .from(issueMoves)
          .where(and(eq(issueMoves.id, row.id), ne(issueMoves.state, "done")))
          .for("update", { skipLocked: true });
        if (leased.length === 0) return false;
        return recoverOne(ctx, tx, row, resolver);
      });
      if (recovered) finished += 1;
    } catch (err) {
      console.error(`recovering move ${row.moveToken} failed`, err);
    }
  }
  return finished;
}

async function recoverOne(
  ctx: AppContext,
  /** The lease's transaction: every system-tier read and write uses it. */
  system: Db,
  row: typeof issueMoves.$inferSelect,
  resolver: SlugLookup,
): Promise<boolean> {
  const source = await projectRowById(system, row.fromProjectId);
  const target = await projectRowById(system, row.toProjectId);
  if (source === undefined || target === undefined) return false;

  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const targetDb = await ctx.router.forProject(routeInfoOf(target));
  const landedEvent = await findMovedIn(targetDb, target.id, row.moveToken);

  if (row.state === "copying" && landedEvent === null) {
    // The copy never landed: unfreeze the source and forget the move. The
    // `moving_since` check is what stops this from thawing a later attempt
    // that has since frozen the same card.
    await sourceDb
      .update(issues)
      .set({ movingSince: null })
      .where(
        and(
          eq(issues.projectId, source.id),
          eq(issues.number, row.fromNumber),
          eq(issues.movingSince, row.movedAt),
        ),
      );
    await system.delete(issueMoves).where(eq(issueMoves.id, row.id));
    return true;
  }
  if (landedEvent === null) return false;

  const sourceRow = await sourceDb
    .select()
    .from(issues)
    .where(
      and(eq(issues.projectId, source.id), eq(issues.number, row.fromNumber)),
    );
  const issueRow = sourceRow[0];
  if (issueRow === undefined) return false;

  const plan = await replanFromRow(ctx, row, source, target, issueRow);
  const copied: Copied = {
    number: landedEvent.number,
    idMap: landedEvent.idMap,
    movedInEventId: undefined,
  };
  if (row.state === "copying") {
    await finishCopying(ctx, plan, copied, row.moveToken, system);
  }
  await retireSource(
    ctx,
    plan,
    copied,
    row.moveToken,
    { id: row.actorId } as UserRow,
    null,
    resolver,
  );
  await markDone(system, row.moveToken);
  return true;
}

/** The copy's own record of itself: its number and its id map. */
async function findMovedIn(
  db: Db,
  projectId: number,
  moveToken: string,
): Promise<{ number: number; idMap: IdMap } | null> {
  const rows = await db
    .select({
      issueId: issueEvents.issueId,
      payload: issueEvents.payload,
      number: issues.number,
    })
    .from(issueEvents)
    .innerJoin(issues, eq(issueEvents.issueId, issues.id))
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "moved_in"),
        sql`${issueEvents.payload} ->> 'move_token' = ${moveToken}`,
      ),
    );
  const row = rows[0];
  if (row === undefined) return null;
  const payload = row.payload as {
    id_map?: {
      comments?: Record<string, number>;
      attachments?: Record<string, number>;
    };
  };
  const toMap = (raw: Record<string, number> | undefined) =>
    new Map(Object.entries(raw ?? {}).map(([k, v]) => [Number(k), v]));
  return {
    number: row.number,
    idMap: {
      issueId: row.issueId,
      comments: toMap(payload.id_map?.comments),
      attachments: toMap(payload.id_map?.attachments),
    },
  };
}

/**
 * Enough of a plan to finish a move nobody is holding in memory any more.
 * Only the fields the remaining steps read are filled; the mapping decisions
 * were made and applied before the crash.
 */
async function replanFromRow(
  ctx: AppContext,
  row: typeof issueMoves.$inferSelect,
  source: ProjectRow,
  target: ProjectRow,
  issueRow: typeof issues.$inferSelect,
): Promise<MovePlan> {
  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const targetDb = await ctx.router.forProject(routeInfoOf(target));
  const sourceUrl = ctx.router.resolveProjectUrl(routeInfoOf(source));
  const targetUrl = ctx.router.resolveProjectUrl(routeInfoOf(target));
  const placeholder = {
    id: issueRow.statusId,
    name: "",
    category: "open" as const,
    color: "#000000",
    position: 0,
    isDefault: false,
    projectId: source.id,
  };
  return {
    source: { project: source, db: sourceDb },
    target: { project: target, db: targetDb },
    row: issueRow,
    status: { from: placeholder, to: placeholder },
    labelIds: [],
    assigneeIds: [],
    dropped: { labels: [], assignees: [] },
    reinhabit: row.toNumber,
    lineage: row.lineage,
    movedAt: row.movedAt,
    sameProjectDb: sourceUrl === targetUrl,
    systemColocated: false,
  };
}

async function projectRowById(
  system: Db,
  id: number,
): Promise<ProjectRow | undefined> {
  const rows = await system.select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

function moveContext(
  plan: MovePlan,
  number: number,
  idMap: IdMap,
  resolver: {
    slugOf: (id: number) => string | null;
    resolveSlug: (slug: string, at: Date) => number | null;
  },
): MoveContext {
  return {
    landed: plan.target.project.id,
    landedNumber: number,
    slugOf: resolver.slugOf,
    resolveSlug: resolver.resolveSlug,
    commentAlias: (oldId) => idMap.comments.get(oldId) ?? null,
  };
}

async function nextNumber(tx: Db, projectId: number): Promise<number> {
  const meta = await tx
    .update(projectMeta)
    .set({ nextIssueNumber: sql`${projectMeta.nextIssueNumber} + 1` })
    .where(eq(projectMeta.projectId, projectId))
    .returning({ next: projectMeta.nextIssueNumber });
  const next = meta[0]?.next;
  if (next === undefined) throw new Error("project_meta row missing");
  return next - 1;
}

/**
 * The source row, emptied. The title stays: it is what the 410 body and the
 * activity stream's one remaining line have to show.
 */
async function raiseTombstone(tx: Db, plan: MovePlan): Promise<void> {
  await tx
    .update(issues)
    .set({
      movedAt: plan.movedAt,
      movingSince: null,
      body: "",
      openQuestions: 0,
      specVersion: null,
      specReviewStatus: null,
      specUnresolvedComments: 0,
    })
    .where(eq(issues.id, plan.row.id));
}

async function writeMovedIn(
  tx: Db,
  plan: MovePlan,
  landed: { number: number; issueId: number },
  idMap: IdMap,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
  lineage: number,
): Promise<number | undefined> {
  const inserted = await tx
    .insert(issueEvents)
    .values({
      projectId: plan.target.project.id,
      issueId: landed.issueId,
      actorId: actor.id,
      type: "moved_in",
      createdAt: plan.movedAt,
      agentContext,
      payload: {
        move_token: moveToken,
        lineage,
        from_project_id: plan.source.project.id,
        from_project: plan.source.project.slug,
        from_number: plan.row.number,
        status_from: plan.status.from.name,
        status_to: plan.status.to.name,
        dropped_labels: plan.dropped.labels,
        dropped_assignees: plan.dropped.assignees.map((u) => u.login),
        // Server-side only, stripped from every response: across databases
        // this is the sole durable record of which copy became which, and
        // the recovery sweep has nothing else to reconstruct it from.
        id_map: {
          comments: Object.fromEntries(idMap.comments),
          attachments: Object.fromEntries(idMap.attachments),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: explicit created_at
    } as any)
    .returning({ id: issueEvents.id });
  return inserted[0]?.id;
}

async function writeMovedOut(
  tx: Db,
  plan: MovePlan,
  number: number,
  moveToken: string,
  actor: UserRow,
  agentContext: AgentContext | null,
): Promise<number | undefined> {
  const inserted = await tx
    .insert(issueEvents)
    .values({
      projectId: plan.source.project.id,
      issueId: plan.row.id,
      actorId: actor.id,
      type: "moved_out",
      createdAt: plan.movedAt,
      agentContext,
      payload: {
        move_token: moveToken,
        to_project_id: plan.target.project.id,
        to_project: plan.target.project.slug,
        to_number: number,
      },
      // biome-ignore lint/suspicious/noExplicitAny: explicit created_at
    } as any)
    .returning({ id: issueEvents.id });
  return inserted[0]?.id;
}

/** Both alias kinds, from one id map. */
async function recordAllAliases(
  system: Db,
  plan: MovePlan,
  idMap: IdMap,
): Promise<void> {
  for (const [kind, map] of [
    ["comment", idMap.comments],
    ["attachment", idMap.attachments],
  ] as const) {
    await recordAliases(
      system,
      kind,
      [...map].map(([fromId, toId]) => ({ fromId, toId })),
      { projectId: plan.source.project.id },
      { projectId: plan.target.project.id },
    );
  }
}

/** Best-effort work that must not hold the move open: third parties, SSE. */
async function afterCommit(
  ctx: AppContext,
  actor: UserRow,
  plan: MovePlan,
  landed: Landed,
): Promise<void> {
  // The move is already committed, so nothing here may fail it. Throwing
  // would answer a request that succeeded with a 500 — and the caller's
  // only reasonable reaction, retrying, now hits the tombstone's 409.
  try {
    const resolver = await loadSlugResolver(ctx);
    const move = moveContext(plan, landed.number, landed.idMap, resolver);
    await normalizeThirdParties(
      ctx,
      {
        projects: await thirdPartyProjects(ctx, actor, plan, landed),
        oldNumber: plan.row.number,
        attributedTo: plan.source.project.id,
      },
      move,
    );
  } catch (err) {
    console.error("normalizing third-party references after a move", err);
  }

  const events: Array<[number, ChangeEvent]> = [
    [
      plan.source.project.id,
      {
        entity: "issue",
        id: landed.tombstoneId,
        action: "deleted",
        issue_number: plan.row.number,
      },
    ],
    [
      plan.target.project.id,
      {
        entity: "issue",
        id: landed.issueId,
        action: "created",
        issue_number: landed.number,
      },
    ],
  ];
  if (landed.movedOutEventId !== undefined) {
    events.push([
      plan.source.project.id,
      {
        entity: "timeline",
        id: landed.movedOutEventId,
        action: "created",
        issue_number: plan.row.number,
      },
    ]);
  }
  if (landed.movedInEventId !== undefined) {
    events.push([
      plan.target.project.id,
      {
        entity: "timeline",
        id: landed.movedInEventId,
        action: "created",
        issue_number: landed.number,
      },
    ]);
  }
  for (const [projectId, event] of events) ctx.bus.publish(projectId, event);
}

/**
 * The projects whose timelines can hold a reference to this card: the ones
 * its own text points at, since that is what put a `cross_referenced` row
 * there in the first place. Projects the mover cannot read are skipped —
 * they get the redirect instead, which is the fallback all of this has.
 */
async function thirdPartyProjects(
  ctx: AppContext,
  actor: UserRow,
  plan: MovePlan,
  landed: Landed,
): Promise<Array<{ id: number; slug: string; databaseUrl: string | null }>> {
  const db = plan.target.db;
  const inputs = await loadReferenceInputs(ctx, db, plan.target.project.id);
  const texts = [
    { body: plan.row.body, at: plan.row.createdAt },
    ...(await db
      .select({ body: comments.body, at: comments.createdAt })
      .from(comments)
      .where(eq(comments.issueId, landed.issueId))),
  ];

  const slugs = new Set<string>();
  for (const text of texts) {
    const analyzed = await analyzeReferences(
      db,
      inputs,
      plan.target.project,
      text.body,
      text.at,
      { issueNumber: landed.number },
      plan.source.project,
    );
    for (const target of analyzed.cross) slugs.add(target.slug);
  }
  if (slugs.size === 0) return [];

  const readable = await accessibleProjectRows(ctx, actor);
  return readable
    .filter(
      (row) =>
        slugs.has(row.slug) &&
        row.id !== plan.source.project.id &&
        row.id !== plan.target.project.id,
    )
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      databaseUrl: row.databaseUrl,
    }));
}
