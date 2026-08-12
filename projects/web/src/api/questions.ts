import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";

/**
 * Per-issue question status (#19): every question comment with its answer,
 * one request for the whole issue. Cards share this via the query cache, so
 * a timeline full of question comments still costs one fetch.
 */
export const questionsQuery = (slug: string, issueNumber: number) =>
  queryOptions({
    queryKey: ["questions", slug, issueNumber],
    queryFn: () => api.getIssueQuestions(slug, issueNumber),
  });
