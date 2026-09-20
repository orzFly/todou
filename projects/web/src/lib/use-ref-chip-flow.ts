import { useLayoutEffect, useRef } from "react";

const ROOT = ".markdown-body";
const CHIPS = "a.ref-chip-body.border, a.comment-link-body.border";
const GUTTER = "--ref-chip-gutter";
/**
 * Every property a pass may write, captured and put back as one group: a flow
 * that stops paying must not keep half of what a previous pass gave it.
 */
const OWNED = [
  "padding-left",
  "padding-right",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "min-width",
  GUTTER,
];
const pixels = (value: string) => Number.parseFloat(value) || 0;

type InlineValue = { value: string; priority: string };
type FlowStyle = Map<string, InlineValue>;

function inlineValue(
  style: CSSStyleDeclaration,
  property: string,
): InlineValue {
  return {
    value: style.getPropertyValue(property),
    priority: style.getPropertyPriority(property),
  };
}

function setInline(
  style: CSSStyleDeclaration,
  property: string,
  { value, priority }: InlineValue,
) {
  if (
    style.getPropertyValue(property) === value &&
    style.getPropertyPriority(property) === priority
  )
    return;
  if (value) style.setProperty(property, value, priority);
  else style.removeProperty(property);
}

function capture(element: HTMLElement): FlowStyle {
  return new Map(
    OWNED.map((property) => [property, inlineValue(element.style, property)]),
  );
}

function restore(element: HTMLElement, original: FlowStyle) {
  for (const [property, value] of original)
    setInline(element.style, property, value);
}

/**
 * A row flex item pays for padding out of its siblings' width rather than its
 * own: padding enlarges its flex base size, the line re-solves, and the
 * sibling that just lost those pixels is the one that ends up overflowing —
 * T-496 measured a `<summary>` of two paragraphs where paying 5.2px at the
 * second put 2.83px of the first outside its box. No ordering avoids it,
 * because the two are the same depth.
 *
 * Freezing the item at the width the line already gave it makes the payment
 * local again. A frozen item takes exactly the share it had solved to, so
 * every sibling keeps the used width that was just measured, and the padding
 * comes out of this flow's own content box the way it does in block flow —
 * which is the premise the single pass below rests on.
 *
 * `min-width` goes with it: a flex item's automatic minimum is its min-content
 * size including the padding about to be added, and that would push the item
 * straight back past the width just frozen.
 *
 * Inline sizes derived from content in some other formatting context — an
 * auto-layout table's columns, a `max-content` grid track — can still carry a
 * payment outward. Nothing measured has reached one; this is the shape that
 * was reached.
 */
function freezeInlineSize(
  container: HTMLElement,
  style: CSSStyleDeclaration,
  width: number,
  gutter: number,
) {
  const parent = container.parentElement;
  if (!parent) return;
  const { display, flexDirection } = getComputedStyle(parent);
  if (display !== "flex" && display !== "inline-flex") return;
  if (!flexDirection.startsWith("row")) return;
  const basis =
    style.boxSizing === "border-box"
      ? width
      : width -
        gutter -
        pixels(style.paddingLeft) -
        pixels(style.paddingRight) -
        pixels(style.borderLeftWidth) -
        pixels(style.borderRightWidth);
  const pins: [string, string][] = [
    ["flex-grow", "0"],
    ["flex-shrink", "0"],
    ["flex-basis", `${basis}px`],
    ["min-width", "0"],
  ];
  for (const [property, value] of pins)
    setInline(container.style, property, { value, priority: "important" });
}

// Match comment-reference's contentContainer, stopping at this Markdown root.
function contentContainer(anchor: HTMLElement, root: HTMLElement) {
  let parent = anchor.parentElement;
  while (parent) {
    const { display } = getComputedStyle(parent);
    if (
      display !== "" &&
      display !== "none" &&
      display !== "contents" &&
      display !== "inline" &&
      !display.startsWith("inline-")
    )
      return parent;
    if (parent === root) break;
    parent = parent.parentElement;
  }
  return null;
}

