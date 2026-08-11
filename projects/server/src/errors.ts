import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422;

export class DomainError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: ErrorStatus,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "authentication required") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "insufficient permissions") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "not found") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "conflict", details?: unknown) {
    super(409, "conflict", message, details);
  }
}

export class ValidationFailedError extends DomainError {
  constructor(message = "validation failed", details?: unknown) {
    super(422, "validation_failed", message, details);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: accepts any Hono env
export function registerErrorHandler(app: Hono<any> | OpenAPIHono<any>): void {
  app.onError((err, c) => {
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
