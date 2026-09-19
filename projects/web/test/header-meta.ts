import { expect } from "vitest";

/**
 * What every comment header has to show since T-435, shared by the suites
 * that reach one: the timeline and hover cards in comment-header-meta, the
 * four spec-document entry points in comment-header-meta-spec, and the
 * optimistic states in comment-header-meta-optimistic.
 */

/** The pair of links a settled header draws, told apart by the `<time>`. */
export function metaLinks(root: ParentNode, href: string) {
  const links = [
    ...root.querySelectorAll<HTMLAnchorElement>(`a[href='${href}']`),
  ];
  return {
    links,
    id: links.find((link) => link.querySelector("time") === null),
    stamp: links.find((link) => link.querySelector("time") !== null),
  };
}

/**
 * Asserted as exact text rather than as "contains a number", because
 * `T-435#comment-12`, `#12` and `comment by…` all contain one.
 */
export function expectHeaderMeta(
  root: ParentNode,
  href: string,
  id: number,
  createdAt: string,
) {
  const { links, id: idLink, stamp } = metaLinks(root, href);
  expect(links).toHaveLength(2);
  expect(idLink?.textContent).toBe(`#comment-${id}`);
  expect(idLink?.textContent).not.toContain("T-");
  // One selectable token holding the suffix alone — the timestamp is a
  // sibling, so a drag across the id copies neither it nor the author.
  const token = idLink?.querySelector(".select-all");
  expect(token?.textContent).toBe(`#comment-${id}`);
  expect(token?.querySelector("time")).toBeNull();
  expect(stamp?.textContent).toBe(new Date(createdAt).toLocaleString());
  const time = stamp?.querySelector("time");
  expect(time?.getAttribute("datetime")).toBe(createdAt);
  expect(time?.getAttribute("title")).toBe(createdAt);
  // Navigation is a link, not a handler hung on a button.
  for (const link of links) {
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(href);
  }
  // The id reads first, the time follows it.
  expect(
    (idLink?.compareDocumentPosition(stamp as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  return { idLink, stamp };
}
