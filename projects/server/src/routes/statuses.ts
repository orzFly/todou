import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  minRoleOf,
  ProjectRef,
  Status,
  StatusCreateInput,
  StatusUpdateInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createStatus,
  deleteStatus,
  listStatuses,
  updateStatus,
} from "../services/statuses.ts";
import { roleTag } from "./role-tag.ts";

const slugParam = z.object({ slug: ProjectRef });
const statusParams = z.object({
  slug: ProjectRef,
  statusId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const listRoute = createRoute({
  method: "get",
  path: "/{slug}/statuses",
  summary: "Ordered status set (kanban columns)",
  request: { params: slugParam },
  responses: { 200: { description: "Statuses", ...jsonBody(z.array(Status)) } },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/{slug}/statuses",
  summary: `Create a status ${roleTag("status.manage")}`,
  request: { params: slugParam, body: jsonBody(StatusCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Status) } },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{slug}/statuses/{statusId}",
  summary: `Update or reorder a status ${roleTag("status.manage")}`,
  request: { params: statusParams, body: jsonBody(StatusUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Status) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{slug}/statuses/{statusId}",
  summary: `Delete a status (${minRoleOf("status.manage")}; 409 while issues reference it)`,
  request: { params: statusParams },
  responses: { 204: { description: "Deleted" } },
});

export function statusRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, async (c) =>
    c.json(
      await listStatuses(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    ),
  );

  app.openapi(createRouteDef, async (c) =>
    c.json(
      await createStatus(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      201,
    ),
  );

  app.openapi(patchRoute, async (c) => {
    const { slug, statusId } = c.req.valid("param");
    return c.json(
      await updateStatus(
        c.get("appCtx"),
        c.get("user"),
        slug,
        statusId,
        c.req.valid("json"),
      ),
      200,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const { slug, statusId } = c.req.valid("param");
    await deleteStatus(c.get("appCtx"), c.get("user"), slug, statusId);
    return c.body(null, 204);
  });

  return app;
}
