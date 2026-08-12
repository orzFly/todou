/**
 * Timeline permalink anchors (#38): `#comment-<id>` / `#event-<id>`.
 * The id doubles as the DOM element id, so anchor → element resolution
 * is a plain getElementById.
 */

export type TimelineAnchor = { kind: "comment" | "event"; id: number };

export function commentAnchor(id: number): string {
  return `comment-${id}`;
}

export function eventAnchor(id: number): string {
  return `event-${id}`;
}

export function anchorElementId(anchor: TimelineAnchor): string {
  return `${anchor.kind}-${anchor.id}`;
}

/** Parse a location hash (with or without the leading #). */
export function parseTimelineAnchor(hash: string): TimelineAnchor | null {
  const match = hash.replace(/^#/, "").match(/^(comment|event)-(\d{1,9})$/);
  if (!match) return null;
  return { kind: match[1] as "comment" | "event", id: Number(match[2]) };
}

export type IssuePermalink = {
  slug: string;
  number: number;
  commentId?: number;
};

/**
 * Recognise a pasted same-origin issue URL, optionally pointing at a
 * comment. Only absolute URLs qualify — GFM autolinks are always
 * absolute, and that is the only shape that gets a rich rendering.
 */
export function parseIssuePermalink(
  href: string,
  origin: string,
): IssuePermalink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.search !== "") return null;
  const path = url.pathname.match(
    /^\/projects\/([a-z0-9][a-z0-9-]*)\/issues\/(\d{1,9})\/?$/,
  );
  if (!path) return null;
  const anchor = url.hash === "" ? null : parseTimelineAnchor(url.hash);
  if (url.hash !== "" && anchor?.kind !== "comment") return null;
  return {
    slug: path[1] as string,
    number: Number(path[2]),
    ...(anchor === null ? {} : { commentId: anchor.id }),
  };
}
