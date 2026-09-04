import { type AlignGroup, alignGroups } from "./group-align.ts";
import type {
  Decorations,
  DeletionDecoration,
  DeletionPart,
  ImageSwap,
  SpanDecoration,
  TableOverlay,
} from "./rehype-decorations.ts";
import {
  blocksWhollyInGroups,
  type CellPart,
  cellImageGroups,
  imageText,
  offsetAt,
  outermostBlockOfGroup,
  type SegmentIndex,
  type SourceBlock,
  type SourceImage,
  type SourceRange,
  sourceOffsetOfText,
  sourceRangesOfText,
  tableOf,
} from "./spec-source-index.ts";
import { alignTable } from "./table-align.ts";
import { bagWith, coalescedWordDiff } from "./word-diff.ts";

/** An annotation as the document sees it: which slice of source it covers. */
export type AnchoredAnnotation = {
  key: string;
  kind: "comment" | "draft";
  start: number;
  end: number;
  colStart: number | null;
  colEnd: number | null;
};

/** The table block each leaf group inside a table belongs to (T-221). */
function tableBlocks(index: SegmentIndex): Map<number, number> {
  const owner = new Map<number, number>();
  for (let i = 0; i < index.blocks.length; i++) {
    const block = index.blocks[i];
    if (block === undefined || block.type !== "table") continue;
    if (block.firstGroup < 0) continue;
    for (let g = block.firstGroup; g <= block.lastGroup; g++) owner.set(g, i);
  }
  return owner;
}

/**
 * Every leaf block of a document, in document order — what one side of an
 * alignment is made of (T-211).
 *
 * Prose leaves come out of the segment table: the segments of one group are
 * contiguous in the flattened text, so a group is a slice of it and needs no
 * reassembly. A fence contributes no prose at all, so it comes out of the
 * block table instead and carries its own source, fences and all; `at` is -1
 * because there is no flattened text for it to sit in. An image is the same
 * shape of leaf (T-223), and its `at` of -1 earns it the same exemption: the
 * `leaf.at < 0` guard below keeps a newly added image out of `insert()`, so
 * it takes the whole-block highlight and never a word-level one.
 *
 * A table is one leaf too (T-221), folding all of its cells together. That is
 * the partition the whole card turns on: a cell competing document-wide loses
 * to whatever cell sits at its position elsewhere, and a column dropped out of
 * a three-column table reads as four unrelated removals. Folded, the table
 * anchors on its contents like any other leaf, and which cell became which is
 * `alignTable`'s question, asked inside the pair.
 *
 * That fold takes in the images its cells hold as well as their prose (T-230),
 * or a table whose prose did not change is a perfect anchor and `alignTable`
 * is never asked about it at all. It takes them in as text, though, and the
 * text is also what the score reads — so a leaf that holds pictures carries a
 * bag weighing each of them once instead, and leaves the anchor alone (T-239).
 */
