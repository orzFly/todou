import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Agent,
  AgentCreateInput,
  AgentListQuery,
  AgentUpdateInput,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createAgent,
  disableAgent,
  issueAgentToken,
  listAgents,
  listAgentTokens,
  revokeAgentToken,
  updateAgent,
} from "../services/agents.ts";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const tokenParams = z.object({
  id: z.coerce.number().int().positive(),
  tokenId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const createAgentRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a machine user owned by the caller (humans only)",
  request: { body: jsonBody(AgentCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Agent) } },
});

const listAgentsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List my agents (owner=all requires instance admin)",
  request: { query: AgentListQuery },
  responses: { 200: { description: "Agents", ...jsonBody(z.array(Agent)) } },
});

const patchAgentRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Rename an agent (owner or instance admin)",
  request: { params: idParam, body: jsonBody(AgentUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Agent) } },
});

const disableAgentRoute = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Disable an agent: blocks auth and revokes all its tokens",
  request: { params: idParam },
  responses: { 204: { description: "Disabled" } },
});

const issueTokenRoute = createRoute({
  method: "post",
  path: "/{id}/tokens",
  summary: "Issue a PAT for an agent (owner or instance admin)",
  request: { params: idParam, body: jsonBody(TokenCreateInput) },
  responses: {
    201: {
      description: "Token created — plaintext returned exactly once",
      ...jsonBody(TokenCreated),
    },
  },
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/{id}/tokens",
  summary: "List an agent's active tokens (prefixes only)",
  request: { params: idParam },
  responses: {
    200: { description: "Tokens", ...jsonBody(z.array(TokenListItem)) },
  },
});

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/{id}/tokens/{tokenId}",
  summary: "Revoke an agent's token",
  request: { params: tokenParams },
  responses: { 204: { description: "Revoked" } },
});

export function agentRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(createAgentRoute, async (c) =>
    c.json(
      await createAgent(c.get("appCtx"), c.get("user"), c.req.valid("json")),
      201,
    ),
  );

  app.openapi(listAgentsRoute, async (c) =>
    c.json(
      await listAgents(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("query").owner,
      ),
      200,
    ),
  );

  app.openapi(patchAgentRoute, async (c) =>
    c.json(
      await updateAgent(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      200,
    ),
  );

  app.openapi(disableAgentRoute, async (c) => {
    await disableAgent(c.get("appCtx"), c.get("user"), c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(issueTokenRoute, async (c) =>
    c.json(
      await issueAgentToken(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
        c.req.valid("json"),
      ),
      201,
    ),
  );

  app.openapi(listTokensRoute, async (c) =>
    c.json(
      await listAgentTokens(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
      ),
      200,
    ),
  );

  app.openapi(revokeTokenRoute, async (c) => {
    const { id, tokenId } = c.req.valid("param");
    await revokeAgentToken(c.get("appCtx"), c.get("user"), id, tokenId);
    return c.body(null, 204);
  });

  return app;
}
