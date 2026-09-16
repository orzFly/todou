import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PublicUser } from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { openAvatar } from "../services/profile.ts";
import { getPublicUser } from "../services/users.ts";

const userRoute = createRoute({
  method: "get",
  path: "/users/{ref}",
  summary:
    "One account's public identity. {ref} is an id when all digits, a login " +
    "otherwise. Visible when the caller shares a project with them, is " +
    "them, or is an instance admin; everyone else gets the same 404 an " +
    "unknown login gets.",
  request: {
    params: z.object({ ref: z.string().min(1).max(64) }),
  },
  responses: {
    200: {
      description: "The account",
      content: { "application/json": { schema: PublicUser } },
    },
  },
});

const avatarRoute = createRoute({
  method: "get",
  path: "/users/{id}/avatar",
  summary: "A user's avatar image (any signed-in user)",
  request: {
    params: z.object({ id: z.coerce.number().int().positive() }),
  },
  responses: { 200: { description: "Image stream" } },
});

export function userRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(userRoute, async (c) => {
    const user = c.get("user");
    return c.json(
      await getPublicUser(c.get("appCtx"), user, c.req.valid("param").ref),
      200,
    );
  });

  app.openapi(avatarRoute, async (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("appCtx");
    const avatar = await openAvatar(ctx, id);
    const { stream, size } = await ctx.storage.getStream(avatar.key);

    c.header("content-type", avatar.contentType);
    c.header("content-length", String(size));
    c.header("content-disposition", "inline");
    c.header("x-content-type-options", "nosniff");
    // Same binding as the attachment routes: an avatar embedded cross-site
    // loads nothing. The type is not normalised here — setAvatar allows only
    // png, jpeg, webp and gif, so the stored value is an allowlist result.
    c.header("cross-origin-resource-policy", "same-origin");
    // The URL embeds a per-upload version (?v=...), so the response can be
    // cached hard; a new upload changes the URL, not this cache entry.
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  return app;
}
