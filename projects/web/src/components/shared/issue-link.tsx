import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatRef, type LinkTarget, parseInternalHref } from "@todou/shared";
import { CircleDotIcon, CircleSlashIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  commentLocationQuery,
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
} from "@/api/issue-refs.ts";
import {
  useBoxedRefLinks,
  useRefPlacement,
  useShowRepeatedRefTitle,
  useTruncateRefTitle,
} from "@/api/prefs.ts";
import { projectsQuery } from "@/api/queries.ts";
import { referenceConfigQuery } from "@/api/references.ts";
import { CommentHoverCard } from "@/components/shared/comment-hover-card.tsx";
import { CommentReference } from "@/components/shared/comment-reference.tsx";
import { useCanHoverPreview } from "@/components/shared/hover-preview.ts";
import { IssueHoverCard } from "@/components/shared/issue-hover-card.tsx";
import { MentionLink } from "@/components/shared/mention-link.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import {
  RICH_CHIP_FIXED,
  RICH_CHIP_ICON,
  RICH_CHIP_LABEL,
  RICH_CHIP_SKIN,
  RICH_CHIP_STRUCTURE,
  RICH_CHIP_TITLE_CAP,
} from "@/components/shared/rich-chip.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { qualifiedRefSpelling } from "@/lib/issue-refs.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Ordinary references can say "current"; a current-page comment instead
 * names its short #comment-N suffix.
 */
const CURRENT_NOTE = "current";

