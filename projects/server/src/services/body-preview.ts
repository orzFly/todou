import { bodyPreview } from "@todou/shared";
import { type SQL, sql } from "drizzle-orm";
import { issues } from "../db/project-schema.ts";

/**
 * How much of the body a preview is cut from (T-785). Far more than the 160
 * code points it keeps, so markup stripped from the head still leaves enough.
 * Paths that select columns pull only this much, never the whole body.
 */
export const PREVIEW_SOURCE_CHARS = 2000;

export function previewOf(
  title: string,
  bodyHead: string | null,
): string | null {
  if (title !== "") return null;
  // By code point, as `left()` counts on the column-select paths, so both
  // kinds of path cut a row at the same place.
  const head = Array.from((bodyHead ?? "").slice(0, PREVIEW_SOURCE_CHARS * 2))
    .slice(0, PREVIEW_SOURCE_CHARS)
    .join("");
  return bodyPreview(head);
}

/** The body head, selected only for untitled rows; null for a titled one. */
export function previewSourceColumn(): SQL<string | null> {
  return sql<
    string | null
  >`CASE WHEN ${issues.title} = '' THEN left(${issues.body}, ${sql.raw(String(PREVIEW_SOURCE_CHARS))}) END`;
}
