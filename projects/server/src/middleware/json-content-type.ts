import type { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { type ZodType, z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { UnsupportedMediaTypeError, ValidationFailedError } from "../errors.ts";

/** zod-openapi's own test for which declared media types are JSON. */
const JSON_TYPE = /^application\/([a-z-.]+\+)?json/i;

/**
 * A route whose declared body is JSON only gets a JSON request (T-620).
 * zod-openapi validates a non-required JSON body only when the Content-Type
 * says JSON; any other type, and no body at all, reaches the handler as an
 * unvalidated `{}`. Marking bodies required would not close it — hono's
 * validator still hands the schema `{}` for a text/plain request, which an
 * all-optional schema accepts — so the check sits in front of all of them
 * instead, read off the route table so no route can forget it.
 *
 * A body-less request is held to the schema as `{}`: it passes exactly
 * where every field is optional, which is what an omitted body means.
 * Routes that also declare a non-JSON type (the multipart uploads) are left
 * to their own validators.
 *
 * `getApp` because the route table only exists once createApp has mounted
 * everything; it is read on the first request.
 */
export function jsonContentType(getApp: () => OpenAPIHono<AppEnv>) {
  let jsonOnly: Map<string, ZodType> | undefined;
  return createMiddleware<AppEnv>(async (c, next) => {
    jsonOnly ??= jsonOnlyRoutes(getApp());
    const method = c.req.method;
    const route = matchedRoutes(c).find((r) => r.method === method);
    const schema = route && jsonOnly.get(`${method} ${route.path}`);
    if (schema === undefined) return next();
    const type = c.req.header("content-type");
    if (type !== undefined ? !JSON_TYPE.test(type) : hasBody(c.req.raw)) {
      throw new UnsupportedMediaTypeError(
        `this endpoint takes an application/json body, not ${type ?? "an untyped one"}`,
      );
    }
    if (type === undefined) {
      const result = schema.safeParse({});
      if (!result.success) {
        throw new ValidationFailedError(
          z.prettifyError(result.error),
          result.error.issues,
        );
      }
    }
    return next();
  });
}

function jsonOnlyRoutes(app: OpenAPIHono<AppEnv>): Map<string, ZodType> {
  const routes = new Map<string, ZodType>();
  for (const def of app.openAPIRegistry.definitions) {
    if (def.type !== "route") continue;
    const content = def.route.request?.body?.content ?? {};
    const types = Object.keys(content);
    if (types.length === 0 || !types.every((t) => JSON_TYPE.test(t))) continue;
    const schema = types
      .map((t) => content[t]?.schema)
      .find((s): s is ZodType => s instanceof z.ZodType);
    if (schema === undefined) continue;
    // The same rewrite zod-openapi applies when it registers the handler.
    const path = def.route.path.replaceAll(/\/{(.+?)}/g, "/:$1");
    routes.set(`${def.route.method.toUpperCase()} ${path}`, schema);
  }
  return routes;
}

/**
 * From the framing headers, not `req.body`: the node adapter hands every
 * non-GET request a stream, so a body-less DELETE would read as having one.
 */
function hasBody(req: Request): boolean {
  const length = req.headers.get("content-length");
  if (length !== null) return Number(length) > 0;
  return req.headers.has("transfer-encoding");
}
