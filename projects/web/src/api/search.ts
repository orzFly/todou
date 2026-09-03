import { queryOptions } from "@tanstack/react-query";
import type { SearchDomain } from "@todou/shared";
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

export function domainsOf(search: SearchPageSearch): SearchDomain[] {
  return search.in ? (search.in.split(",") as SearchDomain[]) : [];
}

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
