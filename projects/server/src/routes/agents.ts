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
import { ValidationFailedError } from "../errors.ts";
import {
  createAgent,
  deleteAgentAvatar,
  disableAgent,
  enableAgent,
  issueAgentToken,
  listAgents,
  listAgentTokens,
  revokeAgentToken,
  setAgentAvatar,
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
  summary: "Edit an agent's login or display name (owner or instance admin)",
  request: { params: idParam, body: jsonBody(AgentUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Agent) } },
});

const agentAvatarRoute = createRoute({
  method: "post",
  path: "/{id}/avatar",
  summary: "Upload an agent's avatar (owner or instance admin, multipart)",
  request: {
    params: idParam,
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z
              .custom<File>((v: unknown) => v instanceof File, "file required")
              .openapi({ type: "string", format: "binary" }),
          }),
        },
      },
    },
  },
  responses: { 200: { description: "Updated", ...jsonBody(Agent) } },
});

const deleteAgentAvatarRoute = createRoute({
  method: "delete",
  path: "/{id}/avatar",
  summary: "Remove an agent's avatar (owner or instance admin)",
  request: { params: idParam },
  responses: { 200: { description: "Updated", ...jsonBody(Agent) } },
});

const disableAgentRoute = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Disable an agent: blocks auth and revokes all its tokens",
  request: { params: idParam },
  responses: { 204: { description: "Disabled" } },
});

const enableAgentRoute = createRoute({
  method: "post",
  path: "/{id}/enable",
  summary:
    "Re-enable a disabled agent. Previously revoked tokens stay revoked — " +
    "issue a new one.",
  request: { params: idParam },
  responses: { 200: { description: "Enabled", ...jsonBody(Agent) } },
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

  app.openapi(agentAvatarRoute, async (c) => {
    const form = c.req.valid("form");
    if (!(form.file instanceof File)) {
      throw new ValidationFailedError("file part is required");
    }
    return c.json(
      await setAgentAvatar(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
        form.file,
      ),
      200,
    );
  });

  app.openapi(deleteAgentAvatarRoute, async (c) =>
    c.json(
      await deleteAgentAvatar(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
      ),
      200,
    ),
  );

  app.openapi(disableAgentRoute, async (c) => {
    await disableAgent(c.get("appCtx"), c.get("user"), c.req.valid("param").id);
    return c.body(null, 204);
  });

  app.openapi(enableAgentRoute, async (c) =>
    c.json(
      await enableAgent(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").id,
      ),
      200,
    ),
  );

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
