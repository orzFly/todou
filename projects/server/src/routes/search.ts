import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ProjectSlug, SearchPage, SearchQuery } from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { searchProject } from "../services/search.ts";

const searchRoute = createRoute({
  method: "get",
  path: "/{slug}/search",
  summary: "Full-text search across an issue's title/body, comments and spec",
  description:
    "Terms are whitespace-separated and ANDed; double quotes hold a phrase " +
    "together. Each term is a case-insensitive substring match — which is " +
    "what a Chinese query means, and what finds `WordDiff` inside " +
    "`coalescedWordDiff` (T-141). Spec hits come only from the version the " +
    "issue currently points at, and nothing in the trash is searchable. " +
    "`status`/`label`/`assignee` narrow exactly as they do on the issue " +
    "list. Ranking is by domain (issue title, then body, then comment, then " +
    "spec) and recency; `snippet.ranges` are UTF-16 offsets into " +
    "`snippet.text`, ready to slice.",
  request: { params: z.object({ slug: ProjectSlug }), query: SearchQuery },
  responses: {
    200: {
      description: "Ranked hits",
      content: { "application/json": { schema: SearchPage } },
    },
  },
});

export function searchRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(searchRoute, async (c) => {
    const { slug } = c.req.valid("param");
    return c.json(
      await searchProject(
        c.get("appCtx"),
        c.get("user"),
        slug,
        c.req.valid("query"),
      ),
      200,
    );
  });

  return app;
}
