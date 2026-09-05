import { queryOptions } from "@tanstack/react-query";
import type { SearchDomain } from "@todou/shared";
import {
  parseSearchQuery,
  SEARCH_DOMAIN_IS,
  SEARCH_DOMAINS,
  searchFiltersOf,
  searchIsDomains,
} from "@todou/shared";
import { z } from "zod";
import { csvToIds, ID_CSV, textParam } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";

const DOMAIN_CSV = /^(issues|comments|specs)(,(issues|comments|specs))*$/;

/** URL search params for the results page — shareable, like the list's. */
export const searchPageSchema = z.object({
  q: textParam.optional(),
  in: textParam.refine((v) => DOMAIN_CSV.test(v)).optional(),
  status: textParam.refine((v) => ID_CSV.test(v)).optional(),
  label: textParam.refine((v) => ID_CSV.test(v)).optional(),
  assignee: z.coerce.number().int().positive().optional(),
});
export type SearchPageSearch = z.infer<typeof searchPageSchema>;

/**
 * The domains this page is showing. `is:` in the query wins, because after
 * T-262 that is where the answer lives; `?in=` is the older spelling and is
 * still read so a shared link keeps working.
 */
export function domainsOf(search: SearchPageSearch): SearchDomain[] {
  const { domains } = searchIsDomains(
    searchFiltersOf(parseSearchQuery(search.q ?? "")),
  );
  if (domains !== null) return domains;
  return search.in ? (search.in.split(",") as SearchDomain[]) : [];
}

/**
 * `q` with its `is:` expressions replaced by exactly these domains, or with
 * none at all when every domain is wanted — "all three" is what an absent
 * `is:` already means, and spelling it out would only be noise in a URL
 * people share.
 */
export function withDomains(q: string, domains: SearchDomain[]): string {
  const rest = parseSearchQuery(q)
    .filter((part) => part.kind !== "filter" || part.key !== "is")
    .map((part) => (part.kind === "space" ? " " : part.raw))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (domains.length === 0 || domains.length === SEARCH_DOMAINS.length) {
    return rest;
  }
  const is = `is:${domains.map((d) => SEARCH_DOMAIN_IS[d]).join(",")}`;
  return rest === "" ? is : `${rest} ${is}`;
}

/**
 * The values `harness:` and `session:` completion offers (T-262). Enabled by
 * the caller, because the header box exists on every project page and this
 * reads three tables — nobody should pay for it until they open the box.
 */
export const searchFacetsQuery = (slug: string, enabled: boolean) =>
  queryOptions({
    queryKey: ["search-facets", slug],
    queryFn: () => api.searchFacets(slug),
    // Sessions accumulate slowly, and a completion list that is five minutes
    // behind costs the reader nothing.
    staleTime: 5 * 60_000,
    enabled,
  });

export const searchQuery = (slug: string, search: SearchPageSearch) =>
  queryOptions({
    queryKey: ["search", slug, search],
    queryFn: () =>
      api.search(slug, {
        q: search.q ?? "",
        in: search.in,
        status: csvToIds(search.status),
        label: csvToIds(search.label),
        assignee: search.assignee,
      }),
    // A query the user typed is a fresh question every time they ask it, but
    // paging back and forth within a minute is the same question.
    staleTime: 60_000,
    enabled: (search.q ?? "").trim() !== "",
  });
