import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

export const attachmentsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["attachments", slug, issueNumber],
    queryFn: () => api.listAttachments(slug, issueNumber),
  });
