import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  minRoleOf,
  ProjectSlug,
  SpecComments,
  SpecCommentsResolveInput,
  SpecFiles,
  SpecFilesQuery,
  SpecInfo,
  SpecPushInput,
  SpecPushResult,
  SpecReviewResult,
  SpecReviewSubmitInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  getSpecFiles,
  getSpecInfo,
  listSpecComments,
  pushSpec,
  resolveSpecComments,
  submitSpecReview,
} from "../services/spec.ts";
import { movedResponses } from "./moved-responses.ts";
import { roleTag } from "./role-tag.ts";

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
  summary: "Spec overview: versions, current files, review state (T-23)",
  request: { params: issueParams },
  responses: {
    200: { description: "Spec", ...jsonBody(SpecInfo) },
    ...movedResponses,
  },
});

const specFilesRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/spec/files",
  summary: "Full file bodies of one spec version (default: current)",
  request: { params: issueParams, query: SpecFilesQuery },
  responses: {
    200: { description: "Files", ...jsonBody(SpecFiles) },
    ...movedResponses,
  },
});

const specPushRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/spec/push",
  summary:
    `Replace the spec with the pushed file set ${roleTag("spec.push")}; a ` +
    "change becomes one new whole-set version, no change is a no-op",
  description:
    "The result carries a `cursor` (T-182): resume a timeline read or a " +
    "watch from it — `--since <cursor>` — and every entry created after " +
    "this push is delivered, the push's own event excluded. That is the " +
    "cursor to wait for the review verdict from; one taken after the push " +
    "returns leaves a window the verdict can land in unseen. An unchanged " +
    "push mints no event, so its cursor is the lower bound of the current " +
    "version's instant and may re-deliver entries of that same instant.",
  request: { params: issueParams, body: jsonBody(SpecPushInput) },
  responses: { 200: { description: "Result", ...jsonBody(SpecPushResult) } },
});

const specReviewRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/spec/reviews",
  summary:
    "Submit one atomic review: verdict + optional summary + staged inline " +
    `comments (${minRoleOf("spec.review")}; the pusher of the reviewed ` +
    "version is rejected)",
  request: { params: issueParams, body: jsonBody(SpecReviewSubmitInput) },
  responses: {
    201: { description: "Review", ...jsonBody(SpecReviewResult) },
  },
});

const specCommentsRoute = createRoute({
  method: "get",
  path: "/{slug}/issues/{number}/spec/comments",
  summary:
    "Inline spec comments with resolution state and anchors remapped onto " +
    "the current version (outdated when the anchored lines changed)",
  request: { params: issueParams },
  responses: {
    200: { description: "Comments", ...jsonBody(SpecComments) },
    ...movedResponses,
  },
});

const specResolveRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/spec/comments/resolve",
  summary: `Resolve inline spec comments ${roleTag("spec.resolve")}; one-way, one event`,
  request: { params: issueParams, body: jsonBody(SpecCommentsResolveInput) },
  responses: {
    200: {
      description: "Resolved",
      ...jsonBody(z.object({ resolved: z.array(z.number()) })),
    },
  },
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

  app.openapi(specReviewRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await submitSpecReview(
        c.get("appCtx"),
        c.get("user"),
        slug,
        number,
        c.req.valid("json"),
        c.get("agentContext"),
      ),
      201,
    );
  });

  app.openapi(specCommentsRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await listSpecComments(c.get("appCtx"), c.get("user"), slug, number),
      200,
    );
  });

  app.openapi(specResolveRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    return c.json(
      await resolveSpecComments(
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
