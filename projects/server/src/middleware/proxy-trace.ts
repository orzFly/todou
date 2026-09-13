import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";
import type { AppContext } from "../bootstrap.ts";
import { peerTrust } from "../http/proxy.ts";

const FORWARDED_PREFIX = "x-forwarded-";

/**
 * Degradation is deliberate (T-333): on an untrusted peer, forwarded
 * headers keep being ignored silently — turning that into an error would
 * break the direct-connect deployments that work today. This trace is the
 * whole remedy: it turns a symptom-less situation into a logged one, for
 * the oidc/cookie path where no 401 ever surfaces. The header names in the
 * line are the ones actually present on the request (sorted, so the output
 * does not drift with header enumeration order) — a line claiming to have
 * ignored headers the request never carried lies about its own diagnosis.
 */
export function forwardedHeaderTrace(ctx: AppContext) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const headers = [...c.req.raw.headers.keys()].filter((name) =>
      name.startsWith(FORWARDED_PREFIX),
    );
    if (headers.length === 0) return next();
    const trust = peerTrust(c, ctx.config);
    if (trust.trusted) return next();
    const names = headers.sort().join(", ");
    if (trust.reason === "not-listed") {
      console.error(
        `proxy headers ignored: ${names} arrived from peer ${trust.addr}, which is not in http.trusted_proxies`,
      );
    } else {
      console.error(
        `proxy headers ignored: ${names} arrived on a request with no peer address`,
      );
    }
    return next();
  });
}
