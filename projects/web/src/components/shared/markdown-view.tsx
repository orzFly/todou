import type { ComponentProps, ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AttachmentDocumentEmbed } from "@/components/issue/attachment-embed.tsx";
import {
  AttachmentInlineImage,
  AttachmentRichLink,
} from "@/components/issue/attachment-list.tsx";
import { MarkdownLink } from "@/components/shared/issue-link.tsx";
import { CodeBlock, fenceFilename } from "@/components/shared/pierre.tsx";
import {
  isPreviewableImage,
  isTextDocument,
} from "@/lib/attachment-preview.ts";
import { parseAttachmentHref } from "@/lib/attachment-refs.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { remarkIssueRefs } from "@/lib/remark-issue-refs.ts";

/** The slice of hast react-markdown hands to component overrides. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; src?: unknown };
  children?: HastNode[];
};

/** Names whose image-syntax reference embeds a document card, not an <img>. */
function isTextEmbedName(name: string): boolean {
  return (
    !isPreviewableImage({ filename: name }) &&
    isTextDocument({ filename: name })
  );
}

/** True when this img node is one our override turns into a document card. */
function isEmbedImgNode(child: HastNode, slug: string): boolean {
  if (child.type !== "element" || child.tagName !== "img") return false;
  const src = child.properties?.src;
  const ref = typeof src === "string" ? parseAttachmentHref(src) : null;
  if (ref === null || ref.slug !== slug) return false;
  return isTextEmbedName(ref.name ?? "");
}

/**
 * Pull the code text and fence tag out of a <pre> element's hast node.
 * Returns null for shapes that aren't a plain fenced block, which then
 * keep the default <pre> rendering.
 */
function parseFence(node: unknown): { text: string; tag?: string } | null {
  const pre = node as HastNode | undefined;
  const code = pre?.children?.find(
    (child) => child.type === "element" && child.tagName === "code",
  );
  if (code === undefined) return null;
  const className = Array.isArray(code.properties?.className)
    ? code.properties.className
    : [];
  const tag = className
    .find((name): name is string =>
      typeof name === "string" ? name.startsWith("language-") : false,
    )
    ?.slice("language-".length);
  const text = (code.children ?? [])
    .filter((child) => child.type === "text")
    .map((child) => child.value ?? "")
    .join("");
  // Fenced blocks always carry a trailing newline; CodeView would show it
  // as an empty last line.
  return { text: text.replace(/\n$/, ""), tag };
}

function MarkdownPre({
  node,
  children,
  source,
  ...props
}: ComponentProps<"pre"> & { node?: unknown; source: string }) {
  const fence = parseFence(node);
  if (fence === null) return <pre {...props}>{children}</pre>;
  const block = (
    <CodeBlock filename={fenceFilename(fence.tag)} contents={fence.text} />
  );
  // The pre → CodeBlock swap must not drop the source-line stamp the spec
  // review view anchors selections to (#52). A wrapper re-carries it, plus
  // where the code content starts: the stamped range opens on the ```
  // marker for fenced blocks but on the first code line for indented ones.
  const stamp = (props as Record<string, unknown>)[SOURCE_LINE_ATTR];
  const loc = typeof stamp === "string" ? parseSourceLoc(stamp) : null;
  if (loc === null) return block;
  const opening = source.split("\n")[loc.start - 1]?.trimStart() ?? "";
  const fenced = opening.startsWith("```") || opening.startsWith("~~~");
  const wrapperProps = {
    [SOURCE_LINE_ATTR]: stamp,
    [CODE_CONTENT_START_ATTR]: loc.start + (fenced ? 1 : 0),
  };
  return <div {...wrapperProps}>{block}</div>;
}

export function MarkdownView({
  children,
  slug,
  issueNumber,
  embedded = false,
  rehypePlugins,
}: {
  children: string;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  /**
   * Enables rich attachment references (download-URL links, embedded
   * images and document cards upgrade to preview-aware components); omit
   * outside an issue.
   */
  issueNumber?: number;
  /**
   * True when this markdown is itself inside a document card. Text
   * attachments then render as links instead of nested cards — the guard
   * that keeps a document embedding itself from recursing forever.
   */
  embedded?: boolean;
  /**
   * Extra rehype plugins (e.g. source-line stamping for spec annotation,
   * #23). Pass a stable reference — this goes straight to react-markdown.
   */
  rehypePlugins?: ComponentProps<typeof Markdown>["rehypePlugins"];
}) {
  return (
    // Typography lives in styles.css (.markdown-body, GitHub-style).
    <div className="markdown-body">
      <Markdown
        remarkPlugins={
          slug === undefined ? [remarkGfm] : [remarkGfm, remarkIssueRefs]
        }
        rehypePlugins={rehypePlugins}
        components={{
          pre: (props) => <MarkdownPre {...props} source={children} />,
          ...(slug === undefined
            ? undefined
            : {
                // A document card is block content, which HTML forbids
                // inside <p>; paragraphs that carry an embed swap to a
                // <div> (same typography via .markdown-paragraph).
                p: ({
                  node,
                  children,
                  ...props
                }: ComponentProps<"p"> & { node?: unknown }): ReactNode => {
                  const carriesEmbed =
                    issueNumber !== undefined &&
                    !embedded &&
                    ((node as HastNode | undefined)?.children ?? []).some(
                      (child) => isEmbedImgNode(child, slug),
                    );
                  if (carriesEmbed) {
                    return (
                      <div className="markdown-paragraph" {...props}>
                        {children}
                      </div>
                    );
                  }
                  return <p {...props}>{children}</p>;
                },
                // Attachment refs need the issue context and win first;
                // everything else (issue refs, permalinks, plain links)
                // is MarkdownLink's business.
                a: (props): ReactNode => {
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
                  return <MarkdownLink slug={slug} {...props} />;
                },
                img: ({
                  node: _node,
                  ...props
                }: ComponentProps<"img"> & { node?: unknown }): ReactNode => {
                  if (issueNumber !== undefined) {
                    const ref = parseAttachmentHref(props.src);
                    if (ref !== null && ref.slug === slug) {
                      const name = ref.name ?? "";
                      // Image syntax on a text attachment embeds it as a
                      // document card (the text twin of an inline image).
                      // Images keep winning ties like .svg, which is both.
                      if (isTextEmbedName(name)) {
                        if (embedded) {
                          return (
                            <AttachmentRichLink
                              slug={slug}
                              issueNumber={issueNumber}
                              attachmentId={ref.id}
                              href={props.src ?? ""}
                              fallbackName={name}
                            />
                          );
                        }
                        return (
                          <AttachmentDocumentEmbed
                            slug={slug}
                            issueNumber={issueNumber}
                            attachmentId={ref.id}
                            href={props.src ?? ""}
                            fallbackName={name}
                          />
                        );
                      }
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
              }),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
