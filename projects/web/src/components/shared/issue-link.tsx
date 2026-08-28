import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatRef } from "@todou/shared";
import { CircleDotIcon, CircleSlashIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
} from "@/api/issue-refs.ts";
import { useRefBeforeTitle } from "@/api/prefs.ts";
import { referenceConfigQuery } from "@/api/references.ts";
import { commentAnchor, parseIssuePermalink } from "@/lib/timeline-anchors.ts";

/**
 * GitHub-style rich issue reference: status icon, title and muted ref once
 * the batched lookup lands (in the viewer's preferred order, T-153), a
 * plain ref link while it loads, and plain text when the number matches no
 * issue the viewer may see. With
 * `commentId` the link deep-links to that comment's anchor and reads "… ·
 * comment by @x". Spelling is a UI string, so it always uses the project's
 * CURRENT format (T-80) — only user-authored text is anchored to its
 * created_at.
 *
 * `crossProject` switches the spelling to the self-contained form: the
 * reader is looking at another project's issue and a bare "T-12" would
 * read as one of this project's own.
 */
export function IssueLink({
  slug,
  number,
  commentId,
  crossProject = false,
  fallback,
}: {
  slug: string;
  number: number;
  commentId?: number;
  crossProject?: boolean;
  /** Literal text to show when the ref resolves to nothing; defaults to the spelling. */
  fallback?: string;
}) {
  const ref = useQuery(issueRefQuery(slug, number));
  const config = useQuery(referenceConfigQuery(slug));
  const comment = useQuery({
    ...commentRefQuery(slug, number, commentId ?? 0),
    enabled: commentId !== undefined,
  });
  const refBeforeTitle = useRefBeforeTitle();
  const prefix = config.data?.format.prefix ?? null;
  const spelled = crossProject
    ? `${slug}${prefix === null ? `#${number}` : `/${prefix}-${number}`}`
    : formatRef(prefix, number);

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
        ? `· comment by @${comment.data.author.login}`
        : "· comment";
  // Leading the title, the ref has already been spelled once; repeating it
  // after would read as two refs. What trails is then the comment note alone,
  // and with no comment there is nothing left to render.
  const trailing = [refBeforeTitle && item ? null : spelled, commentNote]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      hash={commentId === undefined ? undefined : commentAnchor(commentId)}
      // The timeline owns anchor positioning (highlight + lazy page
      // loading); the router's own scroll would race it.
      hashScrollIntoView={false}
      data-issue-link={number}
      data-issue-project={crossProject ? slug : undefined}
      data-comment-link={commentId}
      className="font-medium hover:underline"
      title={
        item
          ? refBeforeTitle
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
          {refBeforeTitle && (
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
  commentId,
  fallback,
}: {
  slug: string;
  commentId: number;
  fallback: string;
}) {
  const located = useQuery(commentLocationQuery(slug, commentId));
  if (!located.data) return <>{fallback}</>;
  return (
    <IssueLink
      slug={slug}
      number={located.data.issue_number}
      commentId={commentId}
      fallback={fallback}
    />
  );
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
 * react-markdown `a` renderer: upgrades remarkIssueRefs tokens and pasted
 * same-origin issue/comment permalinks to <IssueLink>. Rich rendering
 * applies only to bare autolinks (text === url) — a custom-text
 * [link](url) keeps its author-chosen text, like GitHub.
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

  const refMatch = props.href?.match(ISSUE_REF_HREF);
  if (refMatch?.[1] !== undefined) {
    return (
      <IssueLink
        slug={slug}
        number={Number(refMatch[1])}
        commentId={numberOr(refMatch[2])}
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
        crossProject
        fallback={written}
      />
    );
  }
  const commentMatch = props.href?.match(XREF_COMMENT_HREF);
  if (commentMatch?.[1] !== undefined) {
    return (
      <CommentLink
        slug={slug}
        commentId={Number(commentMatch[1])}
        fallback={written ?? props.href ?? ""}
      />
    );
  }
  if (
    props.href !== undefined &&
    child?.type === "text" &&
    child.value === props.href
  ) {
    const permalink = parseIssuePermalink(props.href, window.location.origin);
    if (permalink) {
      return (
        <IssueLink
          slug={permalink.slug}
          number={permalink.number}
          commentId={permalink.commentId}
          crossProject={permalink.slug !== slug}
        />
      );
    }
  }
  return <a {...props} />;
}
