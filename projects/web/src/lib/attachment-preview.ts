/**
 * Preview-eligibility rules for attachments. Pure module (no React) so the
 * markdown pipeline, attachment lists, and tests can all share one answer
 * to "what happens when this file is clicked/embedded".
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
};

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Highlighting a multi-megabyte file would freeze the tab (#31), so bigger
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
  // application/octet-stream until #27's hotfix) fall back to the filename.
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

/** HTML gets the sandboxed reader (#58) instead of a source view. */
export function isHtmlDocument(attachment: {
  filename: string;
  content_type?: string;
}): boolean {
  const type = attachment.content_type ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  return hasGenericType(type) && /\.(html?|xhtml)$/i.test(attachment.filename);
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
