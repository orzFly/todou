import { Readable } from "node:stream";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
  ErrorBody,
  PublicUser,
  UserIssuesPage,
  UserIssuesQuery,
  UserProjects,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import { ValidationFailedError } from "../errors.ts";
import { getUserActivityCalendar } from "../services/activity-calendar/index.ts";
import { openAvatar } from "../services/profile.ts";
import { listUserIssues } from "../services/user-issues.ts";
import {
  getPublicUser,
  listUserProjects,
  resolveVisibleUser,
} from "../services/users.ts";

const userRoute = createRoute({
  method: "get",
  path: "/users/{ref}",
  summary:
    "One account's public identity. {ref} is an id when all digits, a login " +
    "otherwise. Visible when the caller shares a project with them, is " +
    "them, owns them as an agent, or is an instance admin; everyone else " +
    "gets the same 404 an unknown login gets.",
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

const userIssuesRoute = createRoute({
  method: "get",
  path: "/users/{ref}/issues",
  summary: "Cards this account opened or is assigned, across projects",
  description:
    "Scoped to the projects **the caller** can read, never the ones the " +
    "subject can: a card in a project you have no access to is absent even " +
    "when they opened it. `after` takes only the envelope cursor this " +
    "endpoint mints, and `limit` counts delivered rows across the whole " +
    "page rather than per project.",
  request: {
    params: z.object({ ref: z.string().min(1).max(64) }),
    query: UserIssuesQuery,
  },
  responses: {
    200: {
      description: "One page of cards, newest activity first",
      content: { "application/json": { schema: UserIssuesPage } },
    },
  },
});

const userProjectsRoute = createRoute({
  method: "get",
  path: "/users/{ref}/projects",
  summary: "Projects this account is a member of",
  description:
    "Intersected with the projects **the caller** can read. Membership " +
    "rows only, so an instance admin — admin everywhere without holding a " +
    "row — lists nothing here. Unpaginated: the count is bounded by the " +
    "caller's own project count.",
  request: {
    params: z.object({ ref: z.string().min(1).max(64) }),
  },
  responses: {
    200: {
      description: "The subject's memberships, most privileged first",
      content: { "application/json": { schema: UserProjects } },
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

const userActivityRoute = createRoute({
  method: "get",
  path: "/users/{ref}/activity",
  summary: "An account's activity across projects the viewer can read",
  request: {
    params: z.strictObject({ ref: z.string().min(1).max(64) }),
    query: ActivityCalendarQuery,
  },
  responses: {
    200: {
      description: "Calendar and selected-day cards",
      content: { "application/json": { schema: ActivityCalendarResponse } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: ErrorBody } },
    },
    403: {
      description: "Read capability required",
      content: { "application/json": { schema: ErrorBody } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorBody } },
    },
    409: {
      description: "Activity changed; restart",
      content: { "application/json": { schema: ErrorBody } },
    },
    422: {
      description: "Invalid activity query",
      content: { "application/json": { schema: ErrorBody } },
    },
    500: {
      description: "Database read failed",
      content: { "application/json": { schema: ErrorBody } },
    },
  },
});

export function userRoutes() {
  const app = new OpenAPIHono<AppEnv>();
  app.openapi(
    userActivityRoute,
    async (c) =>
      c.json(
        await getUserActivityCalendar(
          c.get("appCtx"),
          c.get("user"),
          c.req.valid("param").ref,
          c.req.valid("query"),
        ),
        200,
      ),
    (result) => {
      if (!result.success) {
        throw new ValidationFailedError(
          z.prettifyError(result.error),
          result.error.issues,
        );
      }
      return undefined;
    },
  );

  app.openapi(userRoute, async (c) => {
    const user = c.get("user");
    return c.json(
      await getPublicUser(c.get("appCtx"), user, c.req.valid("param").ref),
      200,
    );
  });

  app.openapi(userIssuesRoute, async (c) => {
    const ctx = c.get("appCtx");
    const viewer = c.get("user");
    const subject = await resolveVisibleUser(
      ctx,
      viewer,
      c.req.valid("param").ref,
    );
    return c.json(
      await listUserIssues(ctx, viewer, subject, c.req.valid("query")),
      200,
    );
  });

  app.openapi(userProjectsRoute, async (c) => {
    const ctx = c.get("appCtx");
    const viewer = c.get("user");
    const subject = await resolveVisibleUser(
      ctx,
      viewer,
      c.req.valid("param").ref,
    );
    return c.json(await listUserProjects(ctx, viewer, subject), 200);
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
