import type { AgentContext } from "@todou/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "../bootstrap.ts";
import { UnauthorizedError } from "../errors.ts";
import { isTrustedRequest, type RequestLike } from "../http/proxy.ts";
import { type UserRow, verifyPat } from "./pat.ts";
import { normalizeLogin, provisionUser } from "./provision.ts";
import { SESSION_COOKIE, validateSession } from "./session.ts";

export type AppEnv = {
  Variables: {
    appCtx: AppContext;
    user: UserRow;
    /** Parsed x-todou-agent-context header; null when absent. */
    agentContext: AgentContext | null;
  };
};

/**
 * Resolves the request identity: Bearer PAT first, then session cookie.
 * A malformed or invalid PAT is a hard 401 — it never falls through to the
 * cookie or to any implicit identity, in every auth mode.
 */
export function authMiddleware(ctx: AppContext) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const [scheme, ...rest] = header.split(" ");
      const token = rest.join(" ").trim();
      if (scheme?.toLowerCase() !== "bearer" || token === "") {
        throw new UnauthorizedError("malformed authorization header");
      }
      const user = await verifyPat(ctx.router.system(), token);
      if (!user) throw new UnauthorizedError("invalid token");
      c.set("user", user);
      return next();
    }

    if (ctx.config.auth.mode === "forward") {
      c.set("user", await forwardUser(c, ctx));
      return next();
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) {
      const user = await validateSession(ctx.router.system(), cookie);
      if (user) {
        c.set("user", user);
        return next();
      }
    }
    throw new UnauthorizedError();
  });
}

/**
 * Forward mode: the reverse proxy authenticated the human; every request is
 * resolved from the identity header alone — no session, no cookie. The two
 * 401s stay distinguishable on purpose: "which side is misconfigured" is
 * the first question a forward-auth deployment debugs.
 */
async function forwardUser(c: RequestLike, ctx: AppContext): Promise<UserRow> {
  const forward = ctx.config.auth.forward;
  // user_header presence is enforced by loadConfig in forward mode.
  const userHeader = forward.user_header as string;
  if (!isTrustedRequest(c, ctx.config)) {
    throw new UnauthorizedError(
      "request did not arrive from a trusted proxy (check http.trusted_proxies)",
    );
  }
  const raw = c.req.header(userHeader);
  if (raw === undefined || raw.trim() === "") {
    throw new UnauthorizedError(
      `identity header ${userHeader} missing (the proxy must set it)`,
    );
  }
  const login = normalizeLogin(raw);
  if (login === null) {
    throw new UnauthorizedError(
      `identity header ${userHeader} carries an invalid login`,
    );
  }
  return provisionUser(
    ctx.router.system(),
    {
      login,
      name: forward.name_header ? c.req.header(forward.name_header) : null,
      email: forward.email_header ? c.req.header(forward.email_header) : null,
    },
    { autoCreate: forward.auto_create },
  );
}
