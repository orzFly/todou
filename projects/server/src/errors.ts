type ErrorStatus =
  | 301
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 413
  | 422
  | 502
  | 503;

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

/** Writing to a card while it is being copied to another project (T-231). */
export class IssueMovingError extends DomainError {
  constructor() {
    super(
      409,
      "issue_moving",
      "this issue is moving to another project — try again in a moment",
    );
  }
}

/**
 * The card moved somewhere the reader has no role, so the response admits
 * that much and no more: never the destination project, never its number.
 */
export class GoneError extends DomainError {
  constructor(body: { moved: true; title?: string }) {
    super(410, "gone", "this issue moved to a project you cannot read", body);
  }
}

/**
 * Markers, not errors: "the thing you asked for moved, work out where it
 * went". They carry only what locating it needs and deliberately do NOT
 * extend DomainError — the destination, the reader's role there and the
 * tombstone's title all take queries, and a throw site deep inside a gate
 * is the wrong place to run them. `respondRelocation` does it once, in the
 * error handler.
 */
export class IssueMovedError extends Error {
  readonly issue: { id: number; projectId: number; number: number };
  readonly forWrite: boolean;
  /**
   * The asker has a role in the project the URL named. False means a 410 is
   * off the table however the destination turns out: it would confirm to a
   * stranger of both projects that this address once held something.
   */
  readonly sourceReadable: boolean;

  constructor(
    issue: { id: number; projectId: number; number: number },
    forWrite: boolean,
    sourceReadable: boolean,
  ) {
    super("issue moved");
    this.issue = issue;
    this.forWrite = forWrite;
    this.sourceReadable = sourceReadable;
  }
}

export class CommentMovedError extends Error {
  readonly projectId: number;
  readonly commentId: number;
  /** See `IssueMovedError.sourceReadable`. */
  readonly sourceReadable: boolean;

  constructor(projectId: number, commentId: number, sourceReadable: boolean) {
    super("comment moved");
    this.projectId = projectId;
    this.commentId = commentId;
    this.sourceReadable = sourceReadable;
  }
}

export class AttachmentMovedError extends Error {
  readonly projectId: number;
  readonly attachmentId: number;
  /** Preserved so the redirect lands on the same route the reader used. */
  readonly variant: "download" | "view";
  readonly filename: string | null;
  /** See `IssueMovedError.sourceReadable`. */
  readonly sourceReadable: boolean;

  constructor(
    projectId: number,
    attachmentId: number,
    variant: "download" | "view",
    filename: string | null,
    sourceReadable: boolean,
  ) {
    super("attachment moved");
    this.projectId = projectId;
    this.attachmentId = attachmentId;
    this.variant = variant;
    this.filename = filename;
    this.sourceReadable = sourceReadable;
  }
}

export type RelocationMarker =
  | IssueMovedError
  | CommentMovedError
  | AttachmentMovedError;

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
