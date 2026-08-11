import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { issueEvents, issues } from "../db/project-schema.ts";

/**
 * Extract #N issue references from markdown. Plain-regex by design: refs
 * inside code blocks are false-positived — an accepted trade-off recorded
 * in the spec (an AST pass can replace this if it becomes noisy).
 */
export function extractIssueRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:^|\W)#(\d{1,9})\b/g)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

/**
 * Record `referenced` events on the issues mentioned by #N in a saved body
 * or comment. Events land on the REFERENCED issue's timeline. Each
 * (target, source) pair is recorded once, so edits don't spam timelines.
 */
export async function recordReferences(
  db: Db,
  projectId: number,
  actorId: number,
  source: { issueNumber: number; commentId?: number },
  text: string,
): Promise<Array<{ eventId: number; issueId: number; issueNumber: number }>> {
  const numbers = extractIssueRefs(text).filter(
    (n) => n !== source.issueNumber,
  );
  if (numbers.length === 0) return [];

  const targets = await db
    .select({ id: issues.id, number: issues.number })
    .from(issues)
    .where(
      and(eq(issues.projectId, projectId), inArray(issues.number, numbers)),
    );
  if (targets.length === 0) return [];

  const existing = await db
    .select({ issueId: issueEvents.issueId, payload: issueEvents.payload })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "referenced"),
        inArray(
          issueEvents.issueId,
          targets.map((t) => t.id),
        ),
      ),
    );
  const seen = new Set(
    existing.map((e) => {
      const payload = e.payload as { by_issue?: number };
      return `${e.issueId}:${payload.by_issue}`;
    }),
  );

  const created: Array<{
    eventId: number;
    issueId: number;
    issueNumber: number;
  }> = [];
  for (const target of targets) {
    if (seen.has(`${target.id}:${source.issueNumber}`)) continue;
    const inserted = await db
      .insert(issueEvents)
      .values({
        projectId,
        issueId: target.id,
        actorId,
        type: "referenced",
        payload: {
          by_issue: source.issueNumber,
          ...(source.commentId === undefined
            ? {}
            : { by_comment: source.commentId }),
        },
      })
      .returning({ id: issueEvents.id });
    const id = inserted[0]?.id;
    if (id !== undefined) {
      created.push({
        eventId: id,
        issueId: target.id,
        issueNumber: target.number,
      });
    }
  }
  return created;
}
