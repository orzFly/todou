import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { api, projectsQuery } from "@/api/queries.ts";
import {
  type AttachmentAddress,
  type AttachmentRef,
  attachmentAnswersTo,
} from "@/lib/attachment-refs.ts";

export const attachmentsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["attachments", slug, issueNumber],
    queryFn: () => api.listAttachments(slug, issueNumber),
  });

/**
 * Which project a reference landed on: undefined while the directory is
 * still loading, null once it is in and holds no such project.
 *
 * A slug spelling answers without consulting anything, which is what keeps
 * the zero-wait path of an address written under the project being read.
 * An id spelling needs the directory, and it is the reader's own — the same
 * one `MarkdownView` subscribes to, so the answer is normally already there.
 */
export function useAttachmentAddress(
  ref: AttachmentRef,
): AttachmentAddress | null | undefined {
  const projects = useQuery(projectsQuery);
  const project = ref.project;
  if (project.kind === "slug") {
    return { slug: project.slug, id: ref.id, name: ref.name };
  }
  if (projects.data === undefined) return undefined;
  const found = projects.data.find((p) => p.id === project.id);
  if (found === undefined) return null;
  return { slug: found.slug, id: ref.id, name: ref.name };
}

/**
 * The attachment an address in a markdown body points at: undefined while
 * the address or the list is still loading, null once both are in and this
 * card has no such file. Shares the query the attachment components already
 * use, so resolving a reference costs no extra request.
 */
export function useAttachmentForRef(
  slug: string,
  issueNumber: number,
  address: AttachmentAddress | null | undefined,
): Attachment | null | undefined {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  if (address === undefined || attachments.data === undefined) return undefined;
  if (address === null) return null;
  return (
    attachments.data.find((a) => attachmentAnswersTo(a, address, slug)) ?? null
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
