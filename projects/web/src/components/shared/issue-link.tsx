import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatRef, type LinkTarget, parseInternalHref } from "@todou/shared";
import { CircleDotIcon, CircleSlashIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
} from "@/api/issue-refs.ts";
import { useRefPlacement } from "@/api/prefs.ts";
import { projectsQuery } from "@/api/queries.ts";
import { referenceConfigQuery } from "@/api/references.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { qualifiedRefSpelling } from "@/lib/issue-refs.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

/**
 * GitHub-style rich issue reference: status icon, title and muted ref once
 * the batched lookup lands (in the viewer's preferred order, T-153), a
 * plain ref link while it loads, and plain text when the number matches no
 * issue the viewer may see. With
 * `commentId` the link deep-links to that comment's anchor and reads "… ·
 * comment by X". Spelling is a UI string, so it always uses the project's
 * CURRENT format (T-80) — only user-authored text is anchored to its
 * created_at.
 *
 * A reference names a card, not an address: `slug`/`number` are where it was
 * written, which is only how the row is found, while everything the reader
 * sees names where that card is now. Spelling one that moved at its written
 * address hands the reader a project and a number that today belong to a
 * different card — or to none.
 *
 * `asWritten` is the one exception, for a sentence that really is about an
 * address rather than a card: a migration's source and destination, which
 * following the card would collapse onto the card being read.
 */
export function IssueLink({
  slug,
  number,
  commentId,
  pageSlug,
  asWritten = false,
  fallback,
}: {
  slug: string;
  number: number;
  commentId?: number;
  /**
   * The project the reader is on; `undefined` off any project page, which
   * spells every ref in full. No default: a caller that forgot it would
   * silently inherit "wherever this was written is home".
   */
  pageSlug: string | undefined;
  asWritten?: boolean;
  /** Literal text to show when the ref resolves to nothing; defaults to the spelling. */
  fallback?: string;
}) {
  const ref = useQuery(issueRefQuery(slug, number));
  // Where the card is NOW. A stored link is anchored on an address that
  // never changes, so following one after a move would spend a redirect;
  // pointing the anchor at the current address spends none.
  const at = ref.data?.at;
  const toSlug = at?.slug ?? slug;
  const toNumber = at?.number ?? number;
  const shownSlug = asWritten ? slug : toSlug;
  const shownNumber = asWritten ? number : toNumber;
  const config = useQuery(referenceConfigQuery(shownSlug));
  const comment = useQuery({
    ...commentRefQuery(slug, number, commentId ?? 0),
    enabled: commentId !== undefined,
  });
  const refLeads = useRefPlacement("reference") === "before";
  const prefix = config.data?.format.prefix ?? null;
  const crossProject = shownSlug !== pageSlug;
  const spelled = crossProject
    ? qualifiedRefSpelling(shownSlug, prefix, shownNumber)
    : formatRef(prefix, shownNumber);

  // Across projects a failed lookup degrades exactly like a miss: a link
  // the viewer cannot follow would announce that the project exists
  // (T-150). Within this project the reader demonstrably has access, so a
  // transient failure keeps the link rather than swallowing it.
  if (ref.data === null || (crossProject && ref.isError)) {
    return <>{fallback ?? spelled}</>;
  }

  const item = ref.data;
  const commentNote =
    commentId === undefined
      ? null
      : comment.data
        ? `· comment by ${displayNameOf(comment.data.author)}`
        : "· comment";
  // Leading the title, the ref has already been spelled once; repeating it
  // after would read as two refs. What trails is then the comment note alone,
  // and with no comment there is nothing left to render.
  const trailing = [refLeads && item ? null : spelled, commentNote]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug: toSlug, number: String(toNumber) }}
      hash={commentId === undefined ? undefined : commentAnchor(commentId)}
      // The timeline owns anchor positioning (highlight + lazy page
      // loading); the router's own scroll would race it.
      hashScrollIntoView={false}
      data-issue-link={shownNumber}
      data-issue-project={crossProject ? shownSlug : undefined}
      data-comment-link={commentId}
      className="font-medium hover:underline"
      title={
        item
          ? refLeads
            ? `${spelled} ${item.title} (${item.status.name})`
            : `${item.title} ${spelled} (${item.status.name})`
          : undefined
      }
    >
      {item && (
        <>
          {item.status.category === "closed" ? (
            <CircleSlashIcon
              aria-hidden
              className="mr-0.5 inline size-3.5 align-[-0.185em]"
              style={{ color: item.status.color }}
            />
          ) : (
            <CircleDotIcon
              aria-hidden
              className="mr-0.5 inline size-3.5 align-[-0.185em]"
              style={{ color: item.status.color }}
            />
          )}
          {refLeads && (
            <span className="font-normal text-muted-foreground">
              {spelled}{" "}
            </span>
          )}
          {item.title}
        </>
      )}
      {trailing !== "" && (
        <span className="font-normal text-muted-foreground">
          {item ? " " : ""}
          {trailing}
        </span>
      )}
    </Link>
  );
}