/**
 * GitHub-style rich issue reference: status icon, title and muted ref once
 * the complete target is freshly confirmed (in the viewer's preferred order,
 * T-153). Until then a known address remains an ordinary link; a bare
 * unresolved comment remains text. With `commentId` the link deep-links to
 * that comment's anchor and names the final comment ID with its author.
 * Spelling uses the project's CURRENT format (T-80); user-authored text
 * alone is anchored to its created_at.
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
  pageNumber,
  asWritten = false,
  fallback,
  fallbackHref,
  fallbackChildren,
  initialComment,
  initialCommentUpdatedAt,
  fallbackAnchorProps,
  inBody = false,
  repeat = false,
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
  /**
   * The card the reader is on, with `pageSlug` the address of the page
   * itself. An ordinary issue reference can read "current" instead of a ref
   * and a title, and opens no preview. Comments on the page show their short
   * suffix without a title. Omitted where a surface cannot name the page.
   */
  pageNumber?: number;
  asWritten?: boolean;
  /** Literal text to show when the ref resolves to nothing; defaults to the spelling. */
  fallback?: string;
  /** Original explicit URL and children; retained verbatim until confirmation. */
  fallbackHref?: string;
  fallbackChildren?: ReactNode;
  /** A located comment can prime this query at its original cache timestamp. */
  initialComment?: ResolvedCommentRef;
  fallbackAnchorProps?: ComponentProps<"a">;
  initialCommentUpdatedAt?: number;
  /**
   * Render as a chip: the markdown renderer's form, where the reader's
   * preferences may add a border and a title cap. Off everywhere else, so a
   * timeline event row keeps the inline anchor T-359 measured — the default
   * is what makes that the quiet outcome of forgetting rather than a
   * regression nobody asked for.
   */
  inBody?: boolean;
  /** This document has already named the card; the title may be dropped. */
  repeat?: boolean;
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
  const commentQuery = useQuery({
    ...commentRefQuery(slug, number, commentId ?? 0),
    enabled: commentId !== undefined && initialComment === undefined,
    initialData: initialComment,
    initialDataUpdatedAt: initialCommentUpdatedAt,
  });
  // A fresh location response is itself the complete authorized comment.
  // Keep its original timestamp and use it on every refresh, not only when
  // TanStack happens to create an empty comment-ref cache entry.
  const comment =
    initialComment === undefined
      ? commentQuery
      : {
          data: initialComment,
          isFetching: false,
          isError: false,
          isStale:
            initialCommentUpdatedAt === undefined ||
            Date.now() - initialCommentUpdatedAt >= 60_000,
        };
  const refLeads = useRefPlacement("reference") === "before";
  const boxed = useBoxedRefLinks() && inBody;
  const capTitle = useTruncateRefTitle() && inBody;
  const showRepeatedTitle = useShowRepeatedRefTitle();
  const dropTitle = !showRepeatedTitle && repeat;
  const canHover = useCanHoverPreview();
  const returnState = useReturnLinkState();
  const prefix = config.data?.format.prefix ?? null;
  const crossProject = shownSlug !== pageSlug;
  const spelled = crossProject
    ? qualifiedRefSpelling(shownSlug, prefix, shownNumber)
    : formatRef(prefix, shownNumber);
  // Where the card is NOW, not the address the reference was written with: a
  // reference to an old address that redirects here is, to the reader, this
  // very card.
  const onPageCard =
    pageNumber !== undefined && toSlug === pageSlug && toNumber === pageNumber;
  // Two rules read `onPageCard` at different thresholds, on purpose. Writing
  // "current" is the reader's own preference — they asked for a mention that
  // repeats a card to keep its title, and this is the same trade. Opening no
  // preview is not a preference: the card is the page, so there is nothing a
  // preview could show that is not already on the screen, whichever way the
  // toggle is set.
  const asCurrent = onPageCard && !showRepeatedTitle;

  // Never paint any part of a rich card from one confirmed query and another
  // pending, stale, failed, or mismatched query. In particular the comment's
  // final parent must agree with the issue's final address after redirects.
  const confirmedIssue =
    ref.data !== undefined &&
    ref.data !== null &&
    ref.data.deleted_at == null &&
    !ref.isFetching &&
    !ref.isStale &&
    !ref.isError &&
    !(ref.data.at === undefined && /^\d+$/.test(toSlug));
  const confirmedComment =
    commentId === undefined ||
    (comment.data !== undefined &&
      comment.data !== null &&
      !comment.isFetching &&
      !comment.isStale &&
      !comment.isError &&
      comment.data.at.slug === toSlug &&
      comment.data.at.number === toNumber &&
      comment.data.at.commentId === comment.data.id);
  if (!confirmedIssue || !confirmedComment || !ref.data) {
    if (fallbackHref !== undefined) {
      return (
        <a {...fallbackAnchorProps} href={fallbackHref}>
          {fallbackChildren ?? fallback ?? spelled}
        </a>
      );
    }
    // System rows know this address even when metadata cannot be confirmed.
    // A legacy row with no project still exits before it reaches IssueLink.
    const href = `/projects/${slug}/issues/${number}${
      commentId === undefined ? "" : `#${commentAnchor(commentId)}`
    }`;
    const text =
      fallback ??
      `${slug === pageSlug ? `#${number}` : `${slug}#${number}`}${
        commentId === undefined ? "" : `#comment-${commentId}`
      }`;
    return <a href={href}>{text}</a>;
  }

  const item = ref.data;
  const confirmedNote = commentId === undefined ? null : comment.data;
  const isComment = confirmedNote != null;
  const hideTitle = dropTitle || (isComment ? onPageCard : asCurrent);
  const trailing = isComment
    ? ""
    : asCurrent
      ? CURRENT_NOTE
      : refLeads
        ? ""
        : spelled;
  const iconClass = inBody
    ? isComment
      ? "comment-reference-icon inline size-3.5"
      : RICH_CHIP_ICON
    : "mr-0.5 inline size-3.5 align-middle";
  // The preview is already paid for: confirming the comment fetched its
  // body too, so hovering asks the server nothing.
  const hovered =
    commentId !== undefined && canHover ? (comment.data ?? null) : null;
  // The confirmed issue already supplied the card contents. A hover preview
  // for a comment reuses its confirmed query result; an issue preview uses
  // the same resolved item and final address.
  const previewable = commentId === undefined && canHover && !onPageCard;
  const link = (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug: toSlug, number: String(toNumber) }}
      hash={
        commentId === undefined
          ? undefined
          : commentAnchor(comment.data?.at.commentId ?? commentId)
      }
      // The timeline owns anchor positioning (highlight + lazy page
      // loading); the router's own scroll would race it.
      hashScrollIntoView={false}
      // A prop rather than anything conditional on the lookup: the note above
      // about rebuilt anchors applies to the element, and the origin is the
      // same whatever the batch says (T-407).
      state={returnState}
      data-issue-link={shownNumber}
      data-issue-project={crossProject ? shownSlug : undefined}
      data-comment-link={comment.data?.at.commentId}
      className={
        inBody
          ? cn(
              "font-medium",
              isComment ? "comment-link-body" : RICH_CHIP_STRUCTURE,
              boxed ? RICH_CHIP_SKIN : "hover:underline",
            )
          : "font-medium hover:underline"
      }
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
              className={iconClass}
              style={{ color: item.status.color }}
            />
          ) : (
            <CircleDotIcon
              aria-hidden
              className={iconClass}
              style={{ color: item.status.color }}
            />
          )}
          {isComment && (
            <CommentReference
              spelled={spelled}
              slug={shownSlug}
              prefix={prefix}
              number={shownNumber}
              commentId={confirmedNote.at.commentId}
              title={hideTitle ? null : item.title}
              refLeads={refLeads}
              inBody={inBody}
              capTitle={capTitle}
              author={displayNameOf(confirmedNote.author)}
              current={onPageCard}
            />
          )}
          {refLeads && !isComment && !asCurrent && (
            <span
              className={cn(
                "font-normal text-muted-foreground",
                inBody && RICH_CHIP_FIXED,
              )}
            >
              {spelled}
              {inBody ? null : " "}
            </span>
          )}
          {isComment || hideTitle ? null : inBody ? (
            <span
              className={cn(RICH_CHIP_LABEL, capTitle && RICH_CHIP_TITLE_CAP)}
            >
              {item.title}
            </span>
          ) : (
            item.title
          )}
        </>
      )}
      {trailing !== "" && (
        <span
          className={cn(
            "font-normal text-muted-foreground",
            inBody && RICH_CHIP_FIXED,
          )}
        >
          {inBody ? null : item ? " " : ""}
          {trailing}
        </span>
      )}
    </Link>
  );
  if (hovered !== null) {
    return (
      <CommentHoverCard slug={toSlug} issueNumber={toNumber} comment={hovered}>
        {link}
      </CommentHoverCard>
    );
  }
  if (previewable) {
    return (
      <IssueHoverCard
        slug={toSlug}
        number={toNumber}
        spelled={spelled}
        item={item}
      >
        {link}
      </IssueHoverCard>
    );
  }
  return link;
}

/**
 * A bare `#comment-M`: the id names a comment, and which issue carries it
 * is a lookup away. Plain text until that lands, so a stale or unreadable
 * id never renders as a link to nowhere.
 */
