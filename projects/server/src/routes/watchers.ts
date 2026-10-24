import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  ProjectRef,
  ProjectWatchers,
  type Watcher,
  WatchersOverview,
} from "@todou/shared";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import type { AppContext } from "../bootstrap.ts";
import { users } from "../db/system-schema.ts";
import type { WatcherView } from "../events/watchers.ts";
import {
  accessibleProjectRows,
  requireCapability,
} from "../services/access.ts";
import { toUserRef } from "../services/users.ts";

const overviewRoute = createRoute({
  method: "get",
  path: "/watchers",
  summary:
    "Live agent watchers (T-540): the project-level watchers — `project` " +
    "and `all_projects` scope — of every project the caller can read, keyed " +
    "by slug. Projects without any are absent.",
  responses: {
    200: {
      description: "Project-level watchers per project",
      content: { "application/json": { schema: WatchersOverview } },
    },
  },
});

const projectRoute = createRoute({
  method: "get",
  path: "/projects/{slug}/watchers",
  summary:
    "Live agent watchers of one project (T-540): `project` holds the " +
    "project-level watchers, `issues` the card-level ones keyed by card " +
    "number. Neither includes the other.",
  request: { params: z.object({ slug: ProjectRef }) },
  responses: {
    200: {
      description: "Project-level and card-level watchers",
      content: { "application/json": { schema: ProjectWatchers } },
    },
  },
});

/**
 * Accounts and their owners read once per response, however many watchers
 * share them, and read now rather than when the watch connected (T-571).
 */
async function toWatchers(
  ctx: AppContext,
  lists: WatcherView[][],
): Promise<(views: WatcherView[]) => Watcher[]> {
  const system = ctx.router.system();
  const userIds = new Set(lists.flat().map((view) => view.userId));
  const rows =
    userIds.size === 0
      ? []
      : await system
          .select()
          .from(users)
          .where(inArray(users.id, [...userIds]));
  const userById = new Map(rows.map((row) => [row.id, row]));
  const ownerIds = new Set<number>();
  for (const row of rows) if (row.ownerId !== null) ownerIds.add(row.ownerId);
  const owners =
    ownerIds.size === 0
      ? []
      : await system
          .select({ id: users.id, login: users.login })
          .from(users)
          .where(inArray(users.id, [...ownerIds]));
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  return (views) =>
    views.flatMap((view) => {
      const row = userById.get(view.userId);
      if (row === undefined) return [];
      return [
        {
          user: toUserRef(
            row,
            row.ownerId === null ? null : (ownerById.get(row.ownerId) ?? null),
          ),
          agent_context: view.agentContext,
          kind: view.kind,
          scope: view.scope,
          since: view.since.toISOString(),
        },
      ];
    });
}

export function watcherRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(overviewRoute, async (c) => {
    const ctx = c.get("appCtx");
    const rows = await accessibleProjectRows(ctx, c.get("user"));
    const found: Array<[string, WatcherView[]]> = [];
    for (const row of rows) {
      const list = ctx.watchers.projectWatchers(row.id);
      if (list.length > 0) found.push([row.slug, list]);
    }
    const convert = await toWatchers(
      ctx,
      found.map(([, list]) => list),
    );
    const projects: Record<string, Watcher[]> = {};
    for (const [slug, list] of found) projects[slug] = convert(list);
    return c.json({ projects }, 200);
  });

  app.openapi(projectRoute, async (c) => {
    const ctx = c.get("appCtx");
    const { project } = await requireCapability(
      ctx,
      c.get("user"),
      c.req.valid("param").slug,
      "project.read",
    );
    const level = ctx.watchers.projectWatchers(project.id);
    const cards = ctx.watchers.issueWatchers(project.id);
    const convert = await toWatchers(ctx, [level, ...cards.values()]);
    const issues: Record<string, Watcher[]> = {};
    for (const [number, list] of cards) issues[String(number)] = convert(list);
    return c.json({ project: convert(level), issues }, 200);
  });

  return app;
}
