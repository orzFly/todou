import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Me } from "@todou/shared";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createSession,
  destroySession,
  SESSION_COOKIE,
} from "../auth/session.ts";
import { type AppContext, BUILTIN_LOGIN } from "../bootstrap.ts";
import { users } from "../db/system-schema.ts";
import { UnauthorizedError } from "../errors.ts";
import { ownerRefOf, toMe } from "../services/users.ts";

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary:
    "Log in. In single mode no credentials are required — the session is " +
    "created for the built-in user.",
  responses: {
    200: {
      description: "Session created",
      content: { "application/json": { schema: Me } },
    },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  summary: "Destroy the current session",
  responses: { 204: { description: "Session destroyed" } },
});

export function authRoutes(ctx: AppContext) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(loginRoute, async (c) => {
    // Only single mode is implemented in this slice; loadConfig rejects
    // any other auth.mode at startup.
    const db = ctx.router.system();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.login, BUILTIN_LOGIN));
    const user = rows[0];
    if (!user) throw new UnauthorizedError("built-in user missing");

    const session = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, session.value, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      expires: session.expiresAt,
    });
    return c.json(toMe(user, await ownerRefOf(db, user)), 200);
  });

  app.openapi(logoutRoute, async (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      await destroySession(ctx.router.system(), cookie);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }
    return c.body(null, 204);
  });

  return app;
}
