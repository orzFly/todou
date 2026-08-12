import type { Config } from "../config.ts";
import { type RequestLike, requestProto } from "../http/proxy.ts";

export function cookieSecure(c: RequestLike, config: Config): boolean {
  return config.auth.cookie_secure ?? requestProto(c, config) === "https";
}

/**
 * Shared attributes for the session cookie and the transient oidc cookie.
 * SameSite=Lax on purpose: it still rides top-level navigations, which the
 * oidc callback redirect is.
 */
export function sessionCookieAttrs(c: RequestLike, config: Config) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    secure: cookieSecure(c, config),
  };
}
