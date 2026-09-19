import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
  BurnQuery,
  BurnResponse,
  ErrorBody,
  ProjectRef,
  PutSettings,
  Settings,
} from "@todou/shared";
import type { Context } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { ValidationFailedError } from "../errors.ts";
import { getProjectActivityCalendar } from "../services/activity-calendar/index.ts";
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

const getActivityRoute = createRoute({
  method: "get",
  path: "/{slug}/insights/activity",
  summary: `Current-card activity calendar ${roleTag("activity.read")}`,
  request: { params, query: ActivityCalendarQuery },
  responses: {
    200: {
      description: "Calendar and selected-day cards",
      ...jsonBody(ActivityCalendarResponse),
    },
    401: { description: "Authentication required", ...jsonBody(ErrorBody) },
    403: { description: "Read capability required", ...jsonBody(ErrorBody) },
    404: { description: "Project not found", ...jsonBody(ErrorBody) },
    409: { description: "Activity changed; restart", ...jsonBody(ErrorBody) },
    422: { description: "Invalid activity query", ...jsonBody(ErrorBody) },
    500: { description: "Database read failed", ...jsonBody(ErrorBody) },
  },
});

export function insightsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.openapi(
    getActivityRoute,
    async (c) =>
      c.json(
        await getProjectActivityCalendar(
          c.get("appCtx"),
          c.get("user"),
          c.req.valid("param").slug,
          c.req.valid("query"),
        ),
        200,
      ),
    // An explicit route hook overrides this router's burn-specific 400 hook.
    (result) => {
      if (!result.success) {
        throw new ValidationFailedError(
          z.prettifyError(result.error),
          result.error.issues,
        );
      }
      return undefined;
    },
  );
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
