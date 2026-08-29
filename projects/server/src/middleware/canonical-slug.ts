import { CANONICAL_SLUG_HEADER } from "@todou/shared";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";
import { projects } from "../db/system-schema.ts";
import { findProjectBySlug } from "../services/access.ts";

/**
 * Tells a client it reached the project by a slug the project no longer
 * uses, so it can migrate (the web app redirects, the CLI prints a note).
 *
 * Services take a slug and no request context, which is why this rides at
 * the routing layer instead: one indexed point lookup on the live slug — the
 * case for nearly every request — and only a miss pays for the history
 * lookup that `findProjectBySlug` will repeat inside the handler.
 */
export function canonicalSlugMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requested = c.req.param("slug");
    if (requested === undefined) return next();
    const ctx = c.get("appCtx");
    const live = await ctx.router
      .system()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, requested));
    if (live.length > 0) return next();

    const found = await findProjectBySlug(ctx, requested);
    await next();
    // A 404 or a 403 must not confirm that the slug ever existed.
    if (found !== null && c.res.ok) {
      c.res.headers.set(CANONICAL_SLUG_HEADER, found.project.slug);
    }
  });
}
