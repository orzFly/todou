import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  BurnQuery,
  BurnResponse,
  ProjectRef,
  PutSettings,
  Settings,
} from "@todou/shared";
import type { Context } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { getInsightsBurn } from "../services/insights.ts";
import {
  getInsightsSettings,
  updateInsightsSettings,
} from "../services/insights-settings.ts";
import { roleTag } from "./role-tag.ts";

const params = z.strictObject({ slug: ProjectRef });
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

// This API contract uses 400 for malformed insight filters and mappings.
// Keep the application-wide 422 behavior unchanged for every other route.
type ValidationResult =
  | { success: true; data: unknown }
  | { success: false; error: z.ZodError };

const validationHook = (result: ValidationResult, c: Context<AppEnv>) => {
  if (!result.success) {
    return c.json(
      {
        error: {
          code: "validation_failed",
          message: z.prettifyError(result.error),
          details: result.error.issues,
        },
      },
      400,
    );
  }
};

const getSettingsRoute = createRoute({
  method: "get",
  path: "/{slug}/insights/settings",
  summary: `Burn-chart status roles ${roleTag("status.list")}`,
  request: { params },
  responses: {
    200: { description: "Effective insights settings", ...jsonBody(Settings) },
  },
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/{slug}/insights/settings",
  summary: `Replace burn-chart status roles ${roleTag("status.manage")}`,
  request: { params, body: jsonBody(PutSettings) },
  responses: {
    200: { description: "Saved insights settings", ...jsonBody(Settings) },
  },
});

const getBurnRoute = createRoute({
  method: "get",
  path: "/{slug}/insights/burn",
  summary: `Current-cohort burn chart ${roleTag("activity.read")}`,
  request: { params, query: BurnQuery },
  responses: {
    200: { description: "Burn chart buckets", ...jsonBody(BurnResponse) },
  },
});

export function insightsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.openapi(getSettingsRoute, async (c) =>
    c.json(
      await getInsightsSettings(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
      ),
      200,
    ),
  );
  app.openapi(putSettingsRoute, async (c) =>
    c.json(
      await updateInsightsSettings(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("json"),
      ),
      200,
    ),
  );
  app.openapi(getBurnRoute, async (c) =>
    c.json(
      await getInsightsBurn(
        c.get("appCtx"),
        c.get("user"),
        c.req.valid("param").slug,
        c.req.valid("query"),
      ),
      200,
    ),
  );
  return app;
}