export function leavesOf(index: SegmentIndex): AlignGroup[] {
  const leaves: AlignGroup[] = [];
  const owner = tableBlocks(index);
  const tables = new Map<number, AlignGroup>();
  for (const segment of index.segments) {
    const end = segment.at + segment.text.length;
    const table = owner.get(segment.group);
    if (table !== undefined) {
      const started = tables.get(table);
      if (started !== undefined) {
        started.text = index.text.slice(started.at, end);
        continue;
      }
      const leaf: AlignGroup = {
        group: index.blocks[table]?.firstGroup ?? segment.group,
        type: "table",
        text: segment.text,
        at: segment.at,
      };
      tables.set(table, leaf);
      leaves.push(leaf);
      continue;
    }
    const last = leaves.at(-1);
    if (last !== undefined && last.group === segment.group) {
      last.text = index.text.slice(last.at, end);
      continue;
    }
    leaves.push({
      group: segment.group,
      type: index.groupTypes[segment.group] ?? null,
      text: segment.text,
      at: segment.at,
    });
  }
  for (let i = 0; i < index.blocks.length; i++) {
    const block = index.blocks[i];
    if (block === undefined || block.type !== "table") continue;
    if (block.firstGroup < 0) continue;
    const marks: string[] = [];
    const urls: string[] = [];
    for (let g = block.firstGroup; g <= block.lastGroup; g++) {
      const image = index.images.get(g);
      if (image === undefined) continue;
      marks.push(imageText(image));
      urls.push(image.url);
    }
    if (marks.length === 0) continue;
    const leaf = tables.get(i);
    // A table with not one word of prose in it never reached the loop above,
    // so there is no leaf yet to append to.
    if (leaf === undefined) {
      leaves.push({
        group: block.firstGroup,
        type: "table",
        text: marks.join("\n"),
        at: -1,
        bag: bagWith("", urls),
      });
      continue;
    }
    // Weighed before the marks go in, because at this point `text` is still
    // nothing but the table's prose — which is the whole of what a bag should
    // weigh by the character (T-239).
    leaf.bag = bagWith(leaf.text, urls);
    // Appended rather than spliced in at their source positions: the prose
    // above is one contiguous slice of the flattened text, and appending is
    // what leaves an image-free table's leaf byte for byte what it was.
    leaf.text = `${leaf.text}\n${marks.join("\n")}`;
    // Only once a mark is actually in there. The text has stopped being a
    // slice of the flattened text, so the range `insert()` would compute for
    // it is not this leaf's; a table with no image keeps its `at` and keeps
    // the word-level `ins` that retiring `at` unconditionally would cost it.
    leaf.at = -1;
  }
  for (const block of index.blocks) {
    if (block.type !== "code" && block.type !== "image") continue;
    if (block.firstGroup < 0) continue;
    // A picture inside a table is the table's, and competes only inside the
    // pair of tables it belongs to (T-239) — one layer further down the
    // partition T-221 drew. Cut as a leaf here as well, it was the last thing
    // inside a table still competing document-wide, and it decided the
    // document's anchors: a paragraph's picture and a cell's picture with the
    // same markdown read as one anchor, cutting the run between two tables
    // apart before any score was asked for.
    if (block.type === "image" && owner.has(block.firstGroup)) continue;
    const image = index.images.get(block.firstGroup);
    leaves.push({
      group: block.firstGroup,
      type: block.type,
      text: index.source.slice(block.start, block.end),
      at: -1,
      // A lone picture has no prose but its alt, and no identity question
      // left to answer: two image leaves that reached the same run are, by
      // the anchor that put them there, not the same picture (T-239). What
      // is still open is which slot each one is, and alt is the only word
      // of evidence for it — with none, the non-crossing pairing falls back
      // on order of appearance, which is what it always did.
      ...(image === undefined ? {} : { bag: bagWith(image.alt, []) }),
    });
  }
  // Group numbers are handed out in document order, so this is document order.
  return leaves.sort((a, b) => a.group - b.group);
}

/** The pictures one table cell shows, in source order (T-239). */
function imagesOf(index: SegmentIndex, cell: SourceBlock): SourceImage[] {
  const images: SourceImage[] = [];
  for (const group of cellImageGroups(index, cell)) {
    const image = index.images.get(group);
    if (image !== undefined) images.push(image);
  }
  return images;
}

type ImageMatching = {
  pairs: Array<[SourceImage, SourceImage]>;
  oldOnly: SourceImage[];
  newOnly: SourceImage[];
};

/**
 * Which picture in a cell became which picture in the cell that replaced it
 * (T-239) — the innermost layer of the partition T-221 drew, below the table
 * and below the row × column crossing.
 *
 * The two questions are `pairCandidates`', in its order: equal identities pair
 * first, in order of appearance, and order of appearance settles the rest.
 * Words never enter, because a picture has none, and because anything reaching
 * the second step has already proved its url matches nothing.
 *
 * Identity has to go first. A cell showing [A, B] that now shows [B] lost A —
 * pair by position alone and it reads as A became B and B went, two false
 * statements in place of one true one.
 */
