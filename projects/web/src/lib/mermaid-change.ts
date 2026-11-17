import { scratchHost } from "@/lib/mermaid.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Past this share of both sides' units without a partner, colour no longer
 * points at what changed — nearly the whole diagram is one colour — so both
 * sides are drawn plain (T-773).
 */
export const MAX_CHANGED = 0.5;

/**
 * Which keys have no partner on the other side: the k-th occurrence of a key
 * is surplus when the other side holds that key fewer than k times, so
 * repeated keys pair one-to-one.
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

type Change = "removed" | "added";

/**
 * One thing a change is coloured as — a message, a participant, a node, an
 * edge — with the key that has to match on the other side. `measure` reads
 * every box it needs and returns the step that paints: all units are
 * measured before any is painted, since a band or box added to the drawing
 * would move the next box measured in it.
 */
type Unit = { key: string; measure: (change: Change) => () => void };

const color = (change: Change) =>
  change === "removed" ? "var(--diff-deletion)" : "var(--diff-addition)";

const tint = (change: Change, percent: number) =>
  `color-mix(in oklab, ${color(change)} ${percent}%, transparent)`;

/**
 * The two renders with what changed between them coloured, red on the old
 * side and green on the new (T-773). Sequence diagrams and flowcharts are
 * read as units; any other type, or an output whose attributes no longer
 * look like what this reads, falls back to boxing the unpaired labels
 * (T-724) for both sides alike.
 */
export function colourChanges(
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
    const [oldUnits, nextUnits] = pairedUnits(old, next);
    const marks = surplusLabels(
      oldUnits.map((u) => u.key),
      nextUnits.map((u) => u.key),
    );
    const total = oldUnits.length + nextUnits.length;
    const changed =
      marks.before.filter(Boolean).length + marks.after.filter(Boolean).length;
    if (total === 0 || changed / total > MAX_CHANGED) return { before, after };
    const paints = [
      ...oldUnits.flatMap((u, i) =>
        marks.before[i] ? [u.measure("removed")] : [],
      ),
      ...nextUnits.flatMap((u, i) =>
        marks.after[i] ? [u.measure("added")] : [],
      ),
    ];
    for (const paint of paints) paint();
    return { before: old.innerHTML, after: next.innerHTML };
  } catch {
    // The colours are an aid; a diagram is never held back for them.
    return { before, after };
  } finally {
    host?.remove();
  }
}

/** Both sides read the same way, so a key on one means what it does on the other. */
function pairedUnits(old: Element, next: Element): [Unit[], Unit[]] {
  const oldSvg = old.querySelector("svg");
  const nextSvg = next.querySelector("svg");
  const type = oldSvg?.getAttribute("aria-roledescription");
  const read =
    type === "sequence"
      ? sequenceUnits
      : type === "flowchart-v2" || type === "flowchart"
        ? flowchartUnits
        : null;
  if (
    read !== null &&
    oldSvg != null &&
    nextSvg != null &&
    nextSvg.getAttribute("aria-roledescription") === type
  ) {
    const oldUnits = read(oldSvg);
    const nextUnits = read(nextSvg);
    if (oldUnits !== null && nextUnits !== null) return [oldUnits, nextUnits];
  }
  return [boxUnits(old), boxUnits(next)];
}

const norm = (el: Element) =>
  (el.textContent ?? "").replace(/\s+/g, " ").trim();

function ink(el: SVGElement, change: Change) {
  el.setAttribute("data-change", change);
  el.style.setProperty("fill", color(change));
  el.style.setProperty("font-weight", "600");
}

/**
 * Participants by their author id and name, both boxes together; messages by
 * sender id → receiver id and text, so renaming a participant colours only
 * the participant; alt / loop / else conditions by text.
 */
