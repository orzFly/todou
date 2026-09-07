import type { IssueListCacheDescriptor } from "@todou/shared";

/**
 * The `meta` key a cached issue-list entry declares its contents under.
 * Read by the SSE invalidation predicates, which is the only way they can
 * ask "would this change have altered what you are holding?" — a query key
 * says which request was made, not what it filters on.
 */
const META_KEY = "issueList";

/**
 * Pairs an existing `["issues", slug, …]` query key with a declaration of
 * what it holds (T-279). It deliberately does not build the key: the shapes
 * in use are read by `statusScopeOf` and asserted by a long tail of existing
 * `toHaveBeenCalledWith({ queryKey })` tests, so they stay exactly as they
 * were and only gain a description.
 *
 * An entry without a declaration is treated as unjudgeable and refetched, so
 * a producer added later that forgets this loses the optimization rather than
 * skipping a page it should have refreshed.
 */
export function issuesEntry<const K extends readonly unknown[]>(
  queryKey: K,
  descriptor: IssueListCacheDescriptor,
): { queryKey: K; meta: Record<string, unknown> } {
  return { queryKey, meta: { [META_KEY]: descriptor } };
}

/**
 * The declaration on a cache entry, or `undefined` when it has none or one
 * this build does not recognize. Validated rather than cast: `meta` is
 * `Record<string, unknown>` to react-query, and a predicate that trusted it
 * would throw inside `invalidateQueries`.
 */
export function issueListDescriptorOf(
  meta: Record<string, unknown> | undefined,
): IssueListCacheDescriptor | undefined {
  const declared = meta?.[META_KEY];
  if (typeof declared !== "object" || declared === null) return undefined;
  const { kind, filter } = declared as { kind?: unknown; filter?: unknown };
  if (kind !== "page" && kind !== "counts") return undefined;
  if (typeof filter !== "object" || filter === null) return undefined;
  return declared as IssueListCacheDescriptor;
}
