import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";
import {
  AttachmentMovedError,
  CommentMovedError,
  DomainError,
  IssueMovedError,
} from "./errors.ts";
import { respondRelocation } from "./services/relocation.ts";

/**
 * Deliberately not in `errors.ts`, however much it looks like it belongs
 * there: every layer of the server imports those error classes, so that
 * module has to stay a leaf. `respondRelocation` reaches back into the
 * service layer, and importing it from `errors.ts` closes two cycles
 * through `services/relocation.ts` and `services/access.ts` (T-243).
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts any Hono env
export function registerErrorHandler(app: Hono<any> | OpenAPIHono<any>): void {
  app.onError((err, c) => {
    if (
      err instanceof IssueMovedError ||
      err instanceof CommentMovedError ||
      err instanceof AttachmentMovedError
    ) {
      return respondRelocation(c, err);
    }
    if (err instanceof DomainError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details === undefined ? {} : { details: err.details }),
          },
        },
        err.status,
      );
    }
    console.error("unhandled error", err);
    return c.json(
      { error: { code: "internal", message: "internal server error" } },
      500,
    );
  });
}