function matchImages(olds: SourceImage[], news: SourceImage[]): ImageMatching {
  const pairs: Array<[SourceImage, SourceImage]> = [];
  const restOld: SourceImage[] = [];
  const taken = new Set<number>();
  for (const old of olds) {
    const at = news.findIndex((nu, j) => !taken.has(j) && nu.url === old.url);
    const nu = at < 0 ? undefined : news[at];
    if (nu === undefined) {
      restOld.push(old);
      continue;
    }
    taken.add(at);
    pairs.push([old, nu]);
  }
  const restNew = news.filter((_, j) => !taken.has(j));
  const shared = Math.min(restOld.length, restNew.length);
  for (let k = 0; k < shared; k++) {
    const old = restOld[k];
    const nu = restNew[k];
    if (old === undefined || nu === undefined) continue;
    pairs.push([old, nu]);
  }
  // Source order, so a caller reading the result reads the cell.
  pairs.sort((a, b) => a[1].start - b[1].start);
  return {
    pairs,
    oldOnly: restOld.slice(shared),
    newOnly: restNew.slice(shared),
  };
}

/** A position in a paired table's final order: one the new side kept, or one
 * spliced back in because it went (T-221). */
type Slot = { kept: number } | { gone: number };

/**
 * Where the removed rows — or columns — of a paired table sit once they are
 * put back beside what they used to stand next to (T-221). Each removed entry
 * goes after the new position of the nearest old entry above it that survived,
 * or at the front when nothing above it did; several landing in one place keep
 * their old order.
 *
 * `skip` is the header row, which is placed before any of this and can never
 * be the entry a removed row follows.
 */
function finalOrder(
  count: number,
  skip: number,
  pairs: Array<[number, number]>,
  removed: number[],
): Slot[] {
  const back = new Map(pairs.map(([old, nu]) => [nu, old]));
  const kept = pairs.map(([old]) => old).sort((a, b) => a - b);
  const slots: Slot[] = [];
  for (let j = 0; j < skip; j++) slots.push({ kept: j });
  const first = kept[0] ?? Number.POSITIVE_INFINITY;
  for (const index of removed) {
    if (index < first) slots.push({ gone: index });
  }
  for (let j = skip; j < count; j++) {
    slots.push({ kept: j });
    const old = back.get(j);
    if (old === undefined) continue;
    const next = kept.find((k) => k > old) ?? Number.POSITIVE_INFINITY;
    for (const index of removed) {
      if (index > old && index < next) slots.push({ gone: index });
    }
  }
  return slots;
}

/**
 * Word-level diff of two versions, as decorations on the newer one (T-142).
 * The block-level "changed since vN" wash stays where it is and keeps
 * driving the ↑↓ navigation; this is what tells the reader *which words*
 * inside those blocks moved.
 *
 * Which words, though, is only a question worth answering when some of them
 * stayed. A block that is new in its entirety gets one highlight and no
 * inner marks (T-158): a brand-new table sliced into a box per cell says
 * nothing the single box around the table doesn't, and shatters the layout
 * to say it.
 *
 * Which of them stayed is answered per leaf block (T-163): the two sides are
 * aligned block against block first, and only then are words compared inside
 * each match. A block left without a match is the evidence — it was born, or
 * it went — where before the answer had to be inferred from how far a flat
 * word diff's insertions happened to reach.
 *
 * And inside a match, the same question is asked once more of every anchor
 * the word diff found (T-180): the words are compared through
 * `coalescedWordDiff`, so an anchor too light to pay for the two boxes it
 * opens is folded into the change instead of cutting it in half.
 *
 * All of it happens once, over the whole document (T-211). There is no line
 * evidence here any more and no per-hunk branch: `changedLineRanges` still
 * drives the wash and the navigation, but which block became which is decided
 * without ever asking where the lines fell. Three outcomes, three renderings —
 * a pair gets words, a new leaf gets a block highlight, a lost leaf gets a
 * marker at the seam it left.
 */
