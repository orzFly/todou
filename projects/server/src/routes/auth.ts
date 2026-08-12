import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { AuthMode, Me } from "@todou/shared";
import { eq } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sessionCookieAttrs } from "../auth/cookies.ts";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createSession,
  destroySession,
  SESSION_COOKIE,
} from "../auth/session.ts";
import { type AppContext, BUILTIN_SUBJECT } from "../bootstrap.ts";
import { users } from "../db/system-schema.ts";
import { DomainError, UnauthorizedError } from "../errors.ts";
import { ownerRefOf, toMe } from "../services/users.ts";
import { oidcCallback, oidcLoginRedirect } from "../auth/oidc.ts";

const modeRoute = createRoute({
  method: "get",
  path: "/mode",
  summary:
    "How humans sign in to this deployment (public; the web login page " +
    "branches on it)",
  responses: {
    200: {
      description: "The configured auth mode",
      content: { "application/json": { schema: AuthMode } },
    },
  },
});

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  summary:
    "Log in. In single mode no credentials are required — the session is " +
    "created for the built-in user. In oidc mode use GET /auth/login; in " +
    "forward mode the reverse proxy authenticates every request.",
  responses: {
    200: {
      description: "Session created",
      content: { "application/json": { schema: Me } },
    },
  },
});

const oidcLoginRoute = createRoute({
  method: "get",
  path: "/login",
  summary:
    "Start the oidc authorization-code flow (302 to the IdP; oidc mode only)",
  responses: {
    302: { description: "Redirect to the identity provider" },
  },
});

const oidcCallbackRoute = createRoute({
  method: "get",
  path: "/callback",
  summary:
    "oidc redirect URI: exchanges the code, creates the session, and " +
    "returns to the interrupted page. Failures redirect to /login?error=…",
  responses: {
    302: { description: "Redirect back into the web app" },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  summary:
    "Destroy the current session (no-op in forward mode — the proxy owns " +
    "the login state)",
  responses: { 204: { description: "Session destroyed" } },
});

function wrongMode(expected: string, actual: string): DomainError {
  return new DomainError(
    400,
    "wrong_auth_mode",
    `this endpoint serves auth.mode "${expected}", but the server runs "${actual}"`,
  );
}

export function authRoutes(ctx: AppContext) {
  const app = new OpenAPIHono<AppEnv>();
  const mode = ctx.config.auth.mode;

  app.openapi(modeRoute, (c) => c.json({ mode }, 200));

  app.openapi(loginRoute, async (c) => {
    if (mode !== "single") throw wrongMode("single", mode);
    const db = ctx.router.system();
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, BUILTIN_SUBJECT));
    const user = rows[0];
    if (!user) throw new UnauthorizedError("built-in user missing");

    const session = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, session.value, {
      ...sessionCookieAttrs(c, ctx.config),
      expires: session.expiresAt,
    });
    return c.json(toMe(user, await ownerRefOf(db, user)), 200);
  });

  app.openapi(oidcLoginRoute, async (c) => {
    if (mode !== "oidc") throw wrongMode("oidc", mode);
    return oidcLoginRedirect(c, ctx);
  });

  app.openapi(oidcCallbackRoute, async (c) => {
    if (mode !== "oidc") throw wrongMode("oidc", mode);
    return oidcCallback(c, ctx);
  });

  app.openapi(logoutRoute, async (c) => {
    if (mode === "forward") return c.body(null, 204);
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      await destroySession(ctx.router.system(), cookie);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }
    return c.body(null, 204);
  });

  return app;
}
