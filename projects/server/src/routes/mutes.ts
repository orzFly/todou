import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  IssueMuteInput,
  MuteList,
  ORIGIN_HEADER,
  ProjectRef,
} from "@todou/shared";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { notifyMutesChanged, originOf } from "../services/me-events.ts";
import {
  clearIssueMute,
  clearProjectMute,
  listMutes,
  setIssueMute,
  setProjectMute,
} from "../services/mutes.ts";

// Lives at the API root like meRoutes(): the file owns both /projects/...
// mute paths and /me/mutes, the same way me.ts owns /projects/.../read.
const muteIssueRoute = createRoute({
  method: "put",
  path: "/projects/{slug}/issues/{number}/mute",
  summary:
    "Mute this card for me. Repeating pushes muted_at to now — for " +
    "`until_activity` that is how the reader re-buries what relit.",
  request: {
    params: z.object({
      slug: ProjectRef,
      number: z.coerce.number().int().positive(),
    }),
    body: { content: { "application/json": { schema: IssueMuteInput } } },
  },
  responses: { 204: { description: "Muted" } },
});

const unmuteIssueRoute = createRoute({
  method: "delete",
  path: "/projects/{slug}/issues/{number}/mute",
  summary: "Unmute this card for me. Idempotent: 204 even if it was not muted.",
  request: {
    params: z.object({
      slug: ProjectRef,
      number: z.coerce.number().int().positive(),
    }),
  },
  responses: { 204: { description: "Unmuted" } },
});

const muteProjectRoute = createRoute({
  method: "put",
  path: "/projects/{slug}/mute",
  summary:
    "Mute every card in this project for me. Repeating pushes muted_at " +
    "to now; there is no per-card exception to lift.",
  request: { params: z.object({ slug: ProjectRef }) },
  responses: { 204: { description: "Project muted" } },
});

const unmuteProjectRoute = createRoute({
  method: "delete",
  path: "/projects/{slug}/mute",
  summary: "Unmute this project for me. Idempotent.",
  request: { params: z.object({ slug: ProjectRef }) },
  responses: { 204: { description: "Project unmuted" } },
});

const mutesRoute = createRoute({
  method: "get",
  path: "/me/mutes",
  summary:
    "The mute settings I have stored — not today's verdicts: an " +
    "`until_activity` card that relit is still listed. Scoped to the " +
    "projects I can read.",
  responses: {
    200: {
      description: "Muted issues and projects",
      content: { "application/json": { schema: MuteList } },
    },
  },
});

export function muteRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  // All four writes notify after their own await, never before: the bus
  // contract is that a subscriber woken by an event reads committed data.
  app.openapi(muteIssueRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const { slug, number } = c.req.valid("param");
    await setIssueMute(ctx, user, slug, number, c.req.valid("json").mode);
    notifyMutesChanged(ctx, user, originOf(c.req.header(ORIGIN_HEADER)));
    return c.body(null, 204);
  });

  app.openapi(unmuteIssueRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    const { slug, number } = c.req.valid("param");
    await clearIssueMute(ctx, user, slug, number);
    notifyMutesChanged(ctx, user, originOf(c.req.header(ORIGIN_HEADER)));
    return c.body(null, 204);
  });

  app.openapi(muteProjectRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    await setProjectMute(ctx, user, c.req.valid("param").slug);
    notifyMutesChanged(ctx, user, originOf(c.req.header(ORIGIN_HEADER)));
    return c.body(null, 204);
  });

  app.openapi(unmuteProjectRoute, async (c) => {
    const ctx = c.get("appCtx");
    const user = c.get("user");
    await clearProjectMute(ctx, user, c.req.valid("param").slug);
    notifyMutesChanged(ctx, user, originOf(c.req.header(ORIGIN_HEADER)));
    return c.body(null, 204);
  });

  app.openapi(mutesRoute, async (c) => {
    return c.json(await listMutes(c.get("appCtx"), c.get("user")), 200);
  });

  return app;
}
