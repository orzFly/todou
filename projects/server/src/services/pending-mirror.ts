import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { AppContext } from "../bootstrap.ts";
import { pendingPrefixMirrors, projects } from "../db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";
import {
  type MirrorGroupOutcome,
  mirrorPrefixGaps,
  writeMirrorGaps,
} from "./reference-directory.ts";

/**
 * Record that this project's prefix mirror may be about to fall behind
 * (T-511). Called immediately before an authoritative write to a project's
 * own database whose derived row lands in the system database, so that a
 * crash between the two leaves something behind that names the hole.
 *
 * Never call this from inside a `db.transaction` callback: it takes the
 * system handle, and on PGlite a second handle taken inside an open
 * transaction waits on that transaction's own mutex and never returns.
 */
export async function markPendingMirror(
  ctx: AppContext,
  project: ProjectRow,
): Promise<void> {
  // The predicate lives here rather than at the call sites, which all happen
  // to be on a not-colocated branch already: "colocated projects are never
  // marked" is an invariant of this table, and the next caller should not
  // have to rediscover why. Colocated means both rows commit together, so
  // there is no window to name. The test is per project, not
  // `placement === "shared"`: a pinned project under shared placement still
  // resolves to a database of its own.
  if (ctx.router.sharesSystemDatabase(routeInfoOf(project))) return;
  await ctx.router
    .system()
    .insert(pendingPrefixMirrors)
    .values({ projectId: project.id })
    .onConflictDoUpdate({
      target: pendingPrefixMirrors.projectId,
      // Only the generation moves. Resetting the backoff would let a project
      // written to in a tight loop keep clearing its own penalty, and
      // first_marked_at has to stay put to answer "how long has this hole
      // been open".
      set: { generation: sql`${pendingPrefixMirrors.generation} + 1` },
    });
}

/**
 * How many marks one tick will look at. Not a correctness bound — whatever is
 * left over is simply due again next tick — but an upper bound on the work a
 * single tick can be made to do by a bulk prefix change or by one project
 * database that stayed unreachable long enough to build a backlog.
 */
const MIRROR_CLAIM_LIMIT = 200;

/**
 * How long after a clean first pass the confirming pass may run. The two-pass
 * delete rests on one assumption — that a request's "mark, then commit the
 * authoritative row" window is shorter than the gap between the two passes —
 * and this constant is that assumption written down where it can be tuned,
 * rather than left implicit in the tick interval.
 */
const CONFIRM_AFTER_MS = 5 * 60 * 1000;

/** Claims past this many failures are loud, once per attempt rather than per tick. */
const NOISY_AFTER_ATTEMPTS = 10;

export type DrainResult = {
  claimed: number;
  repaired: number;
  confirmed: number;
  deleted: number;
  failed: number;
};

type Claim = {
  projectId: number;
  generation: number;
  verifiedGeneration: number;
  attempts: number;
};

/**
 * Check the marked projects' mirrors and clear the marks that survive two
 * clean passes (T-511).
 *
 * `now` is a parameter, following `sweepAuthRows`, so that the backoff and
 * the two-pass confirmation are testable without waiting an hour.
 *
 * This never opens a database handle of its own: everything goes through
 * `mirrorPrefixGaps` → `perDatabase` → the public `forProject`, which is what
 * keeps the concurrency bound in one place.
 */
