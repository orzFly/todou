import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Autolink,
  AutolinkCreateInput,
  ProjectSlug,
  ReferenceConfig,
  RefFormatSetInput,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import {
  createAutolink,
  deleteAutolink,
  getReferenceConfig,
  setReferenceFormat,
} from "../services/reference-config.ts";
import { roleTag } from "./role-tag.ts";

const slugParam = z.object({ slug: ProjectSlug });
const autolinkParams = z.object({
  slug: ProjectSlug,
  autolinkId: z.coerce.number().int().positive(),
});
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const configRoute = createRoute({
  method: "get",
  path: "/{slug}/references/config",
  summary: "Reference format and autolink rules",
  request: { params: slugParam },
  responses: {
    200: { description: "Config", ...jsonBody(ReferenceConfig) },
  },
});

const formatRoute = createRoute({
  method: "put",
  path: "/{slug}/references/format",
  summary: `Set the internal reference format ${roleTag("reference.manage")}`,
  request: { params: slugParam, body: jsonBody(RefFormatSetInput) },
  responses: {
    200: { description: "Updated config", ...jsonBody(ReferenceConfig) },
  },
});

const createAutolinkRoute = createRoute({
  method: "post",
  path: "/{slug}/references/autolinks",
  summary: `Add an autolink rule ${roleTag("reference.manage")}`,
  request: { params: slugParam, body: jsonBody(AutolinkCreateInput) },
  responses: { 201: { description: "Created", ...jsonBody(Autolink) } },
});

const deleteAutolinkRoute = createRoute({
  method: "delete",
  path: "/{slug}/references/autolinks/{autolinkId}",
  summary: `Remove an autolink rule ${roleTag("reference.manage")}`,
  request: { params: autolinkParams },
  responses: { 204: { description: "Deleted" } },
});

export function referenceRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(configRoute, async (c) =>
    c.json(
      await getReferenceConfig(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    ),
  );

  app.openapi(formatRoute, async (c) =>
    c.json(
      await setReferenceFormat(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      200,
    ),
  );

  app.openapi(createAutolinkRoute, async (c) =>
    c.json(
      await createAutolink(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      201,
    ),
  );

  app.openapi(deleteAutolinkRoute, async (c) => {
    const { slug, autolinkId } = c.req.valid("param");
    await deleteAutolink(c.get("appCtx"), c.get("user"), slug, autolinkId);
    return c.body(null, 204);
  });

  return app;
}
