import { useQuery } from "@tanstack/react-query";
import type { Element } from "hast";
import { type ComponentProps, memo, type ReactNode, useMemo } from "react";
import Markdown from "react-markdown";
import { projectsQuery } from "@/api/queries.ts";
import {
  refConfigFor,
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import {
  ImageSwapCompare,
  MarkdownAttachmentAnchor,
  MarkdownAttachmentImage,
} from "@/components/issue/attachment-markdown.tsx";
import { BodyAnchor } from "@/components/shared/body-anchor.tsx";
import { FenceFrame } from "@/components/shared/fence-frame.tsx";
import { MarkdownLink } from "@/components/shared/issue-link.tsx";
import { DEFAULT_COMPARE_LABELS } from "@/components/shared/media-compare.tsx";
import {
  MermaidBlock,
  MermaidCompare,
} from "@/components/shared/mermaid-block.tsx";
import { PatchView } from "@/components/shared/patch-view.tsx";
import {
  CodeBlock,
  CodeDiffBlock,
  fenceFilename,
} from "@/components/shared/pierre.tsx";
import { isTextEmbedName } from "@/lib/attachment-preview.ts";
import { parseAttachmentHref } from "@/lib/attachment-refs.ts";
import { isEmbedImgNode, isSwapImgNode } from "@/lib/block-embeds.ts";
import { FENCE_COLLAPSE_LINES, fenceTitle } from "@/lib/fence-meta.ts";
import {
  MARKDOWN_SYNTAX_PLUGINS,
  MESSAGE_SYNTAX_PLUGINS,
} from "@/lib/markdown-processor.ts";
import { rehypeBlockBreaks } from "@/lib/rehype-block-breaks.ts";
import { SWAP_ALT_ATTR, SWAP_SRC_ATTR } from "@/lib/rehype-decorations.ts";
import { rehypeDetails } from "@/lib/rehype-details.ts";
import {
  PAIR_ATTR,
  pairLabel,
  rehypeImagePairs,
} from "@/lib/rehype-image-pairs.ts";
import {
  CODE_CONTENT_START_ATTR,
  parseSourceLoc,
  SOURCE_LINE_ATTR,
} from "@/lib/rehype-source-lines.ts";
import { remarkIssueRefs } from "@/lib/remark-issue-refs.ts";
import {
  REF_REPEAT_ATTR,
  remarkRefOccurrences,
} from "@/lib/remark-ref-occurrences.ts";
import { useRefChipFlow } from "@/lib/use-ref-chip-flow.ts";

/**
 * A fence rendered as a diff of two versions (T-343). It keeps `.spec-changed`
 * so the ↑↓ navigation still stops on it, and this marks where the block-level
 * wash is redundant — the diff's own red and green say the same thing per line.
 */
export const FENCE_DIFF_CLASS = "spec-fence-diff";

/** The slice of hast react-markdown hands to component overrides. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
  data?: { meta?: unknown };
};

/**
 * Pull the code text, fence tag and the info string after the tag out of a
 * <pre> element's hast node. Returns null for shapes that aren't a plain
 * fenced block, which then keep the default <pre> rendering.
 */
function parseFence(
  node: unknown,
): { text: string; tag?: string; meta?: string } | null {
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
  const meta = code.data?.meta;
  // Fenced blocks always carry a trailing newline; CodeView would show it
  // as an empty last line.
  return {
    text: text.replace(/\n$/, ""),
    tag,
    meta: typeof meta === "string" ? meta : undefined,
  };
}

function MarkdownPre({
  node,
  children,
  fenceBaselines,
  collapseLongFences,
  ...props
}: ComponentProps<"pre"> & {
  node?: unknown;
  fenceBaselines?: Map<number, string>;
  collapseLongFences: boolean;
}) {
  const fence = parseFence(node);
  if (fence === null) return <pre {...props}>{children}</pre>;
  // The pre → CodeBlock swap must not drop the source-line stamp the spec
  // review view anchors selections to (T-52). A wrapper re-carries it, plus
  // where the code content starts: the stamped range opens on the ```
  // marker for fenced blocks but on the first code line for indented ones.
  const stamp = (props as Record<string, unknown>)[SOURCE_LINE_ATTR];
  const loc = typeof stamp === "string" ? parseSourceLoc(stamp) : null;
  const filename = fenceFilename(fence.tag);
  const baseline = loc === null ? undefined : fenceBaselines?.get(loc.start);
  // A changed diagram is drawn as its two versions side by side (T-724). A
  // changed patch stays a source diff — a diff of a diff is only readable as
  // its text.
  // A plain fence tokenizes off the main thread (T-602): the first one in a
  // language compiles that grammar, 520 ms for TypeScript at 4× CPU
  // throttling, in the middle of the page's first load.
  const tag = fence.tag?.toLowerCase();
  const title = fenceTitle(fence.meta);
  const collapsible =
    collapseLongFences && fence.text.split("\n").length > FENCE_COLLAPSE_LINES;
  // A diagram and a patch draw their own frames: each has controls of its
  // own to put in it.
  const block =
    baseline !== undefined && tag === "mermaid" ? (
      <MermaidCompare
        filename={filename}
        before={baseline}
        after={fence.text}
        title={title}
      />
    ) : baseline !== undefined ? (
      <FenceFrame
        text={fence.text}
        lang={fence.tag}
        title={title}
        collapsible={collapsible}
      >
        <CodeDiffBlock
          filename={filename}
          before={baseline}
          after={fence.text}
          bareFallback
        />
      </FenceFrame>
    ) : tag === "mermaid" ? (
      <MermaidBlock
        filename={filename}
        source={fence.text}
        title={title}
        collapsible={collapsible}
      />
    ) : tag === "diff" || tag === "patch" ? (
      <PatchView
        filename={filename}
        text={fence.text}
        title={title}
        lang={fence.tag}
      />
    ) : (
      <FenceFrame
        text={fence.text}
        lang={fence.tag}
        title={title}
        collapsible={collapsible}
      >
        <CodeBlock
          filename={filename}
          contents={fence.text}
          offThread
          bareFallback
        />
      </FenceFrame>
    );
  const wrapperProps =
    loc === null
      ? {
          // Restored old fences keep deletion identity without a current loc.
          className: ["markdown-fence", props.className]
            .filter(Boolean)
            .join(" "),
        }
      : {
          [SOURCE_LINE_ATTR]: stamp,
          [CODE_CONTENT_START_ATTR]: (() => {
            // Whether there is a marker line to skip is answered by the line
            // count, not by reading the opening line: a fence inside a
            // blockquote opens on "> ```ts", whose `>` survives trimStart().
            const span = loc.end - loc.start + 1;
            const contentLines =
              fence.text === "" ? 0 : fence.text.split("\n").length;
            return loc.start + (span - contentLines >= 1 ? 1 : 0);
          })(),
          // Decoration classes ride on the <pre> too (T-158: a fence inside
          // a wholly-new range) and would otherwise vanish in the swap.
          className: [
            "markdown-fence",
            props.className,
            baseline === undefined ? undefined : FENCE_DIFF_CLASS,
          ]
            .filter(Boolean)
            .join(" "),
        };
  return <div {...wrapperProps}>{block}</div>;
}

type MarkdownViewProps = {
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
   * True when the text is a file — a spec document or an attached `.md` — in
   * which a single newline stays a space, as on github.com. Everything else
   * is a message, where it is a line break (T-702).
   */
  document?: boolean;
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
  /**
   * The baseline body of each code block that was edited in place, by the
   * source line it opens on (T-343). A fence found here renders as a diff of
   * the two versions instead of as its own contents.
   */
  fenceBaselines?: Map<number, string>;
  /**
   * Cap a long code block to scroll inside its frame (default). The spec
   * document turns it off: a review reads every line, and an annotation on
   * a line scrolled out of the frame could be neither seen nor selected.
   */
  collapseLongFences?: boolean;
};

export type MarkdownRemarkPlugins = NonNullable<
  ComponentProps<typeof Markdown>["remarkPlugins"]
>;

/**
 * Project-aware syntax shared by the current document and its baseline.
 * React-markdown receives this array directly: unrelated renders must retain
 * its reference so they neither reparse the document nor disturb selections.
 */
export function useMarkdownRemarkPlugins(
  slug?: string,
  { preview = false, document = false } = {},
): MarkdownRemarkPlugins {
  const refQuery = useQuery({
    ...referenceConfigQuery(slug ?? ""),
    enabled: slug !== undefined,
  });
  const directoryQuery = useQuery({
    ...referenceDirectoryQuery,
    enabled: slug !== undefined,
  });
  const readableQuery = useQuery({
    ...projectsQuery,
    enabled: slug !== undefined,
  });
  return useMemo(() => {
    const syntax = document ? MARKDOWN_SYNTAX_PLUGINS : MESSAGE_SYNTAX_PLUGINS;
    if (slug === undefined) return syntax;
    const directory = directoryQuery.data;
    const readable = readableQuery.data;
    const config = {
      ...refConfigFor(
        refQuery.data,
        directory == null || readable === undefined
          ? undefined
          : { slugs: readable.map((project) => project.slug), directory },
      ),
      // Draft previews resolve @mentions; stored reading surfaces do not.
      mentions: preview,
    };
    return [
      ...syntax,
      // Its position relative to frontmatter is not a constraint: issue refs
      // treat frontmatter as opaque regardless of this order.
      [remarkIssueRefs, config, { autolinksOnly: !preview }],
      // Count after tokenization, including the links it just created.
      remarkRefOccurrences,
    ] as MarkdownRemarkPlugins;
  }, [
    slug,
    preview,
    document,
    refQuery.data,
    directoryQuery.data,
    readableQuery.data,
  ]);
}

export function MarkdownView(props: MarkdownViewProps) {
  const remarkPlugins = useMarkdownRemarkPlugins(props.slug, {
    preview: props.preview,
    document: props.document,
  });
  return <MarkdownViewWithPlugins {...props} remarkPlugins={remarkPlugins} />;
}

// Memoized because react-markdown keeps no parse cache: every render of
// <Markdown> runs remark and rehype over the whole document again. Hosts
// re-render for reasons that never touch the text — each keystroke in the
// spec composer, each chip measurement while scrolling — and on a long spec
// that reparse cost a frame or more per key (T-599). Every prop here is
// already required to be referentially stable (see the plugin hooks above),
// which is what makes the shallow compare sound.
export const MarkdownViewWithPlugins = memo(function MarkdownViewWithPlugins({
  children,
  slug,
  issueNumber,
  document = false,
  embedded = false,
  rehypePlugins,
  fenceBaselines,
  collapseLongFences = true,
  remarkPlugins,
}: MarkdownViewProps & { remarkPlugins: MarkdownRemarkPlugins }) {
  const rootRef = useRefChipFlow();
  // The override map must be referentially stable across re-renders: every
  // entry is an anonymous component, and a fresh map makes React treat each
  // one as a NEW component type, unmounting and rebuilding those DOM
  // subtrees on every parent render. Rebuilt text nodes silently collapse
  // any live text selection — which broke spec annotation (T-60): the
  // floating comment button's own appearance re-rendered the document and
  // destroyed the selection it was offering to annotate.
  const components: ComponentProps<typeof Markdown>["components"] = useMemo(
    () => ({
      pre: (props) => (
        <MarkdownPre
          {...props}
          fenceBaselines={fenceBaselines}
          collapseLongFences={collapseLongFences}
        />
      ),
      ...(slug === undefined
        ? {
            a: ({
              node: _node,
              ...props
            }: ComponentProps<"a"> & { node?: unknown }): ReactNode => (
              <BodyAnchor {...props} />
            ),
          }
        : {
            // A document card and an image comparison are block content,
            // which HTML forbids inside <p>; paragraphs that carry one swap
            // to a <div> (same typography via .markdown-paragraph).
            p: ({
              node,
              children,
              ...props
            }: ComponentProps<"p"> & { node?: unknown }): ReactNode => {
              const kids = (node as Element | undefined)?.children ?? [];
              const carriesEmbed =
                (issueNumber !== undefined &&
                  !embedded &&
                  kids.some(isEmbedImgNode)) ||
                kids.some(isSwapImgNode);
              if (carriesEmbed) {
                return (
                  // A decoration class on the paragraph (a wholly-new pair,
                  // T-767) joins this one rather than replacing it.
                  <div
                    {...props}
                    className={["markdown-paragraph", props.className]
                      .filter(Boolean)
                      .join(" ")}
                  >
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
              const repeat =
                (props as Record<string, unknown>)[REF_REPEAT_ATTR] !==
                undefined;
              // `issueNumber` doubles as "the card being read", which is what
              // lets a reference to it render as "current". Every surface
              // that passes one today — the issue body, a comment, a document
              // card, the spec annotation view — is reading that very card,
              // so the two coincide. A surface that ever passes an issue
              // number it is NOT on would silently point this rule at the
              // wrong card; give it its own prop rather than widening this
              // one.
              return (
                <MarkdownLink
                  slug={slug}
                  pageNumber={issueNumber}
                  repeat={repeat}
                  {...props}
                />
              );
            },
            img: (
              props: ComponentProps<"img"> & { node?: unknown },
            ): ReactNode => {
              const swapSrc = (props as Record<string, unknown>)[SWAP_SRC_ATTR];
              if (typeof swapSrc === "string" && issueNumber !== undefined) {
                const swapAlt = (props as Record<string, unknown>)[
                  SWAP_ALT_ATTR
                ];
                const before = {
                  src: swapSrc,
                  alt: typeof swapAlt === "string" ? swapAlt : "",
                };
                const after = { src: props.src ?? "", alt: props.alt ?? "" };
                const authored =
                  (props as Record<string, unknown>)[PAIR_ATTR] !== undefined;
                return (
                  <ImageSwapCompare
                    slug={slug}
                    issueNumber={issueNumber}
                    before={before}
                    after={after}
                    labels={
                      authored
                        ? {
                            before: pairLabel(
                              before.alt,
                              before.src,
                              DEFAULT_COMPARE_LABELS.before,
                            ),
                            after: pairLabel(
                              after.alt,
                              after.src,
                              DEFAULT_COMPARE_LABELS.after,
                            ),
                          }
                        : undefined
                    }
                    className={props.className}
                  />
                );
              }
              const target = parseAttachmentHref(props.src);
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
              // Whether an address names an image is answered by the address,
              // not by whether this surface can look the attachment up. The
              // comment hover card renders without an issue number, and a text
              // document left in an <img> there draws the browser's
              // broken-image icon.
              if (target !== null && isTextEmbedName(target.name ?? "")) {
                return <a href={props.src}>{target.name}</a>;
              }
              const { node: _node, ...rest } = props;
              // biome-ignore lint/a11y/useAltText: alt is forwarded via props when the markdown provides one
              return <img {...rest} />;
            },
          }),
    }),
    [fenceBaselines, collapseLongFences, slug, issueNumber, embedded],
  );

  // `rehypeDetails` and `rehypeImagePairs` go first so that every later pass —
  // the caller's stamp, decoration and fold passes included — walks the tree
  // the reader will get, rather than one where a fold is still a pair of raw
  // HTML strings or a pair still two images. Pairs only where a comparison
  // can be drawn: without an issue they stay two images and an arrow.
  // `rehypeBlockBreaks` follows the pairs it has to see as blocks. The memo is
  // the array-identity rule this file opens with, applied to an array this
  // component now owns.
  const pairs = issueNumber !== undefined;
  const textEmbeds = pairs && !embedded;
  const rehypePasses = useMemo(
    () =>
      [
        rehypeDetails,
        ...(pairs ? [rehypeImagePairs] : []),
        ...(document ? [] : [[rehypeBlockBreaks, { textEmbeds }]]),
        ...(rehypePlugins ?? []),
      ] as ComponentProps<typeof Markdown>["rehypePlugins"],
    [pairs, document, textEmbeds, rehypePlugins],
  );

  return (
    // Typography lives in styles.css (.markdown-body, GitHub-style).
    <div ref={rootRef} className="markdown-body">
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePasses}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
});