export function changeDecorations(
  baseline: SegmentIndex,
  current: SegmentIndex,
): Decorations {
  const spans: SpanDecoration[] = [];
  const deletions: DeletionDecoration[] = [];
  const blocks: SourceRange[] = [];
  const tables: TableOverlay[] = [];
  const images: ImageSwap[] = [];

  const insert = (from: number, to: number) => {
    for (const range of sourceRangesOfText(current, from, to)) {
      spans.push({ kind: "ins", start: range.start, end: range.end });
    }
  };

  /** Words in one cell, exactly as they are read in one paragraph. */
  const words = (from: string, to: string, at: number) => {
    const result = coalescedWordDiff(from, to);
    for (const range of result.ins) insert(at + range.start, at + range.end);
    for (const gone of result.del) {
      const text = from.slice(gone.from, gone.to);
      if (text.trim() === "") continue;
      const offset = sourceOffsetOfText(current, at + gone.at);
      if (offset === null) continue;
      // Always inline: the pair is one leaf block against one leaf block,
      // so whatever went — a word or the block's whole contents — the
      // block that replaced it is standing right there to carry the
      // strike-through (T-158's ruling for a rewritten table cell).
      deletions.push({ at: offset, text: text.trim(), block: false });
    }
  };

  const oldTables = tableBlocks(baseline);
  const newTables = tableBlocks(current);

  /**
   * A paired table, cell by cell (T-221). Nothing here goes through
   * `born` / `gone`: the alignment already knows which row is new and which
   * column went, and reaching that answer back through group sets would only
   * lose it again — a table holding raw HTML is opaque to coverage and would
   * fall back to a marker for an edit its own matrix describes exactly.
   */
  const table = (old: AlignGroup, nu: AlignGroup): void => {
    const oldAt = oldTables.get(old.group);
    const newAt = newTables.get(nu.group);
    if (oldAt === undefined || newAt === undefined) return;
    const from = tableOf(baseline, oldAt);
    const to = tableOf(current, newAt);
    if (from === null || to === null) return;
    const aligned = alignTable(from, to);
    const rowBack = new Map(aligned.rows.pairs.map(([o, n]) => [n, o]));
    const colBack = new Map(aligned.columns.pairs.map(([o, n]) => [n, o]));

    const lost: TableOverlay["lost"] = [];
    for (const [ro, rn] of aligned.rows.pairs) {
      for (const [co, cn] of aligned.columns.pairs) {
        const before = from.rows[ro]?.cells[co];
        if (before === undefined || before === null) continue;
        const after = to.rows[rn]?.cells[cn];
        const parts: CellPart[] = [];
        const cleared =
          after === undefined || after === null || after.text === "";
        // A cell emptied — or padded away — has no text node left to carry
        // the strike-through, so the overlay puts one back in it.
        if (cleared) {
          if (before.text !== "")
            parts.push({ kind: "text", text: before.text });
        } else {
          words(before.text, after.text, after.at);
        }
        const matched = matchImages(
          imagesOf(baseline, before.block),
          after === undefined || after === null
            ? []
            : imagesOf(current, after.block),
        );
        for (const [old, nu] of matched.pairs) {
          // Byte for byte the same picture, so nothing is drawn on it. At
          // document level `diffArrays` reached this outcome by itself —
          // two identical image leaves are an anchor and `changeDecorations`
          // is never asked about them — and inside a cell there is no anchor
          // pass to reach it, so the same evidence is weighed here. Drop
          // this and a cell holding two pictures where only the first was
          // swapped hands the untouched second one an `ImageSwap` too, which
          // `rehype-decorations` renders as newly added.
          if (
            baseline.source.slice(old.start, old.end) ===
            current.source.slice(nu.start, nu.end)
          ) {
            continue;
          }
          // A swap T-223 draws in this very cell, old beside new. Only the
          // url decides whether the old one is worth showing: a changed alt
          // leaves the same picture on the page (T-223).
          images.push({
            at: { start: nu.start, end: nu.end },
            old: old.url === nu.url ? null : { url: old.url, alt: old.alt },
          });
        }
        // A picture with no counterpart has nowhere left on the page to be,
        // so the overlay puts it back into the cell it went from (T-229).
        for (const old of matched.oldOnly) {
          parts.push({ kind: "image", url: old.url, alt: old.alt });
        }
        for (const nu of matched.newOnly) {
          blocks.push({ start: nu.start, end: nu.end });
        }
        // Prose first, then images: this is appended to a cell that is still
        // on the page, so the order carries no meaning of its own.
        if (parts.length > 0) lost.push({ row: rn, col: cn, parts });
      }
    }

    for (const rn of aligned.rows.newOnly) {
      const row = to.rows[rn];
      if (row === undefined) continue;
      blocks.push({ start: row.block.start, end: row.block.end });
    }
    for (const cn of aligned.columns.newOnly) {
      // Only the rows that stayed: a new row's cells are covered by the row.
      for (const [, rn] of aligned.rows.pairs) {
        const cell = to.rows[rn]?.cells[cn];
        if (cell === undefined || cell === null) continue;
        blocks.push({ start: cell.block.start, end: cell.block.end });
      }
    }

    const columnOrder = finalOrder(
      to.rows[0]?.cells.length ?? 0,
      0,
      aligned.columns.pairs,
      aligned.columns.oldOnly,
    );
    const rowOrder = finalOrder(
      to.rows.length,
      1,
      // Without the header pair, which is placed first and is nobody's anchor.
      aligned.rows.pairs.filter(([ro]) => ro !== 0),
      aligned.rows.oldOnly,
    );

    /**
     * One cell of a removed column or row, as the stand-in shows it. Every
     * image in it is accounted for whether it paired or not: the stand-in
     * renders the cell's parts whole, so all of them are back on the page.
     */
    const standIn = (row: number, col: number): CellPart[] =>
      from.rows[row]?.cells[col]?.parts ?? [];

    const columns: TableOverlay["columns"] = [];
    columnOrder.forEach((slot, at) => {
      if (!("gone" in slot)) return;
      columns.push({
        at,
        cells: to.rows.map((_, rn) => {
          const ro = rowBack.get(rn);
          return ro === undefined ? [] : standIn(ro, slot.gone);
        }),
      });
    });
    const rows: TableOverlay["rows"] = [];
    rowOrder.forEach((slot, at) => {
      if (!("gone" in slot)) return;
      rows.push({
        at,
        cells: columnOrder.map((column) => {
          const co = "gone" in column ? column.gone : colBack.get(column.kept);
          return co === undefined ? [] : standIn(slot.gone, co);
        }),
      });
    });
    if (columns.length === 0 && rows.length === 0 && lost.length === 0) {
      return;
    }
    tables.push({
      table: { start: to.block.start, end: to.block.end },
      columns,
      rows,
      lost,
    });
  };

  const newLeaves = leavesOf(current);
  const alignment = alignGroups(leavesOf(baseline), newLeaves);

  for (const matched of alignment.pairs) {
    // pierre owns the inside of a fence (T-31): a paired code block gets the
    // block-level wash it already has and nothing else.
    if (matched.old.type === "code" || matched.new.type === "code") continue;
    if (matched.old.type === "table" || matched.new.type === "table") {
      table(matched.old, matched.new);
      continue;
    }
    // A paired image is a swap: the two sides align by their markdown source,
    // so a pair that survived the floor is the same picture's slot, whatever
    // the url now points at (T-223). Only the url decides whether the old one
    // is worth showing — a changed alt or title leaves the same picture on the
    // page, and drawing it twice side by side would say nothing.
    if (matched.old.type === "image" || matched.new.type === "image") {
      const old = baseline.images.get(matched.old.group);
      const nu = current.images.get(matched.new.group);
      if (old === undefined || nu === undefined) continue;
      images.push({
        at: { start: nu.start, end: nu.end },
        old: old.url === nu.url ? null : { url: old.url, alt: old.alt },
      });
      continue;
    }
    words(matched.old.text, matched.new.text, matched.new.at);
  }

  // Take the whole blocks the new leaves build, then word-mark only the
  // leaves those blocks left over.
  const born = groupsOf(current, newTables, alignment.newOnly);
  const absorbed = new Set<number>();
  for (const block of blocksWhollyInGroups(current, born)) {
    blocks.push({ start: block.start, end: block.end });
    for (let g = block.firstGroup; g <= block.lastGroup; g++) absorbed.add(g);
  }
  for (const leaf of alignment.newOnly) {
    // A fence always qualifies as a whole block, so it is absorbed above and
    // never reaches this; if it ever did there would be no text node to mark.
    if (absorbed.has(leaf.group) || leaf.at < 0) continue;
    insert(leaf.at, leaf.at + leaf.text.length);
  }

  // Every leaf here is one no table can speak for: since T-239 a picture
  // inside a table is not a leaf at all, so the suppression this list used to
  // need — a marker repeating, outside the table, a picture the overlay had
  // already put back inside it (T-229) — has nothing left to suppress.
  const oldOnly = alignment.oldOnly;
  // Old blocks with no counterpart have nowhere to be struck through, so they
  // degrade to a marker at the seam. The text is the baseline's own source —
  // a whole table row reads as the row, `| --- |` and all — which is why the
  // outermost gone block, not the leaf, is what gets quoted (T-209).
  // Neighbours with nothing new between them share one marker.
  const gone = groupsOf(
    baseline,
    oldTables,
    oldOnly.map((entry) => entry.group),
  );
  const seams = new Map(
    oldOnly.map((entry) => [entry.group.group, entry.newIndex]),
  );
  const removed: Array<{
    order: number;
    newIndex: number;
    text: string;
    /** Empty unless the removed source holds an image (T-223). */
    parts: DeletionPart[];
  }> = [];
  const covered = new Set<number>();
  for (const block of blocksWhollyInGroups(baseline, gone)) {
    let seam: number | undefined;
    for (let g = block.firstGroup; g <= block.lastGroup; g++) {
      covered.add(g);
      seam ??= seams.get(g);
    }
    if (seam === undefined) continue;
    removed.push({
      order: block.firstGroup,
      newIndex: seam,
      text: baseline.source.slice(block.start, block.end),
      parts: partsOf(baseline, { start: block.start, end: block.end }),
    });
  }
  for (const entry of oldOnly) {
    if (covered.has(entry.group.group)) continue;
    // Only an image leaf can be located back in the source: a prose leaf's
    // text is the flattened text, which has no range of its own, so a
    // deletion made of prose never grows parts and renders as it always did.
    const image = baseline.images.get(entry.group.group);
    removed.push({
      order: entry.group.group,
      newIndex: entry.newIndex,
      text: entry.group.text,
      parts:
        image === undefined
          ? []
          : partsOf(baseline, { start: image.start, end: image.end }),
    });
  }
  removed.sort((a, b) => a.order - b.order);
  for (const cluster of clusterDeletions(removed)) {
    const text = cluster.texts.join("\n");
    if (text.trim() === "") continue;
    deletions.push({
      at: seamAt(current, newLeaves, cluster.newIndex),
      text,
      block: true,
      ...(cluster.parts === null ? {} : { parts: cluster.parts }),
    });
  }
  return { spans, deletions, blocks, tables, images };
}

