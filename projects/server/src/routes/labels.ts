import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Label,
  LabelCreateInput,
  LabelUpdateInput,
  ProjectSlug,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
} from "../services/labels.ts";

const slugParam = z.object({ slug: ProjectSlug });
const labelParams = z.object({
  slug: ProjectSlug,
  labelId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const listRoute = createRoute({
  method: "get",
  path: "/{slug}/labels",
  summary: "Project labels",
  request: { params: slugParam },
  responses: { 200: { description: "Labels", ...jsonBody(z.array(Label)) } },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/{slug}/labels",
  summary: "Create a label (admin)",
  request: { params: slugParam, body: jsonBody(LabelCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Label) } },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{slug}/labels/{labelId}",
  summary: "Update a label (admin)",
  request: { params: labelParams, body: jsonBody(LabelUpdateInput) },
  responses: { 200: { description: "Updated", ...jsonBody(Label) } },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{slug}/labels/{labelId}",
  summary: "Delete a label (admin)",
  request: { params: labelParams },
  responses: { 204: { description: "Deleted" } },
});

export function labelRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listRoute, async (c) =>
    c.json(
      await listLabels(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    ),
  );

  app.openapi(createRouteDef, async (c) =>
    c.json(
      await createLabel(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      201,
    ),
  );

  app.openapi(patchRoute, async (c) => {
    const { slug, labelId } = c.req.valid("param");
    return c.json(
      await updateLabel(
        c.get("appCtx"),
        c.get("user"),
        slug,
        labelId,
        c.req.valid("json"),
      ),
      200,
    );
  });

  app.openapi(deleteRoute, async (c) => {
    const { slug, labelId } = c.req.valid("param");
    await deleteLabel(c.get("appCtx"), c.get("user"), slug, labelId);
    return c.body(null, 204);
  });

  return app;
}
