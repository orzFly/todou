import { type MeEvent, ORIGIN_MAX_LENGTH } from "@todou/shared";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import { visibleProjects } from "./cross-references.ts";
import { inboxRowState } from "./inbox.ts";
import { readPrefs } from "./prefs.ts";

/**
 * Notifications for the writes that deliberately emit no change event
 * (T-275): read positions and preferences. They are the caller's own
 * private state, so nothing on the project change feed may carry them, yet
 * both decide what /me/inbox contains and what the unread markers in list
 * payloads say — which is why the account's other tabs and devices need a
 * signal of their own.
 *
 * Not in `services/reads.ts`, where the writes live: `inbox.ts` already
 * imports `reads.ts`, and importing it back is a cycle that biome rejects
 * for `projects/server/src/**` (`noImportCycles`). This module imports
 * `inbox.ts` and nothing imports it, so the direction stays clean.
 *
 * Every entry starts by asking whether anyone is listening for this user.
 * The `issue_read` fingerprint costs a handful of queries, and computing it
 * for an account with no open tab would be work nobody reads — the same rule
 * `?inbox=1` follows on the SSE side.
 */

/**
 * The writer's self-reported tab id, echoed back so that tab can drop its
 * own event. Opaque to the server: never parsed, never logged, only
 * truncated.
 */
export function originOf(header: string | undefined): string | undefined {
  if (header === undefined || header === "") return undefined;
  return header.slice(0, ORIGIN_MAX_LENGTH);
}

/**
 * One issue was marked read. Carries the fingerprint of that issue's row in
 * the reader's inbox afterwards, so the other tabs run the same comparison
 * they run for change events instead of refetching on every PUT —
 * MarkReadOnView re-sends one roughly every two seconds while an issue is
 * open and busy.
 */
export async function notifyIssueRead(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  issueNumber: number,
  origin: string | undefined,
): Promise<void> {
  if (!ctx.bus.hasMeSubscriber(actor.id)) return;

  let event: MeEvent;
  try {
    // Resolved again rather than handed down from the route: the whole
    // section is behind the subscriber check, and paying for a lookup on
    // every mark-read to save one here would invert that.
    const { project } = await requireCapability(
      ctx,
      actor,
      slug,
      "issue.mark_read",
    );
    const prefs = await readPrefs(ctx.router.system(), actor.id);
    const visible = await visibleProjects(ctx, actor);
    const db = await ctx.router.forProject(routeInfoOf(project));
    event = {
      kind: "issue_read",
      project: project.slug,
      issue_number: issueNumber,
      inbox_row: await inboxRowState(
        db,
        project,
        actor,
        issueNumber,
        prefs,
        visible,
      ),
      origin,
    };
  } catch (err) {
    // The position is already written, so failing to describe its effect
    // must not turn the request into a 5xx. A sweep event says less and
    // costs the receivers a refetch, which is slower but misses nothing.
    console.error("me-events: inbox fingerprint failed", err);
    event = { kind: "reads_swept", origin };
  }
  ctx.bus.publishMe(actor.id, event);
}

/**
 * Everything in a scope of projects was marked read. No fingerprints: a
 * sweep is something a person clicked, so the receivers can afford the
 * refetch, and a row-by-row judgement of a whole project could not.
 */
export function notifyReadsSwept(
  ctx: AppContext,
  actor: UserRow,
  projects: string[] | undefined,
  origin: string | undefined,
): void {
  if (!ctx.bus.hasMeSubscriber(actor.id)) return;
  ctx.bus.publishMe(actor.id, { kind: "reads_swept", projects, origin });
}

/**
 * A preference changed. `show_weak_unread` decides which rows /me/inbox
 * returns at all, so this reaches further than the toggle's own tab.
 */
export function notifyPrefsChanged(
  ctx: AppContext,
  actor: UserRow,
  origin: string | undefined,
): void {
  if (!ctx.bus.hasMeSubscriber(actor.id)) return;
  ctx.bus.publishMe(actor.id, { kind: "prefs", origin });
}
