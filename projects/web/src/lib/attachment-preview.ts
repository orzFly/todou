/**
 * What an attachment is, and what clicking it does: preview-eligibility
 * rules, plus the coarse kind an icon is drawn from. Pure module (no React)
 * so the markdown pipeline, attachment lists, icons and tests all share one
 * answer — `hasGenericType`, "a declared content type outranks the
 * filename", is the rule a second copy elsewhere would fork.
 */

/**
 * Anything with a name and a URL can be previewed; content type and size
 * are extras that markdown references may not know before the attachments
 * query resolves.
 */
export type PreviewTarget = {
  filename: string;
  url: string;
  content_type?: string;
  size?: number;
  /** Upload time; anchors markdown ref parsing (T-80 time cutoff). */
  created_at?: string;
};

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Highlighting a multi-megabyte file would freeze the tab (T-31), so bigger
 * text attachments are download-only everywhere.
 */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

// Text formats the CLI/browser labels with an application/* type.
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/sql",
  "application/x-sh",
]);

// The CLI's extension→mime table only covers a handful of formats, so code
// files usually upload as application/octet-stream and only the filename
// says they are text.
const TEXT_EXTENSION =
  /\.(txt|log|md|markdown|csv|tsv|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|diff|patch|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs|go|java|kt|kts|c|h|cpp|hpp|cc|hh|cs|php|swift|scala|clj|ex|exs|erl|hs|ml|lua|pl|r|jl|nix|zig|sql|graphql|proto|sh|bash|zsh|fish|ps1|bat|cmd|vue|svelte|astro|tex|lock|mmd|mermaid)$/i;

function hasGenericType(contentType: string): boolean {
  return contentType === "" || contentType === "application/octet-stream";
}

export function isPreviewableImage(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type.startsWith("image/")) return true;
  // Uploads that arrived without a real content type (the CLI sent
  // application/octet-stream until T-27's hotfix) fall back to the filename.
  return hasGenericType(type) && IMAGE_EXTENSION.test(attachment.filename);
}

/** Text by declared type, or by filename when the type is generic. */
export function isTextDocument(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type.startsWith("text/")) return true;
  if (TEXT_APPLICATION_TYPES.has(type)) return true;
  return hasGenericType(type) && TEXT_EXTENSION.test(attachment.filename);
}

/**
 * Names whose image-syntax reference embeds a document card rather than an
 * `<img>`. Images keep winning ties like .svg, which is both.
 */
export function isTextEmbedName(name: string): boolean {
  return (
    !isPreviewableImage({ filename: name }) &&
    isTextDocument({ filename: name })
  );
}

/** Markdown gets our own MarkdownView instead of a code view. */
export function isMarkdownDocument(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  return (
    attachment.content_type === "text/markdown" ||
    /\.(md|markdown)$/i.test(attachment.filename)
  );
}

/** HTML gets the sandboxed reader (T-58) instead of a source view. */
export function isHtmlDocument(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  return hasGenericType(type) && /\.(html?|xhtml)$/i.test(attachment.filename);
}

// Archive types as the CLI, the browser and the common upload tools spell
// them; the same format arrives under several names depending on which one
// did the labelling.
const ARCHIVE_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
]);

const ARCHIVE_EXTENSION = /\.(zip|tar|gz|tgz|bz2|tbz|tbz2|xz|txz|7z|rar|zst)$/i;

const AUDIO_EXTENSION = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|wma|aif|aiff)$/i;

/**
 * `ts` is deliberately missing: it is MPEG transport stream and TypeScript
 * both, and TEXT_EXTENSION claims it. A source file the CLI uploaded as
 * application/octet-stream must not come back as a video.
 */
const VIDEO_EXTENSION = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|mpg|mpeg)$/i;

/** Archive by declared type, or by filename when the type is generic. */
export function isArchiveFile(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (ARCHIVE_TYPES.has(type)) return true;
  return hasGenericType(type) && ARCHIVE_EXTENSION.test(attachment.filename);
}

/** Audio by declared type, or by filename when the type is generic. */
export function isAudioFile(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type.startsWith("audio/")) return true;
  return hasGenericType(type) && AUDIO_EXTENSION.test(attachment.filename);
}

/** Video by declared type, or by filename when the type is generic. */
export function isVideoFile(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type.startsWith("video/")) return true;
  return hasGenericType(type) && VIDEO_EXTENSION.test(attachment.filename);
}

/**
 * What a plain click on this attachment opens: an image lightbox, the
 * sandboxed HTML reader, a text preview, or nothing (native download).
 * Text needs a known in-limit size — an unresolved markdown reference
 * stays a download link until the attachments query fills in the numbers.
 * HTML has no size cap: the browser streams it into the iframe instead of
 * this tab highlighting it.
 */
export function previewKind(target: {
  filename: string;
  content_type?: string;
  size?: number;
}): "image" | "html" | "text" | null {
  if (isPreviewableImage(target)) return "image";
  if (isHtmlDocument(target)) return "html";
  if (
    isTextDocument(target) &&
    target.size !== undefined &&
    target.size <= TEXT_PREVIEW_MAX_BYTES
  ) {
    return "text";
  }
  return null;
}

// application/* subtypes a top-level tab renders inline, each one measured
// against the /view route rather than assumed (T-201). pdf is in: the built-in
// viewer works even under the route's CSP sandbox.
const VIEWABLE_APPLICATION_TYPES = new Set([
  "application/xhtml+xml",
  "application/json",
  "application/xml",
  "application/pdf",
]);

/**
 * Whether /view would render this in a top-level tab, deciding where an
 * anchor points — a separate question from `previewKind`, which decides what
 * an in-app click opens. No filename fallback here: /view answers `nosniff`,
 * so the stored content type is the only thing the browser will act on, and a
 * generic type (octet-stream, empty) downloads either way — via /view it
 * would just lose the S3 presign offload.
 */
export function opensInBrowserTab(target: { content_type?: string }): boolean {
  const type = target.content_type ?? "";
  return (
    type.startsWith("image/") ||
    type.startsWith("text/") ||
    VIEWABLE_APPLICATION_TYPES.has(type)
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
