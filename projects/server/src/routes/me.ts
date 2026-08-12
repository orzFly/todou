import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  IssueReadInput,
  Me,
  MeUpdateInput,
  ProjectSlug,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { ForbiddenError, ValidationFailedError } from "../errors.ts";
import { deleteAvatar, setAvatar, updateProfile } from "../services/profile.ts";
import { markIssueRead } from "../services/reads.ts";
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

const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  summary:
    "Edit my profile. Machine users may change their display name but not " +
    "their login — that stays with the owner (PATCH /agents/{id}).",
  request: {
    body: { content: { "application/json": { schema: MeUpdateInput } } },
  },
  responses: {
    200: {
      description: "Updated profile",
      content: { "application/json": { schema: Me } },
    },
  },
});

const avatarBody = {
  content: {
    "multipart/form-data": {
      schema: z.object({
        file: z
          .custom<File>((v: unknown) => v instanceof File, "file required")
          .openapi({ type: "string", format: "binary" }),
      }),
    },
  },
};

const uploadMyAvatarRoute = createRoute({
  method: "post",
  path: "/me/avatar",
  summary: "Upload my avatar (png/jpeg/webp/gif, multipart)",
  request: { body: avatarBody },
  responses: {
    200: {
      description: "Updated profile",
      content: { "application/json": { schema: Me } },
    },
  },
});

const deleteMyAvatarRoute = createRoute({
  method: "delete",
  path: "/me/avatar",
  summary: "Remove my avatar and go back to the initials fallback",
  responses: {
    200: {
      description: "Updated profile",
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

// Lives here rather than routes/issues.ts because read positions are the
// caller's private per-user state, like everything else under /me — the
// issue in the path is just what the position points at. (This file mounts
// at the API root, so the full /projects path works from here.)
const markIssueReadRoute = createRoute({
  method: "put",
  path: "/projects/{slug}/issues/{number}/read",
  summary:
    "Advance my last-seen position on an issue (never regresses; " +
    "feeds the unread markers in list responses)",
  request: {
    params: z.object({
      slug: ProjectSlug,
      number: z.coerce.number().int().positive(),
    }),
    body: { content: { "application/json": { schema: IssueReadInput } } },
  },
  responses: { 204: { description: "Position advanced" } },
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

  app.openapi(patchMeRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const input = c.req.valid("json");
    if (
      user.kind === "machine" &&
      input.login !== undefined &&
      input.login !== user.login
    ) {
      throw new ForbiddenError("an agent's login is managed by its owner");
    }
    const row = await updateProfile(ctx, user, input);
    return c.json(toMe(row, await ownerRefOf(ctx.router.system(), row)), 200);
  });

  app.openapi(uploadMyAvatarRoute, async (c) => {
    const ctx = c.get("appCtx");
    const form = c.req.valid("form");
    if (!(form.file instanceof File)) {
      throw new ValidationFailedError("file part is required");
    }
    const row = await setAvatar(ctx, c.get("user"), form.file);
    return c.json(toMe(row, await ownerRefOf(ctx.router.system(), row)), 200);
  });

  app.openapi(deleteMyAvatarRoute, async (c) => {
    const ctx = c.get("appCtx");
    const row = await deleteAvatar(ctx, c.get("user"));
    return c.json(toMe(row, await ownerRefOf(ctx.router.system(), row)), 200);
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

  app.openapi(markIssueReadRoute, async (c) => {
    const { slug, number } = c.req.valid("param");
    await markIssueRead(
      c.get("appCtx"),
      c.get("user"),
      slug,
      number,
      c.req.valid("json"),
    );
    return c.body(null, 204);
  });

  app.openapi(revokeTokenRoute, async (c) => {
    const db = c.get("appCtx").router.system();
    const { id } = c.req.valid("param");
    await revokeToken(db, c.get("user").id, id);
    return c.body(null, 204);
  });

  return app;
}
