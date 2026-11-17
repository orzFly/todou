import {
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  useAttachmentAddress,
  useAttachmentDeleted,
  useAttachmentForRef,
} from "@/api/attachments.ts";
import { AttachmentDocumentEmbed } from "@/components/issue/attachment-embed.tsx";
import {
  AttachmentInlineImage,
  AttachmentRichLink,
  DeletedAttachmentMark,
} from "@/components/issue/attachment-list.tsx";
import { MarkdownLink } from "@/components/shared/issue-link.tsx";
import {
  CompareLabelsContext,
  type CompareSide,
  MediaCompare,
} from "@/components/shared/media-compare.tsx";
import { isTextEmbedName } from "@/lib/attachment-preview.ts";
import {
  type AttachmentRef,
  parseAttachmentHref,
} from "@/lib/attachment-refs.ts";

/**
 * The markdown overrides for attachment addresses (T-242).
 *
 * They exist as components rather than as logic inside `markdown-view.tsx`'s
 * override map because resolving an address takes a hook, and that map has
 * to keep its identity across renders — see the T-60 note there.
 *
 * Both pick the id the same way:
 *
 *   const id = found?.id ?? (here ? ref.id : null)
 *
 * where `here` means the reference landed on the project being read. Landing
 * a slug spelling asks nothing, so such an address still renders byte-for-byte
 * as it did before the attachment list arrives. An id spelling waits for the
 * project directory instead, which the surrounding `MarkdownView` has already
 * put in flight; the frame before it answers is the plain link a foreign
 * address has always shown.
 */

type Resolved = {
  /** The attachment id to hand the rich components, or null to stay plain. */
  id: number | null;
  /** True when `address` reached this file by an address it no longer uses. */
  viaAlias: boolean;
  /** The resolved attachment's canonical URL, when there is one. */
  url: string | undefined;
  /** The file was deleted from this card (T-567). */
  deleted: boolean;
};

function useResolved(
  slug: string,
  issueNumber: number,
  ref: AttachmentRef,
): Resolved {
  const address = useAttachmentAddress(ref);
  const found = useAttachmentForRef(slug, issueNumber, address);
  const here = address != null && address.slug === slug;
  // Asked only once the live list has answered without it, so a file that
  // is still here never waits on the second query.
  const deleted = useAttachmentDeleted(
    slug,
    issueNumber,
    found === null && here ? ref.id : null,
  );
  return {
    id: found?.id ?? (here ? ref.id : null),
    viaAlias: found != null && !(here && ref.id === found.id),
    url: found?.url,
    deleted: deleted != null,
  };
}

export function MarkdownAttachmentAnchor({
  slug,
  issueNumber,
  address,
  children,
  ...props
}: ComponentProps<"a"> & {
  slug: string;
  issueNumber: number;
  address: AttachmentRef;
  node?: { children?: Array<{ type: string; value?: string }> };
}): ReactNode {
  const { id, deleted } = useResolved(slug, issueNumber, address);
  if (deleted) {
    return <DeletedAttachmentMark name={address.name ?? "attachment"} />;
  }
  if (id === null) {
    return (
      <MarkdownLink slug={slug} {...props}>
        {children}
      </MarkdownLink>
    );
  }
  return (
    <AttachmentRichLink
      slug={slug}
      issueNumber={issueNumber}
      attachmentId={id}
      href={props.href ?? ""}
      fallbackName={address.name ?? "attachment"}
    >
      {children}
    </AttachmentRichLink>
  );
}

type ImageSize = { width: number; height: number };

/** `onLoad`/`onError` for an `<img>` whose natural size someone is waiting on. */
function sizeHandlers(onSize: ((size: ImageSize | null) => void) | undefined) {
  if (onSize === undefined) return {};
  return {
    onLoad: (e: SyntheticEvent<HTMLImageElement>) =>
      onSize({
        width: e.currentTarget.naturalWidth,
        height: e.currentTarget.naturalHeight,
      }),
    onError: () => onSize(null),
  };
}

