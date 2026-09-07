/**
 * Attachment references in markdown are plain relative links to the
 * download API — real URLs, so they keep working in any renderer that
 * doesn't know about them. These helpers recognize and build that shape:
 * /api/projects/<slug|id>/attachments/<id>/download[/<name>]
 *
 * Neither project spelling is a legacy one. The resolve pass anchors what it
 * stores on the project id (T-266), because a slug can be renamed out from
 * under a stored link; a slug spelling is what an author types, and what a
 * body the pass never touched still holds. Telling the two apart is shared's
 * job — a second copy of that rule here is what `ref-shapes.ts` exists to
 * prevent, and getting it wrong is what left every id-anchored reference
 * unrecognized (T-290).
 *
 * Parsing also accepts the /view twin: the attachment list links viewable
 * types there (T-201), so a URL copied out of the UI and pasted into a
 * comment has to render rich too. What we *write* stays /download.
 */

import {
  type Attachment,
  type LinkProject,
  parseInternalHref,
} from "@todou/shared";
import { opensInBrowserTab } from "@/lib/attachment-preview.ts";

/** An attachment address as an href spells it, project segment and all. */
export type AttachmentRef = {
  project: LinkProject;
  id: number;
  /** Decoded cosmetic name segment, when the URL carries one. */
  name: string | null;
};

/**
 * The same address once it has landed on a project. Slug, not id, because
 * that is what an alias records (T-242) and what a reader knows a project by.
 */
export type AttachmentAddress = {
  slug: string;
  id: number;
  name: string | null;
};

/**
 * Whether `address` is one this attachment answers on: its current address,
 * or one it kept across a move or a rename (T-242).
 *
 * Both arms compare the slug as well as the id, which is what keeps a
 * foreign `a/88` from matching a live, unrelated `b/88`.
 */
export function attachmentAnswersTo(
  attachment: Attachment,
  address: AttachmentAddress,
  slug: string,
): boolean {
  if (address.slug === slug && address.id === attachment.id) return true;
  return attachment.aliases.some(
    (alias) => alias.project === address.slug && alias.id === address.id,
  );
}

/**
 * No origin is passed, so same-origin absolute URLs stay unrecognized: where
 * a `public_origin` is configured the resolve pass has already rewritten them
 * to the relative form, and where it is not there is nothing to compare
 * against.
 */
export function parseAttachmentHref(
  href: string | undefined,
): AttachmentRef | null {
  const target = href === undefined ? null : parseInternalHref(href);
  if (target === null || target.kind !== "attachment") return null;
  let name: string | null = null;
  if (target.name !== null && target.name !== "") {
    try {
      name = decodeURIComponent(target.name);
    } catch {
      name = target.name;
    }
  }
  return { project: target.project, id: target.id, name };
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
