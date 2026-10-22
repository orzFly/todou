const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type TitleCut = {
  /** What is drawn, before the `…` the renderer adds. */
  head: string;
  /** What is left out of the drawing, still there for assistive technology. */
  rest: string;
};

/**
 * Where a title that wraps has to stop to stay inside `cap` pixels of text,
 * the `…` included; `null` when the whole title already fits.
 *
 * A width cap on a box cannot do this any more: the title is inline text so
 * that it can break across lines (T-541), and inline text has no width of its
 * own to overflow. So the cut is a text decision, made on grapheme clusters
 * so that no emoji or combining mark is split.
 */
export function cutTitle(
  title: string,
  measure: (text: string) => number,
  cap: number,
  ellipsis: number,
): TitleCut | null {
  if (measure(title) <= cap) return null;
  const clusters = Array.from(graphemes.segment(title), (one) => one.segment);
  // The longest prefix that fits with its ellipsis; width only grows with
  // length, so a binary search finds it.
  let low = 0;
  let high = clusters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(clusters.slice(0, middle).join("").trimEnd()) + ellipsis <= cap)
      low = middle;
    else high = middle - 1;
  }
  const kept = clusters.slice(0, low).join("");
  const head = kept.trimEnd();
  return { head, rest: title.slice(head.length) };
}
