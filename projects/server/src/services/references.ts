import { scanReferenceTokens } from "@todou/shared";
import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { refFormats } from "../db/project-schema.ts";

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

/**
 * Extract internal issue references from markdown, ignoring code
 * segments. `prefix` selects the format the content was WRITTEN under
 * (T-80 time-cutoff rule): null = `#N`, 'T' = `T-N`.
 */
export function extractIssueRefs(
  text: string,
  prefix: string | null = null,
): number[] {
  const found = new Set<number>();
  for (const token of scanReferenceTokens(stripMarkdownCode(text), {
    internalPrefix: prefix,
  })) {
    if (token.type === "issue" && token.slug === null) found.add(token.number);
  }
  return [...found];
}

/**
 * The internal reference prefix in force at `at`: the newest ref_formats
 * row with effective_from <= at, null (= "#") before the first row.
 */
export async function refPrefixAt(
  db: Db,
  projectId: number,
  at: Date,
): Promise<string | null> {
  const rows = await db
    .select({ prefix: refFormats.prefix })
    .from(refFormats)
    .where(
      and(
        eq(refFormats.projectId, projectId),
        lte(refFormats.effectiveFrom, at),
      ),
    )
    .orderBy(desc(refFormats.effectiveFrom), desc(refFormats.id))
    .limit(1);
  return rows[0]?.prefix ?? null;
}
