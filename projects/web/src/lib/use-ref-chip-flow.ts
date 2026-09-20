import { useLayoutEffect, useRef } from "react";

const ROOT = ".markdown-body";
const CHIPS = "a.ref-chip-body.border, a.comment-link-body.border";
const GUTTER = "--ref-chip-gutter";
const pixels = (value: string) => Number.parseFloat(value) || 0;

type InlineValue = { value: string; priority: string };
type FlowStyle = {
  paddingLeft: InlineValue;
  paddingRight: InlineValue;
  gutter: InlineValue;
};

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

function restore(element: HTMLElement, original: FlowStyle) {
  setInline(element.style, "padding-left", original.paddingLeft);
  setInline(element.style, "padding-right", original.paddingRight);
  setInline(element.style, GUTTER, original.gutter);
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
          originals.set(element, {
            paddingLeft: inlineValue(element.style, "padding-left"),
            paddingRight: inlineValue(element.style, "padding-right"),
            gutter: inlineValue(element.style, GUTTER),
          });
          resizeObserver?.observe(element, { box: "border-box" });
        }
        // A child paragraph / embedded Markdown must not refund its parent's
        // gutter. Zero-gutter flows retain their original padding untouched.
        setInline(element.style, GUTTER, { value: "0px", priority: "" });
      }

      const payments: {
        container: HTMLElement;
        property: "padding-left" | "padding-right";
        padding: number;
        gutter: number;
      }[] = [];
      for (const [container, anchors] of groups) {
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
          payments.push({
            container,
            property: rtl ? "padding-left" : "padding-right",
            padding,
            gutter,
          });
        }
      }
      // All geometry above is from the same unreserved layout.
      for (const { container, property, padding, gutter } of payments) {
        setInline(container.style, property, {
          value: `${padding + gutter}px`,
          priority: "important",
        });
        setInline(container.style, GUTTER, {
          value: `${gutter}px`,
          priority: "",
        });
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
