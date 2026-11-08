import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";
import type { Config } from "../config.ts";
import { CrossOriginRequestError } from "../errors.ts";
import { selfHosts } from "../http/proxy.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses state changes a browser sends on behalf of another site (T-620).
 * Cookie SameSite cannot be the defence: forward mode never sees the
 * proxy's cookie, some proxies have no cookie at all, and Lax still lets a
 * sibling subdomain through.
 *
 * Sec-Fetch-Site is the browser's own verdict and pages cannot forge it, so
 * where it is present it decides alone. Only browsers that predate it fall
 * back to comparing Origin's host — never its scheme, which a TLS-terminating
 * proxy leaves the server unable to know. A request with neither header did
 * not come from a browser page, which is the CLI, curl, and the batch
 * gateway's own sub-requests.
 *
 * A Bearer token exempts the request outright: a browser never attaches one
 * by itself, and a page that sets it by hand needs a CORS preflight this
 * server never grants. Only Bearer — HTTP Basic in front of a forward-auth
 * proxy is replayed by the browser on any site's form.
 */
export function crossOriginGuard(config: Config) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const scheme = c.req.header("authorization")?.split(" ", 1)[0];
    if (scheme?.toLowerCase() === "bearer") return next();

    const site = c.req.header("sec-fetch-site");
    if (site !== undefined) {
      // "none" is a user-initiated request with no initiating page at all.
      if (site === "same-origin" || site === "none") return next();
      throw new CrossOriginRequestError();
    }
    const origin = c.req.header("origin");
    if (origin === undefined) return next();
    if (!selfHosts(c, config).has(hostOf(origin))) {
      throw new CrossOriginRequestError();
    }
    return next();
  });
}

/** "" for an opaque origin ("null") or anything unparseable: never a match. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
