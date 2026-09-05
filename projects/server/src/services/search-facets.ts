import type { SearchFacets } from "@todou/shared";
import { SEARCH_FACET_HARNESSES, SEARCH_FACET_SESSIONS } from "@todou/shared";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  specVersions,
} from "../db/project-schema.ts";
import { requireProject, routeInfoOf } from "./access.ts";
import { live } from "./trash.ts";

/** One table that records who wrote a row, and how to reach its card. */
type Source = {
  table: typeof comments | typeof issueEvents | typeof specVersions;
  agentContext: AnyPgColumn;
  issueId: AnyPgColumn;
  createdAt: AnyPgColumn;
};

const SOURCES: Source[] = [
  {
    table: comments,
    agentContext: comments.agentContext,
    issueId: comments.issueId,
    createdAt: comments.createdAt,
  },
  {
    table: issueEvents,
    agentContext: issueEvents.agentContext,
    issueId: issueEvents.issueId,
    createdAt: issueEvents.createdAt,
  },
  {
    table: specVersions,
    agentContext: specVersions.agentContext,
    issueId: specVersions.issueId,
    createdAt: specVersions.createdAt,
  },
];

/** The same visibility search has: a trashed card takes its writes with it. */
const visible = (projectId: number): SQL =>
  and(eq(issues.projectId, projectId), live) as SQL;

/**
 * `max(created_at)` at postgres's full microsecond precision — the driver's
 * Dates hold only milliseconds, and this is the same text form `timeline.ts`
 * builds its cursors from.
 */
const lastSeen = (column: AnyPgColumn): SQL<string> =>
  sql<string>`to_char(max(${column}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The values a `harness:`/`session:` completion can offer, aggregated over
 * every table that carries an `agent_context` (T-262).
 *
 * Each source is grouped in the database and the three results merged here.
 * A single UNION would group once, but the three tables have nothing else in
 * common, and the merge is over at most a few hundred rows: `harnesses` is
 * keyed by a handful of agent strings, and `sessions` is cut to the newest
 * `SEARCH_FACET_SESSIONS` per source before it leaves postgres. That cut is
 * exact for the merged answer — a session outside one source's newest fifty
 * is behind fifty sessions there, each of which is at least that recent
 * overall, so it cannot be in the newest fifty overall either.
 */
export async function searchFacets(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<SearchFacets> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db: Db = await ctx.router.forProject(routeInfoOf(project));

  const byAgent = new Map<string | null, number>();
  const bySession = new Map<
    string,
    { agent: string | null; count: number; last_seen: string }
  >();

  for (const source of SOURCES) {
    const where = visible(project.id);

    const agents = await db
      .select({
        agent: sql<string | null>`${source.agentContext} ->> 'agent'`,
        count: sql<number>`count(*)::int`,
      })
      .from(source.table)
      .innerJoin(issues, eq(source.issueId, issues.id))
      .where(where)
      .groupBy(sql`${source.agentContext} ->> 'agent'`);
    for (const row of agents) {
      byAgent.set(row.agent, (byAgent.get(row.agent) ?? 0) + row.count);
    }

    const sessions = await db
      .select({
        session: sql<string>`${source.agentContext} ->> 'session_id'`,
        // No `argmax` in postgres, and a session that switched models mid-run
        // should read as whatever it last called itself.
        agent: sql<
          string | null
        >`(array_agg(${source.agentContext} ->> 'agent' order by ${source.createdAt} desc))[1]`,
        count: sql<number>`count(*)::int`,
        lastSeen: lastSeen(source.createdAt),
      })
      .from(source.table)
      .innerJoin(issues, eq(source.issueId, issues.id))
      // An empty reported session says nothing, so it is not a session — the
      // same reading `timeline.ts` and the `session:` qualifier both take.
      .where(
        and(
          where,
          sql`nullif(${source.agentContext} ->> 'session_id', '') is not null`,
        ),
      )
      .groupBy(sql`${source.agentContext} ->> 'session_id'`)
      .orderBy(sql`max(${source.createdAt}) desc`)
      .limit(SEARCH_FACET_SESSIONS);
    for (const row of sessions) {
      const seen = bySession.get(row.session);
      if (seen === undefined) {
        bySession.set(row.session, {
          agent: row.agent,
          count: row.count,
          last_seen: row.lastSeen,
        });
        continue;
      }
      seen.count += row.count;
      if (row.lastSeen > seen.last_seen) {
        seen.last_seen = row.lastSeen;
        seen.agent = row.agent;
      }
    }
  }

  return {
    harnesses: [...byAgent]
      .map(([agent, count]) => ({ agent, count }))
      .sort(
        (a, b) =>
          b.count - a.count || (a.agent ?? "").localeCompare(b.agent ?? ""),
      )
      .slice(0, SEARCH_FACET_HARNESSES),
    sessions: [...bySession]
      .map(([session_id, rest]) => ({ session_id, ...rest }))
      .sort((a, b) =>
        a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0,
      )
      .slice(0, SEARCH_FACET_SESSIONS),
  };
}