/**
 * A removed source range cut around the images inside it (T-223). A marker is
 * the only place removed content appears at all (T-209), and quoting
 * `![](/api/…/screenshot.png)` at a reader is quoting a url, not showing them
 * what went — so the images become images and the source between them stays
 * source. Empty when the range holds no image, which is the signal to render
 * the marker byte for byte the way it always was.
 */
function partsOf(index: SegmentIndex, range: SourceRange): DeletionPart[] {
  const inside = [...index.images.values()]
    .filter((image) => image.start >= range.start && image.end <= range.end)
    .sort((a, b) => a.start - b.start);
  if (inside.length === 0) return [];
  const parts: DeletionPart[] = [];
  let at = range.start;
  for (const image of inside) {
    if (image.start > at) {
      parts.push({ kind: "text", text: index.source.slice(at, image.start) });
    }
    parts.push({ kind: "image", url: image.url, alt: image.alt });
    at = image.end;
  }
  if (at < range.end) {
    parts.push({ kind: "text", text: index.source.slice(at, range.end) });
  }
  return parts;
}

/**
 * The leaf groups a set of leaves stands for. A table leaf stands for every
 * group in its table (T-221), which is what keeps `blocksWhollyInGroups`
 * answering exactly what it did when each cell was a leaf of its own: a whole
 * table added or removed is still one block, evidenced by all of its cells.
 */