/** Reserve the cloned closing edge only in flows whose actual chips overflow. */
export function useRefChipFlow() {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const originals = new Map<HTMLElement, FlowStyle>();
    const sizes = new Map<HTMLElement, { width: number; height: number }>();
    let disposed = false;
    let frame: number | null = null;

    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            // Read the final border box, not the temporary unpadded state.
            // Content-box notifications also drive the comment allocator; its
            // gutter refund keeps that allocation unchanged by our padding.
            for (const entry of entries) {
              const element = entry.target as HTMLElement;
              const previous = sizes.get(element);
              const next = element.getBoundingClientRect();
              if (
                previous &&
                (next.width !== previous.width ||
                  next.height !== previous.height)
              ) {
                schedule();
                break;
              }
            }
          });

    const measure = () => {
      if (disposed) return;
      // Undo every owned flow before reading geometry, including ancestors.
      // Otherwise nested flows and subsequent passes can pay the same edge twice.
      for (const [element, original] of originals) restore(element, original);

      const groups = new Map<HTMLElement, HTMLElement[]>();
      for (const anchor of root.querySelectorAll<HTMLElement>(CHIPS)) {
        if (anchor.closest(ROOT) !== root) continue;
        const container = contentContainer(anchor, root);
        if (!container) continue;
        const group = groups.get(container);
        if (group) group.push(anchor);
        else groups.set(container, [anchor]);
      }
      const current = new Set([root, ...groups.keys()]);
      for (const element of originals.keys()) {
        if (current.has(element)) continue;
        // Already restored above, even when detached or moved to another root.
        originals.delete(element);
        sizes.delete(element);
        resizeObserver?.unobserve(element);
      }
      for (const element of current) {
        if (!originals.has(element)) {
          originals.set(element, capture(element));
          resizeObserver?.observe(element, { box: "border-box" });
        }
        // A child paragraph / embedded Markdown must not refund its parent's
        // gutter. Zero-gutter flows retain their original padding untouched.
        setInline(element.style, GUTTER, { value: "0px", priority: "" });
      }

      // Ancestors must pay before descendants are measured: a parent's gutter
      // narrows its nested flows and can create an overflow that did not exist
      // in the original layout. DOM depth makes the dependency order explicit,
      // even when a parent's first chip follows its nested list in source.
      const depth = (element: HTMLElement) => {
        let value = 0;
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        )
          value++;
        return value;
      };
      const ordered = [...groups].sort(
        ([left], [right]) => depth(left) - depth(right),
      );
      // One finite pass, one payment per flow, because a payment leaves every
      // flow's outer inline size where it was: block flow takes it out of the
      // content box on its own, and freezeInlineSize holds the one context
      // that would not. Nothing measured after a payment can have moved, so no
      // fixed-point retries or self-scheduled reflows are needed.
      for (const [container, anchors] of ordered) {
        if (container.clientWidth === 0) continue;
        const style = getComputedStyle(container);
        const box = container.getBoundingClientRect();
        const rtl = style.direction === "rtl";
        const padding = pixels(rtl ? style.paddingLeft : style.paddingRight);
        const edge = rtl
          ? box.left + pixels(style.borderLeftWidth)
          : box.right - pixels(style.borderRightWidth);
        let gutter = 0;
        for (const anchor of anchors) {
          const overflows = Array.from(anchor.getClientRects()).some(
            (fragment) =>
              fragment.width > 0 &&
              fragment.height > 0 &&
              (rtl ? edge - fragment.left : fragment.right - edge) > 0.05,
          );
          if (!overflows) continue;
          const chip = getComputedStyle(anchor);
          const closing = rtl
            ? pixels(chip.paddingLeft) + pixels(chip.borderLeftWidth)
            : pixels(chip.paddingRight) + pixels(chip.borderRightWidth);
          gutter = Math.max(gutter, closing);
        }
        if (gutter > 0) {
          freezeInlineSize(container, style, box.width, gutter);
          setInline(container.style, rtl ? "padding-left" : "padding-right", {
            value: `${padding + gutter}px`,
            priority: "important",
          });
          setInline(container.style, GUTTER, {
            value: `${gutter}px`,
            priority: "",
          });
        }
      }
      for (const element of current) {
        const { width, height } = element.getBoundingClientRect();
        sizes.set(element, { width, height });
      }
    };

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (
              records.some((record) => {
                const element =
                  record.target instanceof Element
                    ? record.target
                    : record.target.parentElement;
                return element === root || element?.closest(ROOT) === root;
              })
            )
              schedule();
          });
    mutationObserver?.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    measure();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      for (const [element, original] of originals) restore(element, original);
      originals.clear();
      sizes.clear();
    };
  }, []);

  return rootRef;
}
