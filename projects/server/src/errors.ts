import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 502 | 503;

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

/**
 * Taking a slug a project used to hold needs an explicit `reclaim` (T-156).
 * The details name the slug and nothing else: who held it before is not a
 * fact a non-member of that project may learn.
 */
export class SlugReservedError extends DomainError {
  constructor(slug: string) {
    super(
      409,
      "slug_reserved",
      `slug "${slug}" still routes to the project that used it — ` +
        "pass reclaim to take it over",
      { slug },
    );
  }
}

export class ValidationFailedError extends DomainError {
  constructor(message = "validation failed", details?: unknown) {
    super(422, "validation_failed", message, details);
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor(message = "request body too large") {
    super(413, "payload_too_large", message);
  }
}

export class UpstreamError extends DomainError {
  constructor(message = "upstream storage request failed", details?: unknown) {
    super(502, "upstream_storage", message, details);
  }
}

export class CliDistNotConfiguredError extends DomainError {
  constructor() {
    super(
      404,
      "cli_dist_not_configured",
      "this deployment carries no CLI artifacts",
    );
  }
}

/** Writing to a card that is in the trash (T-145) — restore it first. */
export class IssueDeletedError extends DomainError {
  constructor() {
    super(
      409,
      "issue_deleted",
      "this issue is in the trash — restore it before changing it",
    );
  }
}

export class DirectUploadUnavailableError extends DomainError {
  constructor() {
    super(
      409,
      "direct_upload_unavailable",
      "direct upload is not available on this storage backend",
    );
  }
}

export class DirectUploadIncompleteError extends DomainError {
  constructor(reason: "missing" | "size_mismatch") {
    super(
      409,
      "direct_upload_incomplete",
      reason === "missing"
        ? "uploaded object not found in storage"
        : "uploaded object size does not match the declared size",
      { reason },
    );
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