export async function drainPendingMirrors(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<DrainResult> {
  const system = ctx.router.system();
  const empty: DrainResult = {
    claimed: 0,
    repaired: 0,
    confirmed: 0,
    deleted: 0,
    failed: 0,
  };

  const due = system
    .select({ projectId: pendingPrefixMirrors.projectId })
    .from(pendingPrefixMirrors)
    .where(lte(pendingPrefixMirrors.nextAttemptAt, now))
    .orderBy(asc(pendingPrefixMirrors.nextAttemptAt))
    .limit(MIRROR_CLAIM_LIMIT);

  // A conditional UPDATE rather than the row lease `sweepMoves` takes. That
  // lease guards a row private to one move, which no request path ever
  // touches; a pending row is shared with every `markPendingMirror`, so
  // holding it locked across a cross-database reconcile would queue that
  // project's format writes behind us — and on PGlite, whose single
  // connection is the whole process, behind every other system query too.
  // Re-testing `next_attempt_at` in the outer UPDATE is enough: a second
  // drainer's identical UPDATE blocks until this one commits and then, under
  // READ COMMITTED, re-reads the predicate.
  const claims: Claim[] = await system
    .update(pendingPrefixMirrors)
    .set({
      attempts: sql`${pendingPrefixMirrors.attempts} + 1`,
      nextAttemptAt: sql`${now}::timestamptz + least(interval '1 hour', interval '5 minutes' * (${pendingPrefixMirrors.attempts} + 1))`,
    })
    .where(
      and(
        inArray(pendingPrefixMirrors.projectId, due),
        lte(pendingPrefixMirrors.nextAttemptAt, now),
      ),
    )
    .returning({
      projectId: pendingPrefixMirrors.projectId,
      generation: pendingPrefixMirrors.generation,
      verifiedGeneration: pendingPrefixMirrors.verifiedGeneration,
      attempts: pendingPrefixMirrors.attempts,
    });
  if (claims.length === 0) return empty;

  const rows = await system
    .select()
    .from(projects)
    .where(
      inArray(
        projects.id,
        claims.map((claim) => claim.projectId),
      ),
    );
  const known = new Map(rows.map((row) => [row.id, row]));

  const outcomes = await mirrorPrefixGaps(ctx, rows);
  const repaired = await writeMirrorGaps(ctx, outcomes);
  const errorByProject = failuresByProject(outcomes);

  // Clean claims split by whether they have already survived one pass. The
  // first clean pass may only raise `verified_generation`: a mark commits
  // before the write it guards does, so a pass that finds nothing missing
  // may simply have read before that write landed.
  const confirming: Claim[] = [];
  const deleting: Claim[] = [];
  const failing: Claim[] = [];
  for (const claim of claims) {
    if (!known.has(claim.projectId)) continue;
    if (errorByProject.has(claim.projectId)) failing.push(claim);
    else if (claim.verifiedGeneration === claim.generation) {
      deleting.push(claim);
    } else confirming.push(claim);
  }

  await ctx.testHooks?.beforeMirrorStep?.("unmark");

  let deleted = 0;
  if (deleting.length > 0) {
    const gone = await system
      .delete(pendingPrefixMirrors)
      .where(
        or(
          ...deleting.map((claim) =>
            and(
              eq(pendingPrefixMirrors.projectId, claim.projectId),
              eq(pendingPrefixMirrors.generation, claim.generation),
              eq(pendingPrefixMirrors.verifiedGeneration, claim.generation),
            ),
          ),
        ),
      )
      .returning({ projectId: pendingPrefixMirrors.projectId });
    deleted = gone.length;
    // A delete that matched nothing is not a failure: somebody marked the
    // project again while we were checking it, so the row we would have
    // removed describes a window we never looked at. Clearing the backoff
    // matters — without it the busiest projects would climb to the one-hour
    // ceiling by succeeding.
    const missed = deleting.filter(
      (claim) => !gone.some((row) => row.projectId === claim.projectId),
    );
    if (missed.length > 0) {
      await system
        .update(pendingPrefixMirrors)
        .set({ attempts: 0, nextAttemptAt: now })
        .where(
          inArray(
            pendingPrefixMirrors.projectId,
            missed.map((claim) => claim.projectId),
          ),
        );
    }
  }

  if (confirming.length > 0) {
    await system
      .update(pendingPrefixMirrors)
      .set({
        // The column, not the literal we read: the guard below has already
        // pinned the generation, so this cannot promote a newer mark.
        verifiedGeneration: sql`${pendingPrefixMirrors.generation}`,
        attempts: 0,
        nextAttemptAt: new Date(now.getTime() + CONFIRM_AFTER_MS),
      })
      .where(
        or(
          ...confirming.map((claim) =>
            and(
              eq(pendingPrefixMirrors.projectId, claim.projectId),
              eq(pendingPrefixMirrors.generation, claim.generation),
            ),
          ),
        ),
      );
  }

  if (failing.length > 0) {
    // attempts and the backoff were already moved by the claim; only the
    // diagnosis is left. A mark is never dropped after N attempts — dropping
    // it would be quietly abandoning a real inconsistency.
    await system
      .update(pendingPrefixMirrors)
      .set({
        lastError: sql`case ${sqlErrorCases(failing, errorByProject)} end`,
      })
      .where(
        inArray(
          pendingPrefixMirrors.projectId,
          failing.map((claim) => claim.projectId),
        ),
      );
    for (const claim of failing) {
      if (claim.attempts + 1 > NOISY_AFTER_ATTEMPTS) {
        console.warn(
          `housekeeping: project ${claim.projectId} mirror still unreconciled ` +
            `after ${claim.attempts + 1} attempts: ` +
            `${errorByProject.get(claim.projectId)}`,
        );
      }
    }
  }

  return {
    claimed: claims.length,
    repaired,
    confirmed: confirming.length,
    deleted,
    failed: failing.length,
  };
}

/** Every project in a group that threw, mapped to that group's message. */
function failuresByProject(
  outcomes: readonly MirrorGroupOutcome[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (const outcome of outcomes) {
    if (outcome.error === undefined) continue;
    const message =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    for (const project of outcome.projects) out.set(project.id, message);
  }
  return out;
}

/** The per-project arms of the one UPDATE that records this tick's errors. */
function sqlErrorCases(
  failing: readonly Claim[],
  errors: ReadonlyMap<number, string>,
) {
  return sql.join(
    failing.map(
      (claim) =>
        sql`when ${pendingPrefixMirrors.projectId} = ${claim.projectId} then ${errors.get(claim.projectId) ?? "unknown"}`,
    ),
    sql` `,
  );
}
