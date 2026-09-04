import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import { issueEvents } from "../../db/project-schema.ts";
import { projects, slugHistory } from "../../db/system-schema.ts";
import { routeInfoOf } from "../access.ts";

type Payload = Record<string, unknown>;

/** Where a slug pointed at a given instant; null when nobody held it. */
export type SlugResolver = (slug: string, at: Date) => number | null;

export type RefEvent = {
  type: string;
  payload: Payload;
  createdAt: Date;
  /**
   * The project whose numbering a bare `referenced` on this row means. Not
   * always the database the row sits in: the copies that just landed in the
   * destination were written under the SOURCE project's numbering, and
   * normalizing them is precisely the act of saying so.
   */
  host: number;
};

export type MoveContext = {
  /** Where the moved card now lives, and under which number. */
  landed: number;
  landedNumber: number;
  slugOf: (projectId: number) => string | null;
  resolveSlug: SlugResolver;
  /** A comment on the moved card: old id → new id, null if unchanged. */
  commentAlias: (oldId: number) => number | null;
};

/**
 * Which end of the reference the moved card is on. The two are genuinely
 * different rewrites, not one with a flag: an event on the card's own
 * timeline records who pointed AT it, so nothing about the card appears in
 * the payload; an event on some other card names the moved card by number
 * and comment id, and both of those just changed.
 */
export type Subject = "on-the-card" | "about-the-card";

/**
 * The shape a reference event should have once the card has landed.
 *
 * One rule underneath all four cases in the design: **the far end being in
 * the same project as the card makes it `referenced`, anything else makes it
 * `cross_referenced` carrying `by_project_id`.** Symmetric, so it needs no
 * inverse — a card moving back re-runs it and comes out as it started.
 *
 * Returns null when the event already has that shape, which is what makes
 * replaying a half-finished move safe.
 */
export function classifyRefEvent(
  event: RefEvent,
  subject: Subject,
  ctx: MoveContext,
): { type: string; payload: Payload } | null {
  if (event.type !== "referenced" && event.type !== "cross_referenced") {
    return null;
  }

  const far =
    subject === "about-the-card"
      ? // The far end IS the moved card.
        ctx.landed
      : farSideOf(event);
  if (far === null) return null;

  const payload: Payload =
    subject === "about-the-card"
      ? {
          by_issue: ctx.landedNumber,
          ...aliasedComment(event.payload, ctx),
        }
      : {
          by_issue: event.payload.by_issue,
          // On the card's own timeline `by_comment` names a comment on
          // whichever card did the referencing, which is not moving.
          ...(event.payload.by_comment === undefined
            ? {}
            : { by_comment: event.payload.by_comment }),
        };

  const localTo = subject === "about-the-card" ? event.host : ctx.landed;
  const next =
    far === localTo
      ? { type: "referenced", payload }
      : {
          type: "cross_referenced",
          payload: {
            ...payload,
            by_project_id: far,
            ...(ctx.slugOf(far) === null
              ? {}
              : { by_project: ctx.slugOf(far) as string }),
            by_moved: true,
          },
        };

  return unchanged(event, next) ? null : next;

  function farSideOf(ev: RefEvent): number | null {
    if (ev.type === "referenced") return ev.host;
    const id = ev.payload.by_project_id;
    if (typeof id === "number") return id;
    const slug = ev.payload.by_project;
    // Events written before `by_project_id` existed carry only a slug, which
    // has to be read as of the event's own instant — a slug that has since
    // changed hands would otherwise resolve to its new holder.
    return typeof slug === "string"
      ? ctx.resolveSlug(slug, ev.createdAt)
      : null;
  }
}

function aliasedComment(payload: Payload, ctx: MoveContext): Payload {
  const id = payload.by_comment;
  if (typeof id !== "number") return {};
  return { by_comment: ctx.commentAlias(id) ?? id };
}

function unchanged(
  event: RefEvent,
  next: { type: string; payload: Payload },
): boolean {
  if (event.type !== next.type) return false;
  const keys = new Set([
    ...Object.keys(event.payload),
    ...Object.keys(next.payload),
  ]);
  for (const key of keys) {
    if (event.payload[key] !== next.payload[key]) return false;
  }
  return true;
}

/**
 * Project ids and slugs, resolved as of any instant. Loaded once per move:
 * the rewrites below run over every reference event touching the card, and
 * each of them would otherwise repeat the same two lookups.
 */
