/**
 * Attachment references in markdown are plain relative links to the
 * download API — real URLs, so they keep working in any renderer that
 * doesn't know about them. These helpers recognize and build that shape:
 * /api/projects/<slug>/attachments/<id>/download[/<name>]
 *
 * Parsing also accepts the /view twin: the attachment list links viewable
 * types there (T-201), so a URL copied out of the UI and pasted into a
 * comment has to render rich too. What we *write* stays /download.
 */

import { opensInBrowserTab } from "@/lib/attachment-preview.ts";

export type AttachmentRef = {
  slug: string;
  id: number;
  /** Decoded cosmetic name segment, when the URL carries one. */
  name: string | null;
};

const ATTACHMENT_HREF =
  /^\/api\/projects\/([a-z0-9][a-z0-9-]*)\/attachments\/(\d{1,9})\/(?:download|view)(?:\/([^/?#]+))?$/;

export function parseAttachmentHref(
  href: string | undefined,
): AttachmentRef | null {
  const match = href?.match(ATTACHMENT_HREF);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  let name: string | null = null;
  if (match[3] !== undefined) {
    try {
      name = decodeURIComponent(match[3]);
    } catch {
      name = match[3];
    }
  }
  return { slug: match[1], id: Number(match[2]), name };
}

export function attachmentHref(
  slug: string,
  id: number,
  filename: string,
): string {
  return `/api/projects/${slug}/attachments/${id}/download/${encodeFilenameSegment(filename)}`;
}

/**
 * The inline-view twin of a download URL (T-58): same bytes served with an
 * inline disposition and a CSP sandbox, for HTML readers and open-in-tab.
 */
export function viewHrefFromDownload(url: string): string {
  return url.replace(/\/download(\/|$)/, "/view$1");
}

/**
 * Where an attachment anchor points: /view for types a tab renders inline,
 * so middle-click and ctrl-click show the file instead of downloading it
 * (T-201); /download for everything else, whose only inline behavior would
 * be a download anyway.
 */
export function attachmentAnchorHref(target: {
  url: string;
  content_type?: string;
}): string {
  return opensInBrowserTab(target)
    ? viewHrefFromDownload(target.url)
    : target.url;
}

/**
 * encodeURIComponent leaves ( ) ' ! * alone; parentheses would terminate
 * a markdown `](…)` destination early, so encode them too.
 */
export function encodeFilenameSegment(filename: string): string {
  return encodeURIComponent(filename)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

/** Markdown image marker for an uploaded attachment — embeds inline. */
export function attachmentImageMarker(filename: string, url: string): string {
  return `![${escapeLinkText(filename)}](${url})`;
}

/** Markdown link marker for a non-image attachment — renders as a rich link. */
export function attachmentLinkMarker(filename: string, url: string): string {
  return `[${escapeLinkText(filename)}](${url})`;
}

function escapeLinkText(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
