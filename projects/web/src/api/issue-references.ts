import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

/**
 * Both directions of a card's references (T-553). Fresh on every open; while
 * the dialog stays open the card's own change events refetch it.
 */
export const issueReferencesQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["issue-references", slug, issueNumber] as const,
    queryFn: () => api.getIssueReferences(slug, issueNumber),
    staleTime: 0,
  });