export async function loadSlugResolver(ctx: AppContext): Promise<{
  slugOf: (projectId: number) => string | null;
  resolveSlug: SlugResolver;
}> {
  const system = ctx.router.system();
  const rows = await system
    .select({ id: projects.id, slug: projects.slug })
    .from(projects);
  const history = await system
    .select({
      projectId: slugHistory.projectId,
      slug: slugHistory.slug,
      from: slugHistory.effectiveFrom,
    })
    .from(slugHistory);

  const byId = new Map(rows.map((row) => [row.id, row.slug]));
  const claims = new Map<string, Array<{ projectId: number; from: Date }>>();
  for (const row of history) {
    const list = claims.get(row.slug) ?? [];
    list.push({ projectId: row.projectId, from: row.from });
    claims.set(row.slug, list);
  }
  for (const list of claims.values()) {
    list.sort((a, b) => a.from.getTime() - b.from.getTime());
  }

  return {
    slugOf: (projectId) => byId.get(projectId) ?? null,
    resolveSlug: (slug, at) => {
      const list = claims.get(slug);
      if (list !== undefined) {
        // The holder is the newest claim not later than `at`.
        let held: number | null = null;
        for (const claim of list) {
          if (claim.from.getTime() <= at.getTime()) held = claim.projectId;
        }
        if (held !== null) return held;
      }
      // No history row: the slug has only ever had its current holder.
      for (const [id, current] of byId) if (current === slug) return id;
      return null;
    },
  };
}

const REF_TYPES = ["referenced", "cross_referenced"] as const;

type EventRow = {
  id: number;
  type: string;
  payload: unknown;
  createdAt: Date;
};

async function rewrite(
  db: Db,
  rows: EventRow[],
  subject: Subject,
  host: number,
  ctx: MoveContext,
): Promise<number[]> {
  const touched: number[] = [];
  for (const row of rows) {
    const next = classifyRefEvent(
      {
        type: row.type,
        payload: row.payload as Payload,
        createdAt: row.createdAt,
        host,
      },
      subject,
      ctx,
    );
    if (next === null) continue;
    await db
      .update(issueEvents)
      .set({
        type: next.type as (typeof REF_TYPES)[number],
        payload: next.payload,
      })
      .where(eq(issueEvents.id, row.id));
    touched.push(row.id);
  }
  return touched;
}

/**
 * The card's own copied events, which arrived written under the source
 * project's numbering and now have to say so.
 */
export async function normalizeOwnEvents(
  db: Db,
  where: { projectId: number; issueId: number; writtenUnder: number },
  ctx: MoveContext,
): Promise<number[]> {
  const rows = await db
    .select({
      id: issueEvents.id,
      type: issueEvents.type,
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, where.projectId),
        eq(issueEvents.issueId, where.issueId),
        inArray(issueEvents.type, [...REF_TYPES]),
      ),
    );
  return rewrite(db, rows, "on-the-card", where.writtenUnder, ctx);
}

/**
 * Events on OTHER cards in one project that name the moved card — the ones
 * whose `by_issue` (and possibly `by_comment`) just became wrong.
 *
 * Matched on the number the card had in the frame those events were written
 * in, which is why the source and destination scans look for different
 * shapes: in the source the card was local, in the destination it was not.
 */
export async function normalizeReferencesTo(
  db: Db,
  where: {
    projectId: number;
    /** The card's number as this project's events spell it. */
    oldNumber: number;
    /** The project those events currently attribute the card to. */
    attributedTo: number;
    /** The card's own row here, if any, so its timeline is left alone. */
    exceptIssueId?: number;
  },
  ctx: MoveContext,
): Promise<number[]> {
  const shape =
    where.projectId === where.attributedTo
      ? eq(issueEvents.type, "referenced")
      : and(
          eq(issueEvents.type, "cross_referenced"),
          sql`(${issueEvents.payload} ->> 'by_project_id')::bigint = ${where.attributedTo}`,
        );
  const conditions = [
    eq(issueEvents.projectId, where.projectId),
    sql`${issueEvents.payload} ->> 'by_issue' = ${String(where.oldNumber)}`,
    shape as ReturnType<typeof eq>,
  ];
  if (where.exceptIssueId !== undefined) {
    conditions.push(ne(issueEvents.issueId, where.exceptIssueId));
  }
  const rows = await db
    .select({
      id: issueEvents.id,
      type: issueEvents.type,
      payload: issueEvents.payload,
      createdAt: issueEvents.createdAt,
    })
    .from(issueEvents)
    .where(and(...conditions));
  return rewrite(db, rows, "about-the-card", where.projectId, ctx);
}

/**
 * The same rewrite in projects that are neither end of the move, run after
 * the move has committed and best-effort by consequence — a project that
 * fails costs one stale timeline row, and the link itself still redirects.
 * Deliberately the same semantics `recordCrossReferences` already has.
 */
export async function normalizeThirdParties(
  ctx: AppContext,
  where: {
    projects: Array<{ id: number; slug: string; databaseUrl: string | null }>;
    oldNumber: number;
    attributedTo: number;
  },
  move: MoveContext,
): Promise<void> {
  for (const project of where.projects) {
    try {
      const db = await ctx.router.forProject(
        routeInfoOf({
          id: project.id,
          slug: project.slug,
          databaseUrl: project.databaseUrl,
          // biome-ignore lint/suspicious/noExplicitAny: only routing fields
        } as any),
      );
      await normalizeReferencesTo(
        db,
        {
          projectId: project.id,
          oldNumber: where.oldNumber,
          attributedTo: where.attributedTo,
        },
        move,
      );
    } catch (err) {
      console.error(`normalizing references in "${project.slug}" failed`, err);
    }
  }
}
