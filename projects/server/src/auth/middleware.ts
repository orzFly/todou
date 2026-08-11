import type { AgentContext } from "@todou/shared";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppContext } from "../bootstrap.ts";
import { UnauthorizedError } from "../errors.ts";
import { type UserRow, verifyPat } from "./pat.ts";
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
