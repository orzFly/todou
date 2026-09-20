import { pageHasUnreadRow } from "../event-rules.ts";

export type ReadMutationScope = { slug?: string; number?: number };

/** Read positions cannot change list counts or remove review/question reasons.
 * Worker snapshots and fallback page queries use this same row predicate.
 */
export function readMutationAffects(
  key: readonly unknown[],
  data: unknown,
  scope: ReadMutationScope,
): boolean {
  if (key[0] !== "issues" && key[0] !== "inbox") return false;
  if (key[0] === "issues" && scope.slug !== undefined && key[1] !== scope.slug)
    return false;
  if (key[0] === "issues" && key[2] === "counts") return false;
  if (data === undefined) return true;
  if (
    !data ||
    typeof data !== "object" ||
    !("items" in data) ||
    !Array.isArray(data.items)
  )
    return false;
  if (key[0] === "issues" && scope.number !== undefined) {
    return pageHasUnreadRow(data, scope.number);
  }
  return data.items.some((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const row = item as {
      number?: number;
      project?: { slug?: string };
      unread?: boolean;
      unread_comments?: number;
      mentions_you?: boolean;
    };
    if (
      key[0] === "inbox" &&
      scope.slug !== undefined &&
      row.project?.slug !== scope.slug
    )
      return false;
    if (scope.number !== undefined && row.number !== scope.number) return false;
    return (
      row.unread === true ||
      (typeof row.unread_comments === "number" && row.unread_comments > 0) ||
      (key[0] === "inbox" && row.mentions_you === true)
    );
  });
}
