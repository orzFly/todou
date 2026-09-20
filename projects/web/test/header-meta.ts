import { expect } from "vitest";
import {
  COMMENT_HEADER_ACTION,
  COMMENT_HEADER_IDENTITY,
  COMMENT_HEADER_LINE,
  COMMENT_HEADER_ROW,
} from "../src/components/shared/comment-header-meta.tsx";

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

/** The row a header draws itself in, found through the meta it is built around. */
export function headerRowOf(root: ParentNode): HTMLElement {
  const meta = root.querySelector<HTMLElement>(
    "[data-testid='comment-header-meta']",
  );
  expect(meta, "no comment header in this subtree").not.toBeNull();
  // One level further out than the meta's own parent: T-487 put a box around
  // the participants that share the header's baseline, so the row can centre
  // them as a group instead of hanging them from the top of the buttons.
  const line = meta?.parentElement ?? null;
  expect(line, "the meta is not a child of a header line").not.toBeNull();
  expectClasses(line as Element, COMMENT_HEADER_LINE, "the header line");
  const row = line?.parentElement ?? null;
  expect(row, "the header line is not a child of a header row").not.toBeNull();
  return row as HTMLElement;
}

/**
 * What the row lays out, read through the baseline line. Above the breakpoint
 * that line is a box and the identity, the meta and the marks beside them are
 * its children; below it the line is `contents` and the grid places the same
 * elements itself. Either way they are what the row arranges, and every
 * assertion below is about them rather than about which of the two the
 * element tree happens to show.
 */
export function headerItems(row: HTMLElement): Element[] {
  return [...row.children].flatMap((child) =>
    child.className === COMMENT_HEADER_LINE ? [...child.children] : [child],
  );
}

function expectClasses(element: Element, classes: string, what: string) {
  const held = [...element.classList];
  for (const token of classes.split(" ")) {
    expect(held, `${what} is missing ${token}`).toContain(token);
  }
}

/**
 * That a header splits into two lines below `sm` the way the other six do
 * (T-445) — one shared vocabulary reaching every entry point, rather than
 * six copies free to drift apart, which is what the card's "all seven behave
 * alike" criteria would otherwise have to re-prove one surface at a time.
 *
 * Geometry is not asserted here and cannot be: happy-dom computes no layout,
 * so what each class *does* is graded in the browser by
 * scripts/user-baseline-smoke.mjs. This grades only which elements carry it.
 */
export function expectSplitHeader(
  row: HTMLElement,
  expected: {
    /** Text each of these has to find inside the identity group. */
    identity: string[];
    /**
     * What the reader may do here, already found — each entry point names its
     * own controls, and a selector general enough for all six would stop
     * telling them apart.
     */
    actions?: Array<Element | null | undefined>;
    /** Whether this row is one of the two carrying a spacer span. */
    spacer?: boolean;
  },
) {
  expectClasses(row, COMMENT_HEADER_ROW, "the header row");

  const identity = headerItems(row).filter(
    (child) => child.className === COMMENT_HEADER_IDENTITY,
  );
  expect(identity, "expected exactly one identity group").toHaveLength(1);
  const group = identity[0] as HTMLElement;
  expect(group.querySelector("a[href^='/users/']")).not.toBeNull();
  for (const text of expected.identity) {
    expect(group.textContent).toContain(text);
  }
  // The meta is the second line, so it is the one thing that must stay out
  // of the group holding the first.
  expect(group.querySelector("[data-testid='comment-header-meta']")).toBeNull();

  for (const action of expected.actions ?? []) {
    expect(action, "an expected action is not rendered").toBeTruthy();
    // The class belongs on whatever the row itself lays out, which for the
    // timeline is the group around the buttons rather than a button.
    const placed = headerItems(row).find(
      (child) => child === action || child.contains(action as Node),
    );
    expect(placed, "an action sits outside the header row").toBeTruthy();
    expectClasses(
      placed as Element,
      COMMENT_HEADER_ACTION,
      (action as Element).tagName.toLowerCase(),
    );
  }

  // Empty, inert and exactly the sort of thing a later reader deletes: it is
  // the `gap-2` between it and the meta that holds the desktop row where it
  // is, so the assertion is that it is still here, not merely hidden.
  const spacers = headerItems(row).filter(
    (child) =>
      child.tagName === "SPAN" &&
      child.classList.contains("ml-auto") &&
      !child.hasAttribute("data-testid"),
  );
  if (expected.spacer !== true) {
    expect(spacers).toHaveLength(0);
    return;
  }
  expect(spacers, "the desktop spacer span is gone").toHaveLength(1);
  expect(spacers[0].classList).toContain("max-sm:hidden");
  expect(spacers[0].textContent).toBe("");
}