function groupsOf(
  index: SegmentIndex,
  owner: Map<number, number>,
  leaves: AlignGroup[],
): Set<number> {
  const groups = new Set<number>();
  for (const leaf of leaves) {
    const at = leaf.type === "table" ? owner.get(leaf.group) : undefined;
    const block = at === undefined ? undefined : index.blocks[at];
    if (block === undefined) {
      groups.add(leaf.group);
      continue;
    }
    for (let g = block.firstGroup; g <= block.lastGroup; g++) groups.add(g);
  }
  return groups;
}

/**
 * Unmatched old blocks that sit at the same seam, merged into one marker.
 *
 * `parts` is null unless some entry in the cluster holds an image, which is
 * what keeps every image-free marker on the byte-for-byte path it has always
 * had (T-223). Once one entry has images the whole cluster is cut into parts,
 * because the marker renders as one thing: the entries that have none
 * contribute their source as a single text part, joined by the same newline
 * `texts` is joined by.
 */
function clusterDeletions(
  removed: Array<{ newIndex: number; text: string; parts: DeletionPart[] }>,
): Array<{ newIndex: number; texts: string[]; parts: DeletionPart[] | null }> {
  const clusters: Array<{
    newIndex: number;
    texts: string[];
    segments: DeletionPart[];
    withImage: boolean;
  }> = [];
  for (const entry of removed) {
    let last = clusters.at(-1);
    if (last === undefined || last.newIndex !== entry.newIndex) {
      last = {
        newIndex: entry.newIndex,
        texts: [],
        segments: [],
        withImage: false,
      };
      clusters.push(last);
    } else last.segments.push({ kind: "text", text: "\n" });
    last.texts.push(entry.text);
    last.segments.push(
      ...(entry.parts.length > 0
        ? entry.parts
        : [{ kind: "text" as const, text: entry.text }]),
    );
    last.withImage ||= entry.parts.length > 0;
  }
  return clusters.map(({ newIndex, texts, segments, withImage }) => ({
    newIndex,
    texts,
    parts: withImage ? segments : null,
  }));
}

