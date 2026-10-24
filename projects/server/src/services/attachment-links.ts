/**
 * A markdown link or image whose destination is an attachment on this
 * deployment. Group 5 is optional because the routes answer without a last
 * segment too.
 */
export const ATTACHMENT_LINK =
  /(!?)\[((?:[^\][]|\\.)*)\]\((\/api\/projects\/[^)\s]*?attachments\/(\d+)\/(?:download|view)(?:\/([^)\s?#]+))?)\)/g;

/** Which project a destination names, as either the slug or the id. */
export const ATTACHMENT_OWNER = /\/api\/projects\/([^/]+)\/attachments\//;

/**
 * The attachment ids `text` links, among those addressed to a project
 * spelled one of `owners` — its id as a string, its slug, any former slug.
 * A link to another project's file with the same id is not a link to ours.
 */
export function linkedAttachmentIds(
  text: string,
  owners: ReadonlySet<string>,
): Set<number> {
  const ids = new Set<number>();
  for (const match of text.matchAll(ATTACHMENT_LINK)) {
    const owner = ATTACHMENT_OWNER.exec(match[3] ?? "")?.[1];
    if (owner === undefined || !owners.has(owner)) continue;
    ids.add(Number(match[4]));
  }
  return ids;
}
