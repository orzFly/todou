import { type EditorView, type Rect, tooltips } from "@codemirror/view";

function clips(style: CSSStyleDeclaration): boolean {
  return style.overflowX !== "visible" || style.overflowY !== "visible";
}

/**
 * The area a tooltip can be seen in. A `fixed` tooltip escapes every
 * overflow box, so that is the window. An `absolute` one — inside a
 * transformed dialog, or on iOS, which always uses it — is cut by each
 * clipping ancestor up to the first fixed one, so the space shrinks to
 * those, and CodeMirror flips and shortens the popup to stay inside.
 */
export function visibleSpace(view: EditorView): Rect {
  const root = view.dom.ownerDocument.documentElement;
  const space = {
    top: 0,
    left: 0,
    bottom: root.clientHeight,
    right: root.clientWidth,
  };
  const tooltip = view.dom.querySelector<HTMLElement>(":scope > .cm-tooltip");
  if (tooltip === null || tooltip.style.position === "fixed") return space;
  for (let el = view.dom.parentElement; el !== null; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (clips(style)) {
      // The padding box: the border is not where content can show.
      const rect = el.getBoundingClientRect();
      const top = rect.top + el.clientTop;
      const left = rect.left + el.clientLeft;
      space.top = Math.max(space.top, top);
      space.left = Math.max(space.left, left);
      space.bottom = Math.min(space.bottom, top + el.clientHeight);
      space.right = Math.min(space.right, left + el.clientWidth);
    }
    if (style.position === "fixed") break;
  }
  return space;
}

export const tooltipSpace = tooltips({ tooltipSpace: visibleSpace });
