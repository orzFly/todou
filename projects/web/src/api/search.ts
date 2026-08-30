import { queryOptions } from "@tanstack/react-query";
import type { SearchDomain } from "@todou/shared";
import { z } from "zod";
import { csvToIds } from "@/api/issues.ts";
import { api } from "@/api/queries.ts";

const DOMAIN_CSV = /^(issues|comments|specs)(,(issues|comments|specs))*$/;
const ID_CSV = /^\d+(,\d+)*$/;

/**
 * A param that is textual even when it looks numeric. The router parses the
 * query string before this schema sees it, so `?q=141` — a reader pasting a
 * card number, which is exactly what `refShortcut` below is for — arrives as
 * the number 141 and a bare `z.string()` throws the whole route away.
 */
const textParam = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : v),
  z.string(),
);

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

/**
 * The card `q` names outright, if it names one. A reader who pastes `T-141`
 * or `141` into the box means that card, and search would only find it if
 * some *text* happened to spell it — so the page offers it as a jump rather
 * than waiting for the query to accidentally match.
 */
export function refShortcut(
  q: string,
  prefix: string | null,
): number | undefined {
  const trimmed = q.trim();
  const token = prefix === null ? "#" : `${prefix}-`;
  const bare = trimmed.toLowerCase().startsWith(token.toLowerCase())
    ? trimmed.slice(token.length)
    : trimmed;
  if (!/^\d{1,9}$/.test(bare)) return undefined;
  const n = Number(bare);
  return n > 0 ? n : undefined;
}
