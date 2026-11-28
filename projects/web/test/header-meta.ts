import { expect } from "vitest";
import {
  COMMENT_HEADER_ACTION,
  COMMENT_HEADER_ANCHOR,
  COMMENT_HEADER_IDENTITY,
  COMMENT_HEADER_LINE,
  COMMENT_HEADER_ROW,
} from "../src/components/shared/comment-header-meta.tsx";
import { formatTimelineTime } from "../src/lib/timeline-time.ts";

/**
 * What every comment header has to show since T-435, shared by the suites
 * that reach one: the timeline and hover cards in comment-header-meta, the
 * four spec-document entry points in comment-header-meta-spec, and the
 * optimistic states in comment-header-meta-optimistic.
 */

/**
 * The one link a settled header draws (T-696), with the id and the time it
 * holds. `id` is the selectable token, not a link of its own any more.
 */
export function metaLinks(root: ParentNode, href: string) {
  const links = [
    ...root.querySelectorAll<HTMLAnchorElement>(`a[href='${href}']`),
  ].filter((link) => link.dataset.testid === "comment-header-meta");
  const link = links[0];
  return {
    links,
    link,
    id: link?.querySelector<HTMLElement>(".select-all") ?? undefined,
    stamp: link?.querySelector("time") ?? undefined,
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
  const { links, link, id: token, stamp } = metaLinks(root, href);
  // One link around both: two side by side went to the same place and
  // cost the keyboard two stops for one destination.
  expect(links).toHaveLength(1);
  // Navigation is a link, not a handler hung on a button.
  expect(link?.tagName).toBe("A");
  // One selectable token holding the suffix alone — the timestamp is a
  // sibling, so a drag across the id copies neither it nor the author. Never
  // `#12`: in a body that is an issue reference.
  expect(token?.textContent).toBe(`#comment-${id}`);
  expect(token?.querySelector("time")).toBeNull();
  expect(stamp?.textContent).toBe(formatTimelineTime(createdAt));
  expect(stamp?.getAttribute("datetime")).toBe(createdAt);
  expect(stamp?.getAttribute("title")).toBe(createdAt);
  // The id reads first, the time follows it.
  expect(
    (token?.compareDocumentPosition(stamp as Node) ?? 0) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  return { link, idToken: token, stamp };
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
 * What the row lays out, read through the baseline line: the identity, the
 * meta and the marks beside them, which are the line's children at every
 * width, and the actions beside the line.
 */
export function headerItems(row: HTMLElement): Element[] {
  return [...row.children].flatMap((child) =>
    child.className === COMMENT_HEADER_LINE ? [...child.children] : [child],
  );
}

/**
 * That a mark — `sending…`, `resolved` — rides the header's text line rather
 * than the action column (T-696). Below `sm` the line is a box of its own
 * now, so a mark asking for the grid's second column would ask in vain, and
 * the class it carried would only mislead the next reader.
 */
export function expectOnTextLine(row: HTMLElement, text: string) {
  const mark = headerItems(row).find((child) => child.textContent === text);
  expect(mark, `no ${text} in this header`).toBeTruthy();
  expect(mark?.parentElement?.className).toBe(COMMENT_HEADER_LINE);
  for (const token of COMMENT_HEADER_ACTION.split(" ")) {
    expect(mark?.classList).not.toContain(token);
  }
}

function expectClasses(element: Element, classes: string, what: string) {
  const held = [...element.classList];
  for (const token of classes.split(" ")) {
    expect(held, `${what} is missing ${token}`).toContain(token);
  }
}

/**
 * That a header takes its narrow shape below `sm` the way the other six do
 * (T-445, T-696) — one shared vocabulary reaching every entry point, rather
 * than six copies free to drift apart, which is what the card's "all seven
 * behave alike" criteria would otherwise have to re-prove one surface at a
 * time.
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
    /** Whether the identity group holds a spec annotation's anchor. */
    anchor?: true;
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
  // The meta is what wraps when the author and the time do not fit side by
  // side, so it stays out of the author's group. A state mark stays out too,
  // which the suites check with `expectOnTextLine`.
  expect(group.querySelector("[data-testid='comment-header-meta']")).toBeNull();

  if (expected.anchor) {
    const anchors = [...group.children].filter((child) =>
      /· v\d/.test(child.textContent ?? ""),
    );
    expect(anchors, "expected exactly one anchor in the group").toHaveLength(1);
    // What keeps the anchor on one line while the name still has letters to
    // give (T-826).
    expectClasses(anchors[0] as Element, COMMENT_HEADER_ANCHOR, "the anchor");
  }

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
