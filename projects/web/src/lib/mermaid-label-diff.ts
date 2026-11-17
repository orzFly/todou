import { scratchHost } from "@/lib/mermaid.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Which labels have no partner on the other side: the k-th occurrence of a
 * text is surplus when the other side holds that text fewer than k times, so
 * repeated labels pair one-to-one.
 */
export function surplusLabels(
  before: readonly string[],
  after: readonly string[],
): { before: boolean[]; after: boolean[] } {
  return { before: surplus(before, after), after: surplus(after, before) };
}

function surplus(own: readonly string[], other: readonly string[]): boolean[] {
  const available = new Map<string, number>();
  for (const text of other) available.set(text, (available.get(text) ?? 0) + 1);
  const seen = new Map<string, number>();
  return own.map((text) => {
    const k = (seen.get(text) ?? 0) + 1;
    seen.set(text, k);
    return k > (available.get(text) ?? 0);
  });
}

/**
 * The two renders with every unpaired label boxed: red on the old side, green
 * on the new. Pairing is by text alone, so it works for every diagram type and
 * is blind to what has no text — an unlabelled edge, a changed shape.
 */
export function markChangedLabels(
  before: string,
  after: string,
): { before: string; after: string } {
  let host: HTMLDivElement | undefined;
  try {
    // Measured in a laid-out host: getBBox() needs a layout box.
    host = scratchHost();
    const [old, next] = [before, after].map((svg) => {
      const side = document.createElement("div");
      side.innerHTML = svg;
      host?.append(side);
      return side;
    }) as [HTMLDivElement, HTMLDivElement];
    const oldLabels = collectLabels(old);
    const nextLabels = collectLabels(next);
    const marks = surplusLabels(
      oldLabels.map((l) => l.text),
      nextLabels.map((l) => l.text),
    );
    // Measure everything before inserting anything: a mark added to a node
    // would grow that node's box for the next label measured in it.
    const plans = [
      ...plan(oldLabels, marks.before, "removed"),
      ...plan(nextLabels, marks.after, "added"),
    ];
    for (const insert of plans) insert();
    return { before: old.innerHTML, after: next.innerHTML };
  } catch {
    // The marks are an aid; a diagram is never held back for them.
    return { before, after };
  } finally {
    host?.remove();
  }
}

type Label = { element: SVGGraphicsElement; text: string };

// A label is a foreignObject (flowchart, class, state …) or a <text> that is
// not itself inside another <text> (sequence, gantt …).
function collectLabels(root: Element): Label[] {
  const labels: Label[] = [];
  for (const element of root.querySelectorAll<SVGGraphicsElement>(
    "foreignObject, text",
  )) {
    if (element.parentElement?.closest("text, foreignObject")) continue;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") labels.push({ element, text });
  }
  return labels;
}

type Change = "removed" | "added";

function plan(
  labels: readonly Label[],
  marked: readonly boolean[],
  change: Change,
): Array<() => void> {
  const inserts: Array<() => void> = [];
  const nodes = new Set<Element>();
  labels.forEach(({ element }, i) => {
    if (!marked[i]) return;
    const node = element.closest<SVGGraphicsElement>("g.node");
    if (node !== null) {
      if (nodes.has(node)) return;
      nodes.add(node);
      const rect = markRect(node.getBBox(), 2, change);
      inserts.push(() => node.append(rect));
      return;
    }
    const rect = markRect(element.getBBox(), 3, change);
    const transform = element.getAttribute("transform");
    if (transform !== null) rect.setAttribute("transform", transform);
    // Over the label, not under it: edge labels carry an opaque backdrop
    // that would hide a box drawn beneath them.
    inserts.push(() => element.after(rect));
  });
  return inserts;
}

function markRect(box: DOMRect, pad: number, change: Change): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("data-change", change);
  rect.setAttribute("x", String(box.x - pad));
  rect.setAttribute("y", String(box.y - pad));
  rect.setAttribute("width", String(box.width + pad * 2));
  rect.setAttribute("height", String(box.height + pad * 2));
  rect.setAttribute("rx", "4");
  const color = change === "removed" ? "--diff-deletion" : "--diff-addition";
  // Inline, because mermaid's own sheet colors rects through id-scoped
  // selectors (`#mermaid-3 .node rect`) that no class rule outranks.
  rect.setAttribute(
    "style",
    `fill:color-mix(in oklab, var(${color}) 18%, transparent);stroke:var(${color});stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:none`,
  );
  return rect;
}
