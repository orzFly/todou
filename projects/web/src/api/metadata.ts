import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
} from "@todou/shared";
import { api } from "@/api/queries.ts";

/**
 * Metadata for one card (T-282), fetched with the page rather than when the
 * dialog opens: the sidebar summary needs the same rows, and they are far too
 * small to be worth two lifecycles.
 *
 * Every namespace, always. The sidebar's three numbers are all derived from
 * this one response, so a card carries one query key and one invalidation
 * target — the namespace-list endpoint stays for callers that want the list
 * without the values.
 */
export const issueMetadataQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["issue-metadata", slug, issueNumber],
    queryFn: () => api.getIssueMetadata(slug, issueNumber, "*"),
  });

/** One namespace as the sidebar shows it. */
export type MetadataGroup = {
  namespace: string;
  entries: IssueMetadataEntry[];
  /** The newest write in the group. */
  updatedAt: string;
};

/**
 * Entries grouped by namespace, in the order the API returned them. The
 * response is sorted by `(namespace, key)` as a matter of contract, so a
 * group's rows are already adjacent and neither this nor the table sorts
 * again.
 */
export function groupMetadata(entries: IssueMetadataEntry[]): MetadataGroup[] {
  const groups: MetadataGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last !== undefined && last.namespace === entry.namespace) {
      last.entries.push(entry);
      if (entry.updated_at > last.updatedAt) last.updatedAt = entry.updated_at;
      continue;
    }
    groups.push({
      namespace: entry.namespace,
      entries: [entry],
      updatedAt: entry.updated_at,
    });
  }
  return groups;
}

/**
 * Write metadata from the browser (T-282).
 *
 * Every write carries `if_match`, taken from the value on screen — a new key
 * expects to be absent. A person editing here is looking at a value some tool
 * may already have replaced, and without the expectation the edit would
 * silently overwrite machine state. A failed expectation is reported where the
 * edit happened and never retried automatically: what to do about it is the
 * reader's decision, and only they can make it.
 */
export function useWriteIssueMetadata(slug: string, issueNumber: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entries: IssueMetadataWriteEntry[]) =>
      api.writeIssueMetadata(slug, issueNumber, { entries }),
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["issue-metadata", slug, issueNumber],
      });
    },
  });
}

/** The `{namespace, key, current}` rows a 409 `metadata_precondition` names. */
export type MetadataConflict = {
  namespace: string;
  key: string;
  current: string | null;
};

export function conflictsOf(error: unknown): MetadataConflict[] | null {
  if (typeof error !== "object" || error === null) return null;
  if ((error as { code?: unknown }).code !== "metadata_precondition") {
    return null;
  }
  const failed = (error as { details?: { failed?: unknown } }).details?.failed;
  return Array.isArray(failed) ? (failed as MetadataConflict[]) : null;
}
