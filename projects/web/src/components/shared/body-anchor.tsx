import type { ComponentProps } from "react";
import { useOpenExternalLinksInNewTab } from "@/api/prefs.ts";

/**
 * Whether `href` leaves todou: an http(s) address on another origin. A
 * pasted todou URL that did not resolve to a card is still ours, and
 * `mailto:` and friends hand off to another app rather than a page, so a
 * blank tab left behind would be all the reader got.
 */
export function isExternalHref(
  href: string | undefined,
  origin: string = window.location.origin,
): boolean {
  if (href === undefined) return false;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin !== origin
  );
}

/**
 * A plain link written in a markdown body. Still a real `<a href>` either
 * way; the reader's preference only decides where it opens (T-552).
 */
export function BodyAnchor(props: ComponentProps<"a">) {
  const newTab = useOpenExternalLinksInNewTab();
  if (!newTab || !isExternalHref(props.href)) return <a {...props} />;
  return <a {...props} target="_blank" rel="noopener noreferrer" />;
}
