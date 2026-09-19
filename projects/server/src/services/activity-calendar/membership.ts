import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

export type ActivityEvidenceSource = "events" | "comments" | "revisions";

/** moving_since is still readable; moved_at is the permanent tombstone. */
export function activityLiveCandidatePredicate(columns: {
  deletedAt: SQLWrapper;
  movedAt: SQLWrapper;
}): SQL {
  return sql`(${columns.deletedAt} IS NULL AND ${columns.movedAt} IS NULL)`;
}

const member = (value: SQLWrapper, key: string) => sql`(${value} -> ${key})`;

function validId(value: SQLWrapper): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'number' THEN
    (${value} #>> '{}')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((${value} #>> '{}')::numeric) = (${value} #>> '{}')::numeric
    ELSE false END)`;
}

/** Safe even when the surrounding boolean expression is reordered by SQL. */
function numericId(value: SQLWrapper): SQL {
  return sql`(CASE WHEN ${validId(value)} THEN (${value} #>> '{}')::numeric::bigint ELSE NULL END)`;
}

/**
 * Validate all three fields together. Missing, JSON null, and numeric maxima
 * have distinct meanings; malformed/future manifests never fall back to old
 * timestamp rules. An explicit null source means that no rows were copied.
 */
export function activityImportManifestPredicate(payload: SQLWrapper): SQL {
  const manifest = member(payload, "activity_imported_max_ids");
  return sql`COALESCE((jsonb_typeof(${manifest}) = 'object'
    AND ${member(manifest, "v")} = '1'::jsonb
    AND ${sql.join(
      (["events", "comments", "revisions"] as const).map((source) => {
        const value = member(manifest, source);
        return sql`(${value} = 'null'::jsonb OR ${validId(value)})`;
      }),
      sql` AND `,
    )}), false)`;
}

/**
 * The caller batch-prefetches system issue_moves OUTSIDE the project snapshot.
 * Preserve finished_at as microsecond timestamptz text, never a JS Date. Join
 * the batch to the snapshot's latest moved_in token + destination address.
 * Snapshot/token changes require the caller's bounded retry/conflict protocol.
 */
export function activityLegacyRevisionBoundaryPredicate(
  move: {
    moveToken: SQLWrapper;
    toProjectId: SQLWrapper;
    toNumber: SQLWrapper;
    state: SQLWrapper;
    finishedAt: SQLWrapper;
  },
  target: {
    moveToken: SQLWrapper;
    projectId: SQLWrapper;
    number: SQLWrapper;
  },
): SQL {
  return sql`(${move.moveToken} = ${target.moveToken}
    AND ${move.toProjectId} = ${target.projectId}
    AND ${move.toNumber} = ${target.number}
    AND ${move.state} = 'done' AND ${move.finishedAt} IS NOT NULL)`;
}

export type ActivityMembershipColumns = {
  source: ActivityEvidenceSource;
  id: SQLWrapper;
  createdAt: SQLWrapper;
  issueCreatedAt: SQLWrapper;
  /** Latest moved_in by MAX(event.id), never MAX(created_at). */
  latestMovedInId: SQLWrapper;
  latestMovedInPayload: SQLWrapper;
  /** Verified by token + target project/number + done; SQL NULL if unavailable. */
  legacyRevisionFinishedAt: SQLWrapper;
};

/**
 * Apply alongside activityLiveCandidatePredicate to the common evidence CTE.
 * All timestamps stay in SQL at PostgreSQL microsecond precision. Imported
 * evidence can have the same timestamp as new work: table-local ids decide.
 * This emits no query and performs no per-card database access.
 */
export function activityMembershipPredicate(c: ActivityMembershipColumns): SQL {
  const payload = c.latestMovedInPayload;
  const manifest = member(payload, "activity_imported_max_ids");
  const watermark = member(manifest, c.source);
  const newBoundary =
    c.source === "events"
      ? sql`${c.id} > GREATEST(${c.latestMovedInId}, ${numericId(watermark)})`
      : sql`(${watermark} = 'null'::jsonb OR ${c.id} > ${numericId(watermark)})`;

  let oldBoundary: SQL;
  if (c.source === "events") {
    oldBoundary = sql`${c.id} > ${c.latestMovedInId}`;
  } else if (c.source === "comments") {
    const map = member(member(payload, "id_map"), "comments");
    const safeMap = sql`(CASE WHEN jsonb_typeof(${map}) = 'object'
      THEN ${map} ELSE '{}'::jsonb END)`;
    // id_map is source id -> TARGET id. An empty object certifies no imported
    // comments; a missing object cannot make that promise.
    oldBoundary = sql`(jsonb_typeof(${map}) = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(${safeMap}) AS activity_map(key, value)
        WHERE activity_map.key !~ '^[1-9][0-9]*$'
          OR (${validId(sql`activity_map.value`)}) IS NOT TRUE
      )
      AND ${c.id} > COALESCE((
        SELECT MAX(${numericId(sql`activity_map.value`)})
        FROM jsonb_each(${safeMap}) AS activity_map(key, value)
      ), 0))`;
  } else {
    // Conservative fallback intentionally excludes the copy->done window.
    oldBoundary = sql`(${c.legacyRevisionFinishedAt} IS NOT NULL
      AND ${c.createdAt} > (${c.legacyRevisionFinishedAt})::timestamptz)`;
  }

  return sql`COALESCE((CASE
    WHEN ${c.latestMovedInId} IS NULL THEN ${c.createdAt} >= ${c.issueCreatedAt}
    WHEN jsonb_typeof(${payload}) <> 'object' OR ${payload} IS NULL THEN false
    WHEN ${payload} ? 'activity_imported_max_ids' THEN
      ${activityImportManifestPredicate(payload)} AND ${newBoundary}
    ELSE ${oldBoundary}
  END), false)`;
}
