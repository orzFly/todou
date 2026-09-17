import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { BlockCreateInput, BlockRef, ProjectRef } from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { addIssueBlock, removeIssueBlock } from "../services/blocks.ts";
import { roleTag } from "./role-tag.ts";

// Their own file rather than four more entries in routes/issues.ts, which is
// already 661 lines: these four are one group and share a shape.

const issueNumber = z.coerce.number().int().positive();
const issueParams = z.object({ slug: ProjectRef, number: issueNumber });
const edgeParams = z.object({
  slug: ProjectRef,
  number: issueNumber,
  edgeId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const addDescription =
  "`ref` is any spelling this deployment resolves: `#31`, `T-31`, " +
  "`acme#31`, `acme/T-31`, a full URL, or a stored " +
  "`/projects/7/issues/31`. Declaring the same edge twice returns the same " +
  "200 and records nothing further — the caller is usually an agent that " +
  "replays. The answer carries every edge this card has in this direction, " +
  "not only the new one. An issue may not block itself (422); a far end in " +
  "the trash or mid-move takes no new edge (409); longer cycles are " +
  "allowed, and show up as the cards involved all reading as blocked.";

const removeDescription =
  "The edge must belong to this card, on this side of it: a `blocked-by` " +
  "id that names an edge this card is the blocker of is a 404, worded the " +
  "same as an id that does not exist. An edge whose far end you cannot read " +
  "is still yours to drop — its id is visible to both ends and names nobody.";

const addBlockedByRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/blocked-by",
  summary: `Declare that this issue waits for another ${roleTag("issue.block")}`,
  description: addDescription,
  request: { params: issueParams, body: jsonBody(BlockCreateInput) },
  responses: {
    200: {
      description: "Every card this one waits for",
      ...jsonBody(z.object({ blocked_by: z.array(BlockRef) })),
    },
  },
});

const removeBlockedByRoute = createRoute({
  method: "delete",
  path: "/{slug}/issues/{number}/blocked-by/{edgeId}",
  summary: `Stop waiting for that issue ${roleTag("issue.block")}`,
  description: removeDescription,
  request: { params: edgeParams },
  responses: { 204: { description: "Removed" } },
});

const addBlocksRoute = createRoute({
  method: "post",
  path: "/{slug}/issues/{number}/blocks",
  summary: `Declare that another issue waits for this one ${roleTag(
    "issue.block",
  )}`,
  description: addDescription,
  request: { params: issueParams, body: jsonBody(BlockCreateInput) },
  responses: {
    200: {
      description: "Every card waiting for this one",
      ...jsonBody(z.object({ blocks: z.array(BlockRef) })),
    },
  },
});

const removeBlocksRoute = createRoute({
  method: "delete",
  path: "/{slug}/issues/{number}/blocks/{edgeId}",
  summary: `Stop that issue waiting for this one ${roleTag("issue.block")}`,
  description: removeDescription,
  request: { params: edgeParams },
  responses: { 204: { description: "Removed" } },
});

export function blockRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(addBlockedByRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    const sets = await addIssueBlock(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      "blocked_by",
      c.req.valid("json").ref,
      c.get("agentContext"),
    );
    return c.json({ blocked_by: sets.blocked_by }, 200);
  });

  app.openapi(addBlocksRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    const sets = await addIssueBlock(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      "blocks",
      c.req.valid("json").ref,
      c.get("agentContext"),
    );
    return c.json({ blocks: sets.blocks }, 200);
  });

  app.openapi(removeBlockedByRoute, async (c) => {
    const { slug, number, edgeId } = c.req.valid("param");
    await removeIssueBlock(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      "blocked_by",
      edgeId,
      c.get("agentContext"),
    );
    return c.body(null, 204);
  });

  app.openapi(removeBlocksRoute, async (c) => {
    const { slug, number, edgeId } = c.req.valid("param");
    await removeIssueBlock(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      "blocks",
      edgeId,
      c.get("agentContext"),
    );
    return c.body(null, 204);
  });

  return app;
}
