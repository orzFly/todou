import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CliAuthApproveInput,
  CliAuthApproveResult,
  CliAuthPollInput,
  CliAuthPollResult,
  CliAuthRequestCreated,
  CliAuthRequestCreateInput,
  CliAuthRequestInfo,
} from "@todou/shared";
import type { AppEnv } from "../auth/middleware.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  approveCliAuthRequest,
  createCliAuthRequest,
  denyCliAuthRequest,
  pollCliAuthRequest,
  readCliAuthRequestByCode,
} from "../services/cli-auth.ts";

const idParam = z.object({ id: z.coerce.number().int().positive() });
// Deliberately loose: the page's URL carries the dashed display form, and
// the service normalizes before looking anything up.
const codeParam = z.object({ code: z.string().min(1).max(32) });
const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const createRequestRoute = createRoute({
  method: "post",
  path: "/cli/requests",
  summary:
    "Start a browser authorization for a CLI that has no credentials yet " +
    "(public). Returns the one-time code to show the user and the secret " +
    "to poll with.",
  request: { body: jsonBody(CliAuthRequestCreateInput) },
  responses: {
    201: { description: "Request created", ...jsonBody(CliAuthRequestCreated) },
  },
});

const pollRequestRoute = createRoute({
  method: "post",
  path: "/cli/requests/{id}/poll",
  summary:
    "Collect the outcome of a pending authorization (public; the poll " +
    "secret is the credential). The token is minted here and the request " +
    "consumed, so an outcome is collectable exactly once.",
  request: { params: idParam, body: jsonBody(CliAuthPollInput) },
  responses: {
    200: { description: "Current outcome", ...jsonBody(CliAuthPollResult) },
  },
});

const byCodeRoute = createRoute({
  method: "get",
  path: "/cli/requests/by-code/{code}",
  summary:
    "What the authorization page shows for a one-time code, so the user " +
    "can check it against their terminal",
  request: { params: codeParam },
  responses: {
    200: { description: "Pending request", ...jsonBody(CliAuthRequestInfo) },
  },
});

const approveRoute = createRoute({
  method: "post",
  path: "/cli/requests/{id}/approve",
  summary:
    "Authorize a pending CLI request as myself, an agent I own, or a new " +
    "agent created here",
  request: { params: idParam, body: jsonBody(CliAuthApproveInput) },
  responses: {
    200: { description: "Approved", ...jsonBody(CliAuthApproveResult) },
  },
});

const denyRoute = createRoute({
  method: "post",
  path: "/cli/requests/{id}/deny",
  summary:
    "Refuse a pending CLI request, so the waiting terminal fails at once " +
    "instead of timing out",
  request: { params: idParam },
  responses: { 204: { description: "Denied" } },
});

/** Mounted before the auth guard: the caller is a CLI with no token yet. */
export function cliAuthPublicRoutes(ctx: AppContext) {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(createRequestRoute, async (c) => {
    const db = ctx.router.system();
    return c.json(await createCliAuthRequest(db, c.req.valid("json")), 201);
  });

  app.openapi(pollRequestRoute, async (c) => {
    const db = ctx.router.system();
    const { id } = c.req.valid("param");
    const { poll_secret } = c.req.valid("json");
    return c.json(await pollCliAuthRequest(db, id, poll_secret), 200);
  });

  return app;
}

/** Mounted after the auth guard: these are the browser's half of the flow. */
export function cliAuthSessionRoutes() {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(byCodeRoute, async (c) => {
    const db = c.get("appCtx").router.system();
    const { code } = c.req.valid("param");
    return c.json(await readCliAuthRequestByCode(db, code), 200);
  });

  app.openapi(approveRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { target } = c.req.valid("json");
    const approved = await approveCliAuthRequest(
      c.get("appCtx"),
      c.get("user"),
      id,
      target,
    );
    return c.json(approved, 200);
  });

  app.openapi(denyRoute, async (c) => {
    const { id } = c.req.valid("param");
    await denyCliAuthRequest(c.get("appCtx").router.system(), id);
    return c.body(null, 204);
  });

  return app;
}
