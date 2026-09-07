import type { IssueListRow } from "./events.ts";

/**
 * The filter a cached issue-list entry was fetched under, in the shape the
 * list API takes it (T-279). `status` and `label` match any of the ids, the
 * way `issueFilterConditions` does.
 *
 * `cursor` does not narrow anything — it is here because a paginated entry
 * cannot be the complete set under its filter, which is a question
 * `admitsRow`'s caller answers for itself.
 */
export type IssueListFilter = {
  status?: number[];
  label?: number[];
  assignee?: number;
  category?: "open" | "closed";
  q?: string;
  deleted?: boolean;
  cursor?: string;
};

/**
 * What a cache entry under `["issues", slug]` holds. Counts answer "how many
 * per status" rather than "which rows", so a verdict that leaves membership
 * alone is worth nothing to them and they judge it separately.
 */
export type IssueListCacheDescriptor =
  | { kind: "page"; filter: IssueListFilter }
  | { kind: "counts"; filter: IssueListFilter };

/**
 * "Yes", "no", or "there is no telling from here". Only a "no" licenses
 * skipping a cache entry; the other two both end in a refetch, so a wrong
 * guess about which of them applies costs performance and never correctness.
 */
export type Admits = boolean | "unknown";

/** A row's set-valued fields as some other cache entry has them. */
export type CachedRowFields = {
  label_ids?: number[];
  assignee_ids?: number[];
};

/**
 * Can this filter be judged against a row's fields at all? Two cannot:
 *
 * - `q` matches the title *and the body*, and a list row carries no body.
 * - The trash sorts by deletion time and shows a non-admin only their own
 *   cards, neither of which is derivable from status, labels and assignees.
 */
export function filterIsDecidable(filter: IssueListFilter): boolean {
  if (filter.q !== undefined && filter.q !== "") return false;
  if (filter.deleted === true) return false;
  return true;
}

/**
 * Would a row with these fields appear in this filter's result set?
 *
 * `row` is the `{kind:"fields"}` verdict off a change event. It omits
 * `label_ids` or `assignee_ids` when that set did not change, so `cached`
 * supplies the unchanged value from wherever else the client has this row —
 * without it that dimension is simply unknown. `categoryOf` maps a status id
 * to its category, which the client has from its own `statuses` cache.
 *
 * The dimensions are ANDed, and a single "no" decides the whole answer: a
 * board column filtering on status alone is never held back by an unknown
 * label set.
 */
export function admitsRow(
  filter: IssueListFilter,
  row: Extract<IssueListRow, { kind: "fields" }>,
  cached?: CachedRowFields,
  categoryOf?: (statusId: number) => "open" | "closed" | undefined,
): Admits {
  if (!filterIsDecidable(filter)) return "unknown";

  // Collected rather than returned, so a later dimension can still say "no"
  // and settle it — the whole point of ANDing three-valued answers.
  let unknown = false;

  if (filter.status !== undefined && !filter.status.includes(row.status_id)) {
    return false;
  }

  if (filter.category !== undefined) {
    const category = categoryOf?.(row.status_id);
    if (category === undefined) unknown = true;
    else if (category !== filter.category) return false;
  }

  if (filter.label !== undefined) {
    const labelIds = row.label_ids ?? cached?.label_ids;
    if (labelIds === undefined) unknown = true;
    else if (!labelIds.some((id) => filter.label?.includes(id))) return false;
  }

  if (filter.assignee !== undefined) {
    const assigneeIds = row.assignee_ids ?? cached?.assignee_ids;
    if (assigneeIds === undefined) unknown = true;
    else if (!assigneeIds.includes(filter.assignee)) return false;
  }

  return unknown ? "unknown" : true;
}
