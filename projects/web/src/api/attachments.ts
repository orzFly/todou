import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { api } from "@/api/queries.ts";
import {
  type AttachmentRef,
  attachmentAnswersTo,
} from "@/lib/attachment-refs.ts";

export const attachmentsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["attachments", slug, issueNumber],
    queryFn: () => api.listAttachments(slug, issueNumber),
  });

/**
 * The attachment an address in a markdown body points at: undefined while
 * the list is still loading, null once it is in and this card has no such
 * file. Shares the query the attachment components already use, so
 * resolving a reference costs no extra request.
 */
export function useAttachmentForRef(
  slug: string,
  issueNumber: number,
  ref: AttachmentRef,
): Attachment | null | undefined {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  if (attachments.data === undefined) return undefined;
  return (
    attachments.data.find((a) => attachmentAnswersTo(a, ref, slug)) ?? null
  );
}

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