function CommentLink({
  slug,
  pageSlug = slug,
  pageNumber,
  commentId,
  fallback,
  repeat = false,
}: {
  /** Where the id is looked up: the project the text was written in. */
  slug: string;
  /** Where it is being read, which decides how the ref is spelled. */
  pageSlug?: string;
  pageNumber?: number;
  commentId: number;
  fallback: string;
  repeat?: boolean;
}) {
  const client = useQueryClient();
  const locationOptions = commentLocationQuery(slug, commentId);
  const located = useQuery(locationOptions);
  if (
    !located.data ||
    located.isFetching ||
    located.isStale ||
    located.isError
  ) {
    return <>{fallback}</>;
  }
  // The location lookup has already fetched the complete comment. Reuse it
  // with the same dataUpdatedAt, not a freshly stamped cache entry that could
  // extend the life of stale authorization metadata.
  const home = located.data.slug ?? slug;
  const comment = located.data.comment;
  return (
    <IssueLink
      slug={home}
      number={located.data.issue_number}
      commentId={comment.id}
      pageSlug={pageSlug}
      pageNumber={pageNumber}
      fallback={fallback}
      inBody
      repeat={repeat}
      initialComment={{
        ...comment,
        at: {
          slug: home,
          number: located.data.issue_number,
          commentId: comment.id,
        },
      }}
      initialCommentUpdatedAt={
        client.getQueryState(locationOptions.queryKey)?.dataUpdatedAt
      }
    />
  );
}

/**
 * A stored reference, as the resolve pass writes it: `[#12](/projects/7/issues/12)`.
 * Prefer the visible directory's slug for a numeric project id. If the
 * directory has no entry, probe the numeric single-target route anyway: an
 * old unreadable address may redirect to a visible destination. Until that
 * move is confirmed the authored href and children remain an ordinary link.
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
  const slug =
    (projects.data ?? []).find((p) => p.id === id)?.slug ?? String(id);
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
const MENTION_HREF = /^#mention-([a-z0-9][a-z0-9-]*)$/;
const USER_HREF = /^\/users\/(\d{1,15})$/;

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
  pageNumber,
  node,
  repeat = false,
  ...props
}: AnchorProps & {
  slug: string;
  /** The card this document is being read on; see IssueLink's own prop. */
  pageNumber?: number;
  repeat?: boolean;
}) {
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
        pageNumber={pageNumber}
        fallback={written}
        fallbackHref={props.href}
        fallbackChildren={props.children}
        inBody
        repeat={repeat}
        fallbackAnchorProps={props}
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
        pageNumber={pageNumber}
        fallback={written}
        fallbackHref={`/projects/${home}/issues/${refMatch[1]}${
          refMatch[2] === undefined ? "" : `#comment-${refMatch[2]}`
        }`}
        fallbackChildren={props.children}
        inBody
        fallbackAnchorProps={props}
        repeat={repeat}
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
        pageNumber={pageNumber}
        fallback={written}
        fallbackHref={`/projects/${xrefMatch[1]}/issues/${xrefMatch[2]}${
          xrefMatch[3] === undefined ? "" : `#comment-${xrefMatch[3]}`
        }`}
        fallbackChildren={props.children}
        repeat={repeat}
        inBody
        fallbackAnchorProps={props}
      />
    );
  }
  const commentMatch = props.href?.match(XREF_COMMENT_HREF);
  if (commentMatch?.[1] !== undefined) {
    return (
      <CommentLink
        slug={home}
        pageSlug={slug}
        pageNumber={pageNumber}
        commentId={Number(commentMatch[1])}
        fallback={written ?? props.href ?? ""}
        repeat={repeat}
      />
    );
  }
  const mentionMatch = props.href?.match(MENTION_HREF);
  if (mentionMatch?.[1] !== undefined) {
    return (
      <MentionLink
        slug={home}
        login={mentionMatch[1]}
        fallback={written ?? props.href ?? ""}
      />
    );
  }
  const userMatch = props.href?.match(USER_HREF);
  if (userMatch?.[1] !== undefined) {
    return (
      <MentionLink
        slug={home}
        userId={Number(userMatch[1])}
        fallback={written ?? props.href ?? ""}
      />
    );
  }
  return <a {...props} />;
}
