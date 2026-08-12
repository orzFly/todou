import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleDotIcon, CircleSlashIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { commentRefQuery, issueRefQuery } from "@/api/issue-refs.ts";
import { commentAnchor, parseIssuePermalink } from "@/lib/timeline-anchors.ts";

/**
 * GitHub-style rich issue reference: status icon + title + muted #N once
 * the batched lookup lands, a plain #N link while it loads, and plain text
 * when the number matches no issue in the project. With `commentId` the
 * link deep-links to that comment's anchor and reads "… · comment by @x".
 */
export function IssueLink({
  slug,
  number,
  commentId,
}: {
  slug: string;
  number: number;
  commentId?: number;
}) {
  const ref = useQuery(issueRefQuery(slug, number));
  const comment = useQuery({
    ...commentRefQuery(slug, number, commentId ?? 0),
    enabled: commentId !== undefined,
  });

  if (ref.data === null) return <>#{number}</>;

  const item = ref.data;
  const suffix =
    commentId === undefined
      ? `#${number}`
      : comment.data
        ? `#${number} · comment by @${comment.data.author.login}`
        : `#${number} · comment`;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      hash={commentId === undefined ? undefined : commentAnchor(commentId)}
      // The timeline owns anchor positioning (highlight + lazy page
      // loading); the router's own scroll would race it.
      hashScrollIntoView={false}
      data-issue-link={number}
      data-comment-link={commentId}
      className="font-medium hover:underline"
      title={
        item ? `#${number} ${item.title} (${item.status.name})` : undefined
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
          {item.title}{" "}
        </>
      )}
      <span className="font-normal text-muted-foreground">{suffix}</span>
    </Link>
  );
}

/** The href shape remarkIssueRefs emits for #N tokens. */
const ISSUE_REF_HREF = /^#issue-(\d{1,9})$/;

type AnchorProps = ComponentProps<"a"> & {
  node?: { children?: Array<{ type: string; value?: string }> };
};

/**
 * react-markdown `a` renderer: upgrades remarkIssueRefs #N tokens and
 * pasted same-origin issue/comment permalinks to <IssueLink>. Rich
 * rendering applies only to bare autolinks (text === url) — a
 * custom-text [link](url) keeps its author-chosen text, like GitHub.
 */
export function MarkdownLink({
  slug,
  node,
  ...props
}: AnchorProps & { slug: string }) {
  const refMatch = props.href?.match(ISSUE_REF_HREF);
  if (refMatch?.[1] !== undefined) {
    return <IssueLink slug={slug} number={Number(refMatch[1])} />;
  }
  const child = node?.children?.length === 1 ? node.children[0] : undefined;
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
        />
      );
    }
  }
  return <a {...props} />;
}
