import type { ComponentProps, ReactNode } from "react";
import { useAttachmentForRef } from "@/api/attachments.ts";
import { AttachmentDocumentEmbed } from "@/components/issue/attachment-embed.tsx";
import {
  AttachmentInlineImage,
  AttachmentRichLink,
} from "@/components/issue/attachment-list.tsx";
import { MarkdownLink } from "@/components/shared/issue-link.tsx";
import { isTextEmbedName } from "@/lib/attachment-preview.ts";
import type { AttachmentRef } from "@/lib/attachment-refs.ts";

/**
 * The markdown overrides for attachment addresses (T-242).
 *
 * They exist as components rather than as logic inside `markdown-view.tsx`'s
 * override map because resolving an address takes a hook, and that map has
 * to keep its identity across renders — see the T-60 note there.
 *
 * Both pick the id the same way:
 *
 *   const id = found?.id ?? (address.slug === slug ? address.id : null)
 *
 * which leaves an address written under THIS project byte-for-byte as it was
 * before this card, including while the attachment list is still loading.
 * Only a foreign address waits for the list, and what it replaces is an
 * element that was broken anyway.
 */

type Resolved = {
  /** The attachment id to hand the rich components, or null to stay plain. */
  id: number | null;
  /** True when `address` reached this file by an address it no longer uses. */
  viaAlias: boolean;
  /** The resolved attachment's canonical URL, when there is one. */
  url: string | undefined;
};

function useResolved(
  slug: string,
  issueNumber: number,
  address: AttachmentRef,
): Resolved {
  const found = useAttachmentForRef(slug, issueNumber, address);
  return {
    id: found?.id ?? (address.slug === slug ? address.id : null),
    viaAlias:
      found != null && !(address.slug === slug && address.id === found.id),
    url: found?.url,
  };
}

export function MarkdownAttachmentAnchor({
  slug,
  issueNumber,
  address,
  originSlug,
  children,
  ...props
}: ComponentProps<"a"> & {
  slug: string;
  issueNumber: number;
  address: AttachmentRef;
  originSlug?: string;
  node?: { children?: Array<{ type: string; value?: string }> };
}): ReactNode {
  const { id } = useResolved(slug, issueNumber, address);
  if (id === null) {
    return (
      <MarkdownLink slug={slug} originSlug={originSlug} {...props}>
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

export function MarkdownAttachmentImage({
  slug,
  issueNumber,
  address,
  embedded,
  node: _node,
  ...props
}: ComponentProps<"img"> & {
  slug: string;
  issueNumber: number;
  address: AttachmentRef;
  /** Inside a document card already: embeds become links, not nested cards. */
  embedded: boolean;
  node?: unknown;
}): ReactNode {
  const { id, viaAlias, url } = useResolved(slug, issueNumber, address);
  if (id === null) {
    // biome-ignore lint/a11y/useAltText: alt is forwarded via props when the markdown provides one
    return <img {...props} />;
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
    />
  );
}
