import type { ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { remarkIssueRefs } from "@/lib/remark-issue-refs.ts";

/** The href shape remarkIssueRefs emits for #N tokens. */
const ISSUE_REF_HREF = /^#issue-(\d{1,9})$/;

export function MarkdownView({
  children,
  slug,
}: {
  children: string;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
}) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_code]:text-[0.85em] [&_ul]:list-disc [&_ol]:list-decimal [&_ul,&_ol]:pl-5 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
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
                  return <a {...props} />;
                },
              }
        }
      >
        {children}
      </Markdown>
    </div>
  );
}
