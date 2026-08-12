import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

export const attachmentsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["attachments", slug, issueNumber],
    queryFn: () => api.listAttachments(slug, issueNumber),
  });

/** Raw text of one attachment. Uploads are immutable, so cache forever. */
export const attachmentTextQuery = (url: string) =>
  queryOptions({
    queryKey: ["attachment-text", url],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      return res.text();
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
