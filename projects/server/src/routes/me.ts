import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Me,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { issueToken, listTokens, revokeToken } from "../services/tokens.ts";
import { ownerRefOf, toMe } from "../services/users.ts";

const meRoute = createRoute({
  method: "get",
  path: "/me",
  summary: "Current identity (works for humans and machine users)",
  responses: {
    200: {
      description: "Current user",
      content: { "application/json": { schema: Me } },
    },
  },
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/me/tokens",
  summary: "List my active personal access tokens",
  responses: {
    200: {
      description: "Tokens (prefix only — plaintext is never stored)",
      content: { "application/json": { schema: z.array(TokenListItem) } },
    },
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/me/tokens",
  summary: "Issue a personal access token for myself",
  request: {
    body: {
      content: { "application/json": { schema: TokenCreateInput } },
    },
  },
  responses: {
    201: {
      description: "Token created — plaintext returned exactly once",
      content: { "application/json": { schema: TokenCreated } },
    },
  },
});

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/me/tokens/{id}",
  summary: "Revoke one of my tokens",
  request: {
    params: z.object({ id: z.coerce.number().int().positive() }),
  },
  responses: { 204: { description: "Token revoked" } },
});

export function meRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(meRoute, async (c) => {
    const user = c.get("user");
    const db = c.get("appCtx").router.system();
    return c.json(toMe(user, await ownerRefOf(db, user)), 200);
  });

  app.openapi(listTokensRoute, async (c) => {
    const db = c.get("appCtx").router.system();
    return c.json(await listTokens(db, c.get("user").id), 200);
  });

  app.openapi(createTokenRoute, async (c) => {
    const db = c.get("appCtx").router.system();
    const input = c.req.valid("json");
    return c.json(await issueToken(db, c.get("user").id, input), 201);
  });

  app.openapi(revokeTokenRoute, async (c) => {
    const db = c.get("appCtx").router.system();
    const { id } = c.req.valid("param");
    await revokeToken(db, c.get("user").id, id);
    return c.body(null, 204);
  });

  return app;
}
