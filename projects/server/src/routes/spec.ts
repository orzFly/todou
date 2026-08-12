import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ProjectSlug,
  SpecFiles,
  SpecFilesQuery,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { getSpecFiles, getSpecInfo, pushSpec } from "../services/spec.ts";

const issueParams = z.object({
  slug: ProjectSlug,
  number: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const specInfoRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/spec",
  summary: "Spec overview: versions, current files, review state (#23)",
  request: { params: issueParams },
  responses: { 200: { description: "Spec", ...jsonBody(SpecInfo) } },
});

const specFilesRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/spec/files",
  summary: "Full file bodies of one spec version (default: current)",
  request: { params: issueParams, query: SpecFilesQuery },
  responses: { 200: { description: "Files", ...jsonBody(SpecFiles) } },
});

const specPushRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/spec/push",
  summary:
    "Replace the spec with the pushed file set (writer); a change becomes " +
    "one new whole-set version, no change is a no-op",
  request: { params: issueParams, body: jsonBody(SpecPushInput) },
  responses: { 200: { description: "Result", ...jsonBody(SpecPushResult) } },
});

export function specRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(specInfoRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await getSpecInfo(c.get("appCtx"), c.get("user"), slug, number),
      200,
    );
  });

  app.openapi(specFilesRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await getSpecFiles(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("query").version,
      ),
      200,
    );
  });

  app.openapi(specPushRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await pushSpec(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      200,
    );
  });

  return app;
}
