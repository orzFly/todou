import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../auth/middleware.ts";
import type { Config } from "../config.ts";
import { PayloadTooLargeError } from "../errors.ts";
import { AVATAR_MAX_BYTES } from "../services/profile.ts";

const MB = 1024 * 1024;

/**
 * Multipart framing (boundary lines, part headers, sibling form fields)
 * rides on top of the file bytes, so upload routes get this much slack
 * beyond their file cap. The per-file size checks in the services stay
 * authoritative; these limits only bound what a request may buffer.
 */
const MULTIPART_SLACK_BYTES = 64 * 1024;

/**
 * hono's bodyLimit rejects on the content-length header without reading
 * the body, and cuts chunked bodies off at maxSize mid-stream — either
 * way the request can no longer buffer past the limit (T-70). Its default
 * rejection is a bare-text 413; throwing here routes it through the
 * uniform error body instead.
 */
function limitTo(maxBytes: number, message: string) {
  return bodyLimit({
    maxSize: maxBytes,
    onError: () => {
      throw new PayloadTooLargeError(message);
    },
  });
}

function scopedLimit(maxBytes: number, message: string) {
  const limit = limitTo(maxBytes, message);
  return createMiddleware<AppEnv>((c, next) => {
    c.set("bodyLimitScoped", true);
    return limit(c, next);
  });
}

/** Attachment uploads: storage.max_upload_mb plus multipart slack. */
export function uploadBodyLimit(config: Config) {
  const maxMb = config.storage.max_upload_mb;
  return scopedLimit(
    maxMb * MB + MULTIPART_SLACK_BYTES,
    `upload exceeds the ${maxMb} MB limit`,
  );
}

/** Avatar uploads: the fixed avatar cap plus multipart slack. */
export function avatarBodyLimit() {
  return scopedLimit(
    AVATAR_MAX_BYTES + MULTIPART_SLACK_BYTES,
    `avatar exceeds the ${AVATAR_MAX_BYTES / MB} MB limit`,
  );
}

/**
 * Everything else on the API speaks JSON and has no business approaching
 * upload sizes. Registered API-wide; stands down where a route-scoped
 * upload limit already applies.
 */
export function jsonBodyLimit(config: Config) {
  const maxMb = config.http.max_json_body_mb;
  const limit = limitTo(
    maxMb * MB,
    `request body exceeds the ${maxMb} MB limit`,
  );
  return createMiddleware<AppEnv>((c, next) =>
    c.get("bodyLimitScoped") ? next() : limit(c, next),
  );
}
