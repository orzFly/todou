import type { OpenAPIHono } from "@hono/zod-openapi";
import { PROJECT_NOT_FOUND } from "@todou/shared";
import type { Context, Hono } from "hono";
import type { AppEnv } from "./auth/middleware.ts";
import {
  AttachmentMovedError,
  CommentMovedError,
  DomainError,
  IssueMovedError,
  NotFoundError,
} from "./errors.ts";
import { findProjectByRef, projectRoleOf } from "./services/access.ts";
import { respondRelocation } from "./services/relocation.ts";

/**
 * A project-scoped read may consult relocation records before rejecting a
 * non-member. Normalize only its final 404, after that permission decision;
 * members still need the service's specific issue/comment/spec diagnosis.
 */
async function publicReadError(
  error: DomainError,
  c: Context<AppEnv>,
): Promise<DomainError> {
  const slug = c.req.param("slug");
  const actor = c.get("user");
  if (
    error.status !== 404 ||
    (c.req.method !== "GET" && c.req.method !== "HEAD") ||
    slug === undefined ||
    actor === undefined
  ) {
    return error;
  }
  const ctx = c.get("appCtx");
  const found = await findProjectByRef(ctx, slug);
  if (
    found === null ||
    (await projectRoleOf(ctx, found.project, actor)) === null
  ) {
    return new NotFoundError(PROJECT_NOT_FOUND);
  }
  return error;
}

/**
 * Deliberately not in `errors.ts`, however much it looks like it belongs
 * there: every layer of the server imports those error classes, so that
 * module has to stay a leaf. `respondRelocation` reaches back into the
 * service layer, and importing it from `errors.ts` closes two cycles
 * through `services/relocation.ts` and `services/access.ts` (T-243).
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts any Hono env
export function registerErrorHandler(app: Hono<any> | OpenAPIHono<any>): void {
  app.onError(async (err, c) => {
    let failure: unknown = err;
    if (
      err instanceof IssueMovedError ||
      err instanceof CommentMovedError ||
      err instanceof AttachmentMovedError
    ) {
      try {
        return await respondRelocation(c, err);
      } catch (error) {
        failure = error;
      }
    }
    if (failure instanceof DomainError) {
      const error = await publicReadError(failure, c);
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.status,
      );
    }
    console.error("unhandled error", failure);
    return c.json(
      { error: { code: "internal", message: "internal server error" } },
      500,
    );
  });
}
