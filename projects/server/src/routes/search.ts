import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ProjectSlug,
  SearchFacets,
  SearchPage,
  SearchQuery,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { searchProject } from "../services/search.ts";
import { searchFacets } from "../services/search-facets.ts";

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
    "`snippet.text`, ready to slice.\n\n" +
    "`q` also carries qualifiers (T-262): `is:body|comment|spec`, " +
    "`state:open|closed`, `status:<name>`, `label:<name>`, " +
    "`assignee:<login>|@me`, `harness:<agent>|none`, `session:<id>`. A " +
    "comma-separated value list is any-of, repeating a key is all-of, and a " +
    "leading `-` inverts one expression. Keys are case-insensitive, as are " +
    "the values todou resolves itself — states, statuses, labels, logins; " +
    "`harness:` and `session:` compare exactly against what the client " +
    "reported. Those two narrow the matched text rather than the card: a " +
    "comment answers for its own author, a spec for the version's, and an " +
    "issue body for whoever opened the card. An unknown key is plain text — " +
    "`area:web` is a label name here, and `https://…` must keep working — so " +
    'a known key is searched literally by quoting it: `"harness:"`. ' +
    "Qualifiers do not count against the term limit; a query of qualifiers " +
    "alone is valid. A value that names nothing is reported in " +
    "`diagnostics` and matches nothing, rather than failing the request.",
  request: { params: z.object({ slug: ProjectSlug }), query: SearchQuery },
  responses: {
    200: {
      description: "Ranked hits",
      content: { "application/json": { schema: SearchPage } },
    },
  },
});

const facetsRoute = createRoute({
  method: "get",
  path: "/{slug}/search/facets",
  summary: "The values `harness:` and `session:` can be given in this project",
  description:
    "Aggregated over every write that reported an `agent_context` — " +
    "comments, issue events and spec versions — with trashed cards left out, " +
    "as in search. `harnesses` is by frequency and `sessions` by recency, " +
    "both hard-capped: this is a pool for a completion dropdown, not a " +
    "report. `label:`, `status:` and `assignee:` are not here; their values " +
    "come from `/labels`, `/statuses` and `/members`.",
  request: { params: z.object({ slug: ProjectSlug }) },
  responses: {
    200: {
      description: "Values in use",
      content: { "application/json": { schema: SearchFacets } },
    },
  },
});

export function searchRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  // Before `/{slug}/search`, so the literal path is not eaten by it.
  app.openapi(facetsRoute, async (c) => {
    const { slug } = c.req.valid("param");
    return c.json(
      await searchFacets(c.get("appCtx"), c.get("user"), slug),
      200,
    );
  });

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
