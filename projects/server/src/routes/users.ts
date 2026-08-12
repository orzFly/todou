import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../auth/middleware.ts";
import { openAvatar } from "../services/profile.ts";

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

  app.openapi(avatarRoute, async (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("appCtx");
    const avatar = await openAvatar(ctx, id);
    const { stream, size } = await ctx.storage.getStream(avatar.key);

    c.header("content-type", avatar.contentType);
    c.header("content-length", String(size));
    c.header("content-disposition", "inline");
    c.header("x-content-type-options", "nosniff");
    // The URL embeds a per-upload version (?v=...), so the response can be
    // cached hard; a new upload changes the URL, not this cache entry.
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  return app;
}