function sequenceUnits(svg: SVGSVGElement): Unit[] | null {
  const texts = [...svg.querySelectorAll<SVGTextElement>("text.messageText")];
  const lines = [
    ...svg.querySelectorAll<SVGGraphicsElement>('[data-et="message"]'),
  ];
  // mermaid draws each message's text, then its line; counts that disagree
  // mean the output is not the one this pairs.
  if (texts.length !== lines.length) return null;
  const view = viewBox(svg);
  if (view === null) return null;
  const units: Unit[] = [];

  const actors = new Map<
    string,
    { name: string; parts: Array<[SVGElement, SVGElement]> }
  >();
  for (const text of svg.querySelectorAll<SVGElement>("text.actor")) {
    const rect = text.previousElementSibling as SVGElement | null;
    const id = rect?.getAttribute("name");
    if (rect == null || rect.tagName.toLowerCase() !== "rect" || id == null)
      continue;
    const entry = actors.get(id) ?? { name: norm(text), parts: [] };
    entry.parts.push([rect, text]);
    actors.set(id, entry);
  }
  for (const [id, actor] of actors) {
    units.push({
      key: `actor ${id} ${actor.name}`,
      measure: (change) => () => {
        for (const [rect, text] of actor.parts) {
          rect.setAttribute("data-change", change);
          rect.style.setProperty("fill", tint(change, 16));
          rect.style.setProperty("stroke", color(change));
          rect.style.setProperty("stroke-width", "1.5px");
          ink(text, change);
        }
      },
    });
  }

  const band = (top: number, bottom: number, change: Change) => {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("data-band", "");
    rect.setAttribute("data-change", change);
    rect.setAttribute("x", String(view.x));
    rect.setAttribute("y", String(top));
    rect.setAttribute("width", String(view.width));
    rect.setAttribute("height", String(bottom - top));
    rect.setAttribute("style", `fill:${tint(change, 11)};pointer-events:none`);
    // Under everything, the lifelines included.
    svg.insertBefore(rect, svg.firstElementChild);
  };

  texts.forEach((text, i) => {
    const line = lines[i] as SVGGraphicsElement;
    const from = line.getAttribute("data-from");
    const to = line.getAttribute("data-to");
    units.push({
      key: `message ${from} > ${to} ${norm(text)}`,
      measure: (change) => {
        const t = text.getBBox();
        const l = line.getBBox();
        const top = Math.min(t.y, l.y) - 5;
        const bottom = Math.max(t.y + t.height, l.y + l.height) + 7;
        return () => {
          band(top, bottom, change);
          ink(text, change);
          line.setAttribute("data-change", change);
          line.style.setProperty("stroke", color(change));
          recolourMarker(svg, line, change);
        };
      },
    });
  });

  for (const text of svg.querySelectorAll<SVGTextElement>(
    "text.loopText, text.sectionTitle",
  )) {
    units.push({
      key: `condition ${norm(text)}`,
      measure: (change) => {
        const t = text.getBBox();
        return () => {
          band(t.y - 4, t.y + t.height + 4, change);
          ink(text, change);
        };
      },
    });
  }
  return units;
}

/**
 * Nodes by author id and text; edges by the author ids of both ends and their
 * label, so an edge with no label is a unit too.
 */
function flowchartUnits(svg: SVGSVGElement): Unit[] | null {
  const nodes = new Map<string, SVGElement>();
  for (const g of svg.querySelectorAll<SVGElement>("g.node")) {
    const id = /-flowchart-(.+)-\d+$/.exec(g.id)?.[1];
    if (id !== undefined) nodes.set(id, g);
  }
  const edges = svg.querySelectorAll<SVGPathElement>('path[data-et="edge"]');
  if (nodes.size === 0 && edges.length === 0) return null;
  const units: Unit[] = [];
  // Not bold: a label's foreignObject is sized for the weight it was drawn in.
  const labelInk = (el: Element, change: Change) => {
    for (const span of el.querySelectorAll<HTMLElement>("span, p"))
      span.style.setProperty("color", color(change));
  };

  for (const [id, g] of nodes) {
    units.push({
      key: `node ${id} ${norm(g)}`,
      measure: (change) => () => {
        g.setAttribute("data-change", change);
        for (const shape of g.querySelectorAll<SVGElement>(
          ":scope > rect, :scope > polygon, :scope > path, :scope > circle, :scope > ellipse, :scope > g > path",
        )) {
          shape.style.setProperty("fill", tint(change, 16));
          shape.style.setProperty("stroke", color(change));
          shape.style.setProperty("stroke-width", "1.5px");
        }
        labelInk(g, change);
      },
    });
  }

  // `L_<from>_<to>_<n>`, where either id may itself hold underscores: cut
  // where both halves are known nodes.
  const ends = (dataId: string) => {
    const body = dataId.replace(/^L_/, "").replace(/_\d+$/, "");
    for (let i = body.indexOf("_"); i !== -1; i = body.indexOf("_", i + 1)) {
      const from = body.slice(0, i);
      const to = body.slice(i + 1);
      if (nodes.has(from) && nodes.has(to)) return `${from} > ${to}`;
    }
    return body;
  };
  const labels = [...svg.querySelectorAll(".edgeLabel .label[data-id]")];
  for (const path of edges) {
    const dataId = path.getAttribute("data-id") ?? "";
    const label = labels.find((el) => el.getAttribute("data-id") === dataId);
    units.push({
      key: `edge ${ends(dataId)} ${label === undefined ? "" : norm(label)}`,
      measure: (change) => () => {
        path.setAttribute("data-change", change);
        path.style.setProperty("stroke", color(change));
        path.style.setProperty("stroke-width", "2.5px");
        recolourMarker(svg, path, change);
        if (label !== undefined) {
          label.closest(".edgeLabel")?.setAttribute("data-change", change);
          labelInk(label, change);
        }
      },
    });
  }
  return units;
}