/**
 * A bare `#comment-M`: the id names a comment, and which issue carries it
 * is a lookup away. Plain text until that lands, so a stale or unreadable
 * id never renders as a link to nowhere.
 */
function CommentLink({
  slug,
  pageSlug = slug,
  commentId,
  fallback,
}: {
  /** Where the id is looked up: the project the text was written in. */
  slug: string;
  /** Where it is being read, which decides how the ref is spelled. */
  pageSlug?: string;
  commentId: number;
  fallback: string;
}) {
  const located = useQuery(commentLocationQuery(slug, commentId));
  if (!located.data) return <>{fallback}</>;
  // A comment that moved answers from its new project, and the issue number
  // that comes back belongs to THAT project — pairing it with the project
  // asked would name a different card entirely.
  const home = located.data.slug ?? slug;
  return (
    <IssueLink
      slug={home}
      number={located.data.issue_number}
      commentId={located.data.comment.id}
      pageSlug={pageSlug}
      fallback={fallback}
    />
  );
}

/**
 * A stored reference, as the resolve pass writes it: `[#12](/projects/7/issues/12)`.
 * The project is named by an id, which no rename or move can invalidate, so
 * turning it back into something a reader can click means asking the
 * directory which slug that id answers to today.
 *
 * An id nobody in the viewer's directory holds is a project they cannot
 * read: the link stays exactly as written, undecorated. The text already
 * carries the id, so nothing is revealed either way.
 */
function useStoredTarget(href: string | undefined): {
  slug: string;
  number: number;
  commentId?: number;
} | null {
  const projects = useQuery(projectsQuery);
  if (href === undefined) return null;
  let target: LinkTarget | null;
  try {
    target = parseInternalHref(href, window.location.origin);
  } catch {
    return null;
  }
  if (target === null || target.kind !== "issue") return null;
  if (target.project.kind === "slug") {
    return {
      slug: target.project.slug,
      number: target.number,
      ...(target.commentId === undefined
        ? {}
        : { commentId: target.commentId }),
    };
  }
  const id = target.project.id;
  const slug = (projects.data ?? []).find((p) => p.id === id)?.slug;
  if (slug === undefined) return null;
  return {
    slug,
    number: target.number,
    ...(target.commentId === undefined ? {} : { commentId: target.commentId }),
  };
}

/** The href shapes remarkIssueRefs emits (see refHref). */
const ISSUE_REF_HREF = /^#issue-(\d{1,9})(?:\/comment-(\d{1,9}))?$/;
const XREF_HREF =
  /^#xref-([a-z0-9][a-z0-9-]*)\/(\d{1,9})(?:\/comment-(\d{1,9}))?$/;
const XREF_COMMENT_HREF = /^#xref-comment-(\d{1,9})$/;

type AnchorProps = ComponentProps<"a"> & {
  node?: { children?: Array<{ type: string; value?: string }> };
};

const numberOr = (raw: string | undefined): number | undefined =>
  raw === undefined ? undefined : Number(raw);

/**
 * react-markdown `a` renderer: upgrades a stored reference link, a
 * remarkIssueRefs token and a pasted same-origin permalink to <IssueLink>.
 *
 * Since T-266 the stored form of a reference IS a link, so an internal issue
 * address is decorated whatever text it carries. That does mean a
 * hand-written `[the login bug](/projects/…)` shows the card's title instead
 * of the words its author chose: the two shapes are identical in the
 * document, and dropping the decoration would leave every migrated reference
 * plain.
 */
export function MarkdownLink({
  slug,
  node,
  ...props
}: AnchorProps & { slug: string }) {
  const child = node?.children?.length === 1 ? node.children[0] : undefined;
  // The written token, so an unresolvable ref falls back to exactly what
  // its author typed rather than to a spelling they never used.
  const written = child?.type === "text" ? child.value : undefined;
  const home = slug;
  const stored = useStoredTarget(props.href);

  if (stored !== null) {
    return (
      <IssueLink
        slug={stored.slug}
        number={stored.number}
        commentId={stored.commentId}
        pageSlug={slug}
        fallback={written}
      />
    );
  }

  const refMatch = props.href?.match(ISSUE_REF_HREF);
  if (refMatch?.[1] !== undefined) {
    return (
      <IssueLink
        slug={home}
        number={Number(refMatch[1])}
        commentId={numberOr(refMatch[2])}
        pageSlug={slug}
        fallback={written}
      />
    );
  }
  const xrefMatch = props.href?.match(XREF_HREF);
  if (xrefMatch?.[1] !== undefined && xrefMatch[2] !== undefined) {
    return (
      <IssueLink
        slug={xrefMatch[1]}
        number={Number(xrefMatch[2])}
        commentId={numberOr(xrefMatch[3])}
        pageSlug={slug}
        fallback={written}
      />
    );
  }
  const commentMatch = props.href?.match(XREF_COMMENT_HREF);
  if (commentMatch?.[1] !== undefined) {
    return (
      <CommentLink
        slug={home}
        pageSlug={slug}
        commentId={Number(commentMatch[1])}
        fallback={written ?? props.href ?? ""}
      />
    );
  }
  return <a {...props} />;
}
