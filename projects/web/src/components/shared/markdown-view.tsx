import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import Markdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { projectsQuery } from "@/api/queries.ts";
import {
  refConfigFor,
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import {
  MarkdownAttachmentAnchor,
  MarkdownAttachmentImage,
} from "@/components/issue/attachment-markdown.tsx";
import { MarkdownLink } from "@/components/shared/issue-link.tsx";
import { CodeBlock, fenceFilename } from "@/components/shared/pierre.tsx";
import { isTextEmbedName } from "@/lib/attachment-preview.ts";
import { parseAttachmentHref } from "@/lib/attachment-refs.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import {
  FRONTMATTER_FLAVOURS,
  remarkFrontmatterTable,
} from "@/lib/remark-frontmatter-table.ts";
import { remarkIssueRefs } from "@/lib/remark-issue-refs.ts";

/** The slice of hast react-markdown hands to component overrides. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown; src?: unknown };
  children?: HastNode[];
};

/**
 * True when this img node is one our override turns into a document card.
 *
 * Deliberately answers from the markdown alone — no slug test, no attachment
 * data. It decides between `<p>` and `<div>`, and an element type that
 * flipped when the attachments query arrived would unmount and rebuild the
 * whole paragraph, which is exactly what the T-60 note above warns about.
 * The cost of being generous is a paragraph rendered as
 * `div.markdown-paragraph` when the address turns out to resolve to nothing;
 * the two share their typography. Being strict instead would put a block
 * document card inside a `<p>`, which browsers split the paragraph over.
 */
function isEmbedImgNode(child: HastNode): boolean {
  if (child.type !== "element" || child.tagName !== "img") return false;
  const src = child.properties?.src;
  const ref = typeof src === "string" ? parseAttachmentHref(src) : null;
  return ref !== null && isTextEmbedName(ref.name ?? "");
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
  // review view anchors selections to (T-52). A wrapper re-carries it, plus
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
    // Decoration classes ride on the <pre> too (T-158: a fence inside a
    // wholly-new range) and would otherwise vanish in the swap.
    className: props.className,
  };
  return <div {...wrapperProps}>{block}</div>;
}

export function MarkdownView({
  children,
  slug,
  issueNumber,
  embedded = false,
  preview = false,
  rehypePlugins,
}: {
  children: string;
  /** Enables #N → issue link rendering; omit where there is no project. */
  slug?: string;
  /**
   * True for text that has NOT been through the resolve pass — a draft.
   *
   * Stored text carries its references as real links, resolved when it was
   * saved; a bare token still in it is one that did not resolve, and drawing
   * it as a link would put the guess back (T-266). A draft has been through
   * nothing, so its tokens are shown under exactly the anchor the submission
   * will use: this project, this instant.
   *
   * No surface passes it today — the composer is a plain editor with no
   * preview pane. It is the seam one would render through, and what keeps
   * the tokenizer's behaviour under test while the read path stops using it.
   */
  preview?: boolean;
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
   * T-23). Pass a stable reference — this goes straight to react-markdown.
   */
  rehypePlugins?: ComponentProps<typeof Markdown>["rehypePlugins"];
}) {
  // The override map must be referentially stable across re-renders: every
  // entry is an anonymous component, and a fresh map makes React treat each
  // one as a NEW component type, unmounting and rebuilding those DOM
  // subtrees on every parent render. Rebuilt text nodes silently collapse
  // any live text selection — which broke spec annotation (T-60): the
  // floating comment button's own appearance re-rendered the document and
  // destroyed the selection it was offering to annotate.
  const components: ComponentProps<typeof Markdown>["components"] = useMemo(
    () => ({
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
                ((node as HastNode | undefined)?.children ?? []).some((child) =>
                  isEmbedImgNode(child),
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
            // everything else (issue refs, permalinks, plain links) is
            // MarkdownLink's business. WHICH attachment an address names is
            // the wrapper's: answering that takes a query, and this map is
            // not a component, so no hook may run in it.
            a: (props): ReactNode => {
              const target =
                issueNumber === undefined
                  ? null
                  : parseAttachmentHref(props.href);
              if (target !== null && issueNumber !== undefined) {
                return (
                  <MarkdownAttachmentAnchor
                    slug={slug}
                    issueNumber={issueNumber}
                    address={target}
                    {...props}
                  />
                );
              }
              return <MarkdownLink slug={slug} {...props} />;
            },
            img: (
              props: ComponentProps<"img"> & { node?: unknown },
            ): ReactNode => {
              const target =
                issueNumber === undefined
                  ? null
                  : parseAttachmentHref(props.src);
              if (target !== null && issueNumber !== undefined) {
                return (
                  <MarkdownAttachmentImage
                    slug={slug}
                    issueNumber={issueNumber}
                    address={target}
                    embedded={embedded}
                    {...props}
                  />
                );
              }
              const { node: _node, ...rest } = props;
              // biome-ignore lint/a11y/useAltText: alt is forwarded via props when the markdown provides one
              return <img {...rest} />;
            },
          }),
    }),
    [children, slug, issueNumber, embedded],
  );

  const refQuery = useQuery({
    ...referenceConfigQuery(slug ?? ""),
    enabled: slug !== undefined,
  });
  // Cross-project resolution is the viewer's own: which projects they can
  // name, and which prefixes were unambiguously held when this was written.
  const directoryQuery = useQuery({
    ...referenceDirectoryQuery,
    enabled: slug !== undefined,
  });
  const readableQuery = useQuery({
    ...projectsQuery,
    enabled: slug !== undefined,
  });
  // Stable references: react-markdown gets this array verbatim, and the
  // tokenizer config must not churn identity on unrelated re-renders.
  //
  // `remarkFrontmatterTable` has to follow `remarkFrontmatter` (T-240): the
  // `yaml` / `toml` nodes it consumes are the other one's output. Its position
  // relative to `remarkIssueRefs` carries no meaning — the `OPAQUE` entry in
  // remark-issue-refs.ts is what keeps refs out of a frontmatter value, not
  // this order.
  const remarkPlugins = useMemo(() => {
    const base = [
      remarkGfm,
      [remarkFrontmatter, FRONTMATTER_FLAVOURS],
      remarkFrontmatterTable,
    ];
    if (slug === undefined)
      return base as ComponentProps<typeof Markdown>["remarkPlugins"];
    const directory = directoryQuery.data;
    const readable = readableQuery.data;
    const config = refConfigFor(
      refQuery.data,
      directory == null || readable === undefined
        ? undefined
        : { slugs: readable.map((p) => p.slug), directory },
    );
    return [
      ...base,
      [remarkIssueRefs, config, { autolinksOnly: !preview }],
    ] as ComponentProps<typeof Markdown>["remarkPlugins"];
  }, [slug, preview, refQuery.data, directoryQuery.data, readableQuery.data]);

  return (
    // Typography lives in styles.css (.markdown-body, GitHub-style).
    <div className="markdown-body">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