/**
 * Points the line's arrowhead at a copy of its marker in the change's
 * colour, made once per marker and colour in each diagram.
 */
function recolourMarker(svg: SVGSVGElement, line: Element, change: Change) {
  const ref = /url\(#([^)]+)\)/.exec(
    line.getAttribute("marker-end") ?? "",
  )?.[1];
  if (ref === undefined) return;
  const id = `${ref}-${change}`;
  const markers = [...svg.querySelectorAll("marker")];
  if (!markers.some((m) => m.id === id)) {
    const marker = markers.find((m) => m.id === ref);
    if (marker === undefined) return;
    const copy = marker.cloneNode(true) as Element;
    copy.id = id;
    for (const path of copy.querySelectorAll<SVGElement>("path")) {
      path.style.setProperty("fill", color(change));
      path.style.setProperty("stroke", color(change));
    }
    marker.after(copy);
  }
  line.setAttribute("marker-end", `url(#${id})`);
}

function viewBox(svg: SVGSVGElement) {
  const [x, y, width, height] = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    [x, y, width, height].some(Number.isNaN)
    ? null
    : { x, y, width, height };
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
    const text = norm(element);
    if (text !== "") labels.push({ element, text });
  }
  return labels;
}

/**
 * Every label as a unit keyed by its text alone, boxed when it has no
 * partner (T-724): it works for every diagram type and is blind to what has
 * no text — an unlabelled edge, a changed shape.
 */
function boxUnits(root: Element): Unit[] {
  // A node holding several unpaired labels gets one box.
  const boxed = new Set<Element>();
  return collectLabels(root).map(({ element, text }) => ({
    key: text,
    measure: (change) => {
      const node = element.closest<SVGGraphicsElement>("g.node");
      if (node !== null) {
        if (boxed.has(node)) return () => {};
        boxed.add(node);
        const rect = markRect(node.getBBox(), 2, change);
        return () => node.append(rect);
      }
      const rect = markRect(element.getBBox(), 3, change);
      const transform = element.getAttribute("transform");
      if (transform !== null) rect.setAttribute("transform", transform);
      // Over the label, not under it: edge labels carry an opaque backdrop
      // that would hide a box drawn beneath them.
      return () => element.after(rect);
    },
  }));
}

function markRect(box: DOMRect, pad: number, change: Change): SVGRectElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("data-change", change);
  rect.setAttribute("x", String(box.x - pad));
  rect.setAttribute("y", String(box.y - pad));
  rect.setAttribute("width", String(box.width + pad * 2));
  rect.setAttribute("height", String(box.height + pad * 2));
  rect.setAttribute("rx", "4");
  // Inline, because mermaid's own sheet colors rects through id-scoped
  // selectors (`#mermaid-3 .node rect`) that no class rule outranks.
  rect.setAttribute(
    "style",
    `fill:${tint(change, 18)};stroke:${color(change)};stroke-width:1.5px;vector-effect:non-scaling-stroke;pointer-events:none`,
  );
  return rect;
}
