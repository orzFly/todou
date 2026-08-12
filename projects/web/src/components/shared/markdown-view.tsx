import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AttachmentInlineImage,
  AttachmentRichLink,
} from "@/components/issue/attachment-list.tsx";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { parseAttachmentHref } from "@/lib/attachment-refs.ts";
import { remarkIssueRefs } from "@/lib/remark-issue-refs.ts";

/** The href shape remarkIssueRefs emits for #N tokens. */
const ISSUE_REF_HREF = /^#issue-(\d{1,9})$/;

export function MarkdownView({
  children,
  slug,
  issueNumber,
}: {
  children: string;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  /**
   * Enables rich attachment references (download-URL links and embedded
   * images upgrade to preview-aware components); omit outside an issue.
   */
  issueNumber?: number;
}) {
  return (
    // Typography lives in styles.css (.markdown-body, GitHub-style).
    <div className="markdown-body">
      <Markdown
        remarkPlugins={
          slug === undefined ? [remarkGfm] : [remarkGfm, remarkIssueRefs]
        }
        components={
          slug === undefined
            ? undefined
            : {
                a: ({
                  node: _node,
                  ...props
                }: ComponentProps<"a"> & { node?: unknown }) => {
                  const match = props.href?.match(ISSUE_REF_HREF);
                  if (match?.[1] !== undefined) {
                    return <IssueLink slug={slug} number={Number(match[1])} />;
                  }
                  if (issueNumber !== undefined) {
                    const ref = parseAttachmentHref(props.href);
                    if (ref !== null && ref.slug === slug) {
                      return (
                        <AttachmentRichLink
                          slug={slug}
                          issueNumber={issueNumber}
                          attachmentId={ref.id}
                          href={props.href ?? ""}
                          fallbackName={ref.name ?? "attachment"}
                        >
                          {props.children}
                        </AttachmentRichLink>
                      );
                    }
                  }
                  return <a {...props} />;
                },
                img: ({
                  node: _node,
                  ...props
                }: ComponentProps<"img"> & { node?: unknown }) => {
                  if (issueNumber !== undefined) {
                    const ref = parseAttachmentHref(props.src);
                    if (ref !== null && ref.slug === slug) {
                      return (
                        <AttachmentInlineImage
                          slug={slug}
                          issueNumber={issueNumber}
                          attachmentId={ref.id}
                          src={props.src ?? ""}
                          alt={props.alt ?? ref.name ?? ""}
                        />
                      );
                    }
                  }
                  // biome-ignore lint/a11y/useAltText: alt is forwarded via props when the markdown provides one
                  return <img {...props} />;
                },
              }
        }
      >
        {children}
      </Markdown>
    </div>
  );
}
