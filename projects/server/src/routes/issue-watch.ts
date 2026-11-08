import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  AGENT_CONTEXT_HEADER,
  type AgentContext,
  IssueWatchMark,
  IssueWatchMarkInput,
  ProjectRef,
} from "@todou/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { DomainError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "../services/access.ts";
import { liveIssueId } from "../services/mutes.ts";

const DEFAULT_TTL_SECONDS = 900;

const params = z.object({
  slug: ProjectRef,
  number: z.coerce.number().int().positive(),
});

const watchIssueRoute = createRoute({
  method: "put",
  path: "/projects/{slug}/issues/{number}/watch",
  summary:
    "Mark this card as watched by the agent session named in the " +
    `${AGENT_CONTEXT_HEADER} header (T-669). The mark lasts ttl_seconds ` +
    "(default 900, at most 3600); repeating resets it to now + ttl_seconds. " +
    "It is listed as a `marked` card-level watcher. Marks are in memory, so " +
    "a server restart drops them until the next renewal.",
  request: {
    params,
    body: {
      content: { "application/json": { schema: IssueWatchMarkInput } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "The mark as it now stands",
      content: { "application/json": { schema: IssueWatchMark } },
    },
  },
});

const unwatchIssueRoute = createRoute({
  method: "delete",
  path: "/projects/{slug}/issues/{number}/watch",
  summary:
    "Remove this agent session's mark on the card. Idempotent: 204 even if " +
    "there was none, and the card itself is not checked, so a mark on a " +
    "card since deleted or transferred can still be cleared.",
  request: { params },
  responses: { 204: { description: "Mark removed" } },
});

/** Only agent watchers are ever listed, so a mark without a session has nothing to show. */
function requireAgentContext(c: Context<AppEnv>): AgentContext {
  const agentContext = c.get("agentContext");
  if (agentContext === null) {
    throw new DomainError(
      400,
      "agent_context_required",
      `a watch mark belongs to an agent session; send ${AGENT_CONTEXT_HEADER}`,
    );
  }
  return agentContext;
}

export function issueWatchRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(watchIssueRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const { slug, number } = c.req.valid("param");
    const { project } = await requireCapability(
      ctx,
      user,
      slug,
      "project.read",
    );
    const agentContext = requireAgentContext(c);
    const ttl = c.req.valid("json")?.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const db = await ctx.router.forProject(routeInfoOf(project));
    await liveIssueId(db, project.id, number);
    const { since, expiresAt } = ctx.watchers.mark({
      userId: user.id,
      agentContext,
      projectId: project.id,
      number,
      ttlMs: ttl * 1000,
    });
    return c.json(
      {
        issue_number: number,
        since: since.toISOString(),
        expires_at: expiresAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(unwatchIssueRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const { slug, number } = c.req.valid("param");
    const { project } = await requireCapability(
      ctx,
      user,
      slug,
      "project.read",
    );
    ctx.watchers.unmark({
      userId: user.id,
      agentContext: requireAgentContext(c),
      projectId: project.id,
      number,
    });
    return c.body(null, 204);
  });

  return app;
}