export function MarkdownAttachmentImage({
  slug,
  issueNumber,
  address,
  embedded,
  onSize,
  node: _node,
  ...props
}: ComponentProps<"img"> & {
  slug: string;
  issueNumber: number;
  address: AttachmentRef;
  /** Inside a document card already: embeds become links, not nested cards. */
  embedded: boolean;
  /** The natural size once loaded; null when there is nothing to load (T-722). */
  onSize?: (size: ImageSize | null) => void;
  node?: unknown;
}): ReactNode {
  const { id, viaAlias, url, deleted } = useResolved(
    slug,
    issueNumber,
    address,
  );
  useEffect(() => {
    if (deleted) onSize?.(null);
  }, [deleted, onSize]);
  if (deleted) {
    return (
      <DeletedAttachmentMark
        name={address.name ?? (props.alt || "image")}
        className={props.className}
      />
    );
  }
  if (id === null) {
    // biome-ignore lint/a11y/useAltText: alt is forwarded via props when the markdown provides one
    return <img {...props} {...sizeHandlers(onSize)} />;
  }
  // An alias was written when the file lived elsewhere; its canonical URL
  // saves every reader a 301 and is certainly readable from this project.
  // A reference already spelled canonically keeps the exact address the
  // author wrote — it may be the /view twin or carry a different name.
  const src = viaAlias && url !== undefined ? url : (props.src ?? "");
  const name = address.name ?? "";

  if (isTextEmbedName(name)) {
    if (embedded) {
      return (
        <AttachmentRichLink
          slug={slug}
          issueNumber={issueNumber}
          attachmentId={id}
          href={src}
          fallbackName={name}
          className={props.className}
        />
      );
    }
    return (
      <AttachmentDocumentEmbed
        slug={slug}
        issueNumber={issueNumber}
        attachmentId={id}
        href={src}
        fallbackName={name}
        className={props.className}
      />
    );
  }
  return (
    <AttachmentInlineImage
      slug={slug}
      issueNumber={issueNumber}
      attachmentId={id}
      src={src}
      alt={props.alt ?? name}
      // The spec diff marks a swapped image on the `<img>` itself rather
      // than on a wrapper, so the classes have to survive this swap or the
      // decoration is lost (T-223).
      className={props.className}
      onSize={onSize}
    />
  );
}

/** One side of a swap: an attachment when the address names one, else a plain image. */
function SwapSide({
  slug,
  issueNumber,
  src,
  alt,
  onSize,
}: {
  slug: string;
  issueNumber: number;
  src: string;
  alt: string;
  onSize: (size: ImageSize | null) => void;
}) {
  const address = parseAttachmentHref(src);
  if (address === null) {
    return <img src={src} alt={alt} {...sizeHandlers(onSize)} />;
  }
  return (
    <MarkdownAttachmentImage
      slug={slug}
      issueNumber={issueNumber}
      address={address}
      embedded={false}
      src={src}
      alt={alt}
      onSize={onSize}
    />
  );
}

/**
 * A swapped image in the spec comparison (T-722): the image adapter for
 * `MediaCompare`. Each side resolves its address as any markdown image does,
 * so a deleted file shows its mark and a click opens the viewer; the sizes
 * they report are what let the overlay modes line the two up.
 */
export function ImageSwapCompare({
  slug,
  issueNumber,
  before,
  after,
  className,
}: {
  slug: string;
  issueNumber: number;
  before: { src: string; alt: string };
  after: { src: string; alt: string };
  className?: string;
}) {
  const labels = useContext(CompareLabelsContext);
  // undefined until reported; null once it failed.
  const [beforeSize, setBeforeSize] = useState<ImageSize | null>();
  const [afterSize, setAfterSize] = useState<ImageSize | null>();
  const side = (
    label: string,
    image: { src: string; alt: string },
    size: ImageSize | null | undefined,
    onSize: (size: ImageSize | null) => void,
  ): CompareSide => ({
    label,
    content: (
      <SwapSide
        slug={slug}
        issueNumber={issueNumber}
        src={image.src}
        alt={image.alt}
        onSize={onSize}
      />
    ),
    size: size ?? null,
    failed: size === null,
  });
  return (
    <MediaCompare
      before={side(labels.before, before, beforeSize, setBeforeSize)}
      after={side(labels.after, after, afterSize, setAfterSize)}
      align="start"
      backdrop="checker"
      className={className}
    />
  );
}
