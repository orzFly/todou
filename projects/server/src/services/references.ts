import type { AgentContext } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { issueEvents, issues } from "../db/project-schema.ts";

/**
 * Blank out fenced code blocks and inline code spans so their contents
 * never yield references. Line-based on purpose: 4-space-indented code
 * blocks are indistinguishable from list continuations without a full
 * markdown parser, so they remain an accepted false-positive source.
 */
export function stripMarkdownCode(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open?.[1] !== undefined) {
      const char = open[1][0] as string;
      const len = open[1].length;
      if (fence === null) {
        fence = { char, len };
        continue;
      }
      // A closing fence must repeat the opening char at least as long.
      if (char === fence.char && len >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence === null) kept.push(line);
  }
  // Inline spans open and close with equal-length backtick runs; the
  // space keeps the run from gluing its neighbours into a word.
  return kept.join("\n").replace(/(`+)[^`][\s\S]*?\1/g, " ");
}

/** Extract #N issue references from markdown, ignoring code segments. */
export function extractIssueRefs(text: string): number[] {
  const found = new Set<number>();
  for (const match of stripMarkdownCode(text).matchAll(
    /(?:^|\W)#(\d{1,9})\b/g,
  )) {
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
  agentContext: AgentContext | null = null,
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
        agentContext,
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
