import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/queries.ts";
import {
  pageResource as resource,
  runtimeQueryOptions,
} from "@/api/runtime/query-adapter.ts";

/**
 * Per-issue question status (T-19): every question comment with its answer,
 * one request for the whole issue. Cards share this via the query cache, so
 * a timeline full of question comments still costs one fetch.
 */
export const questionsQuery = (slug: string, issueNumber: number) =>
  runtimeQueryOptions(
    queryOptions({
      queryKey: ["questions", slug, issueNumber],
      queryFn: () => api.getIssueQuestions(slug, issueNumber),
    }),
    {
      kind: "direct",
      resources: [
        resource(
          "questions",
          `/projects/${slug}/issues/${issueNumber}/questions`,
        ),
      ],
    },
  );