/**
 * Where a structural marker goes, in the new document's coordinates. The
 * rehype pass splices these between top-level elements, so the answer has to
 * be a top-level seam: the start of the outermost block that follows the
 * deletion, or the end of the one before it when nothing follows.
 */
function seamAt(
  index: SegmentIndex,
  leaves: AlignGroup[],
  newIndex: number,
): number {
  const after = leaves[newIndex];
  if (after !== undefined) {
    const block = outermostBlockOfGroup(index, after.group);
    if (block !== null) return block.start;
  }
  const before = leaves[newIndex - 1];
  if (before !== undefined) {
    const block = outermostBlockOfGroup(index, before.group);
    if (block !== null) return block.end;
  }
  return index.source.length;
}

/**
 * Precise highlights for the comments and drafts on this file. Anchors
 * without columns — every anchor taken before T-142, and everything the
 * diff view still produces — get nothing here and keep the whole-block
 * amber they have always had.
 */
export function annotationDecorations(
  index: SegmentIndex,
  annotations: AnchoredAnnotation[],
): SpanDecoration[] {
  const spans: SpanDecoration[] = [];
  for (const annotation of annotations) {
    if (annotation.colStart === null || annotation.colEnd === null) continue;
    const start = offsetAt(index, annotation.start, annotation.colStart);
    const end = offsetAt(index, annotation.end, annotation.colEnd);
    if (start === null || end === null || end < start) continue;
    spans.push({
      kind: annotation.kind,
      start,
      // Columns are inclusive; source offsets are half-open.
      end: end + 1,
      key: annotation.key,
    });
  }
  return spans;
}

/** Both decoration sources, merged into what the rehype plugin takes. */
export function mergeDecorations(
  changes: Decorations,
  annotations: SpanDecoration[],
): Decorations {
  return {
    spans: [...changes.spans, ...annotations],
    deletions: changes.deletions,
    blocks: changes.blocks,
    tables: changes.tables,
    images: changes.images,
  };
}
