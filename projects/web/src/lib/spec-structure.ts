import type { Alignment } from "./group-align.ts";
import {
  blocksWhollyInGroups,
  type SegmentIndex,
  type SourceBlock,
  type SourceBlockType,
} from "./spec-source-index.ts";

/** The source identity Main needs to find a block in the rendered tree. */
export type StructuralBlockRef = {
  /**
   * Index in `baseline.blocks` for `StructuralDeletion.old`, and in
   * `current.blocks` for its `parent` and `after`.
   */
  index: number;
  type: SourceBlockType;
  start: number;
  end: number;
};

/** One visible part of a source fallback that contains an image. */
export type StructuralFallbackPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; alt: string };

/**
 * A wholly removed block and the retained current-side structure beside which
 * it can be put back. `parent === null` names the document root;
 * `after === null` names the front of that parent. `order` is the block's old
 * direct-child ordinal, so records sharing a target retain their source order.
 */
export type StructuralDeletion = {
  old: StructuralBlockRef;
  parent: StructuralBlockRef | null;
  after: StructuralBlockRef | null;
  order: number;
  /** Existing marker data, retained as a safe rendering fallback. */
  fallback: {
    at: number;
    text: string;
    parts?: StructuralFallbackPart[];
  };
};

/** Planned structural placements and blocks whose parent could not be mapped. */
export type StructuralDeletionPlan = {
  planned: StructuralDeletion[];
  unplanned: SourceBlock[];
};

type StructuralGroupRef = {
  group: number;
  type?: SourceBlockType | null;
};

/** A lightweight alternative to passing all of `Alignment`. */
export type StructuralAlignmentPair =
  | { old: StructuralGroupRef; new: StructuralGroupRef }
  | readonly [oldGroup: number, newGroup: number];

/** An entry in current order, including old entries spliced back into it. */
export type PredecessorOrderSlot<T> = { kept: number } | { gone: T };

/**
 * Splice removed old entries after their nearest retained predecessor.
 *
 * This is the predecessor-priority rule used by table rows and columns: old
 * entries before the first survivor lead, entries between survivors follow the
 * earlier one, and entries after the last survivor precede later additions.
 * Several removals at one slot retain old order. `skip` reserves leading
 * current entries (for example a table header) that may not be predecessors.
 */
export function predecessorPriorityOrder<T>(
  currentCount: number,
  skip: number,
  pairs: ReadonlyArray<readonly [oldIndex: number, newIndex: number]>,
  removed: ReadonlyArray<readonly [oldIndex: number, value: T]>,
): Array<PredecessorOrderSlot<T>> {
  const oldByNew = new Map(pairs.map(([old, current]) => [current, old]));
  const retained = pairs.map(([old]) => old).sort((a, b) => a - b);
  const gone = [...removed].sort(([a], [b]) => a - b);
  const slots: Array<PredecessorOrderSlot<T>> = [];

  for (let current = 0; current < skip; current++) {
    slots.push({ kept: current });
  }
  const first = retained[0] ?? Number.POSITIVE_INFINITY;
  for (const [old, value] of gone) {
    if (old < first) slots.push({ gone: value });
  }
  for (let current = skip; current < currentCount; current++) {
    slots.push({ kept: current });
    const old = oldByNew.get(current);
    if (old === undefined) continue;
    const next =
      retained.find((candidate) => candidate > old) ?? Number.POSITIVE_INFINITY;
    for (const [removedOld, value] of gone) {
      if (removedOld > old && removedOld < next) slots.push({ gone: value });
    }
  }
  return slots;
}

type NormalizedPair = {
  old: StructuralGroupRef;
  new: StructuralGroupRef;
};

function isAlignment(
  evidence: Alignment | ReadonlyArray<StructuralAlignmentPair>,
): evidence is Alignment {
  return !Array.isArray(evidence);
}

/**
 * The leaf groups visible to `alignGroups`, without recreating their scoring
 * text. Tables and frontmatter fold all their cells into the first group.
 */
function alignmentLeaves(index: SegmentIndex): StructuralGroupRef[] {
  const foldedOwner = new Map<number, StructuralGroupRef>();
  for (const block of index.blocks) {
    if (
      (block.type !== "table" && block.type !== "frontmatter") ||
      block.firstGroup < 0
    ) {
      continue;
    }
    const owner = { group: block.firstGroup, type: block.type };
    for (let group = block.firstGroup; group <= block.lastGroup; group++) {
      foldedOwner.set(group, owner);
    }
  }

  const leaves: StructuralGroupRef[] = [];
  const seen = new Set<number>();
  const add = (group: number, type: SourceBlockType | null): void => {
    const folded = foldedOwner.get(group);
    const leaf = folded ?? { group, type };
    if (seen.has(leaf.group)) return;
    seen.add(leaf.group);
    leaves.push(leaf);
  };
  for (const segment of index.segments) {
    add(segment.group, index.groupTypes[segment.group] ?? null);
  }
  for (const block of index.blocks) {
    if (block.type !== "code" && block.type !== "image") continue;
    if (block.firstGroup < 0 || foldedOwner.has(block.firstGroup)) continue;
    add(block.firstGroup, block.type);
  }
  // A picture-only table never contributed a prose segment, but leavesOf still
  // aligns the folded table that owns the picture.
  for (const group of index.images.keys()) {
    const folded = foldedOwner.get(group);
    if (folded !== undefined) add(folded.group, folded.type ?? null);
  }
  return leaves.sort((a, b) => a.group - b.group);
}

function normalizePairs(
  baseline: SegmentIndex,
  current: SegmentIndex,
  evidence: Alignment | ReadonlyArray<StructuralAlignmentPair>,
): NormalizedPair[] {
  if (!isAlignment(evidence)) {
    return evidence.map((pair) =>
      "old" in pair
        ? { old: pair.old, new: pair.new }
        : { old: { group: pair[0] }, new: { group: pair[1] } },
    );
  }

  const pairs: NormalizedPair[] = evidence.pairs.map((pair) => ({
    old: pair.old,
    new: pair.new,
  }));
  const accountedOld = new Set([
    ...evidence.pairs.map((pair) => pair.old.group),
    ...evidence.oldOnly.map((entry) => entry.group.group),
  ]);
  const accountedNew = new Set([
    ...evidence.pairs.map((pair) => pair.new.group),
    ...evidence.newOnly.map((leaf) => leaf.group),
  ]);
  const oldAnchors = alignmentLeaves(baseline).filter(
    (leaf) => !accountedOld.has(leaf.group),
  );
  const newAnchors = alignmentLeaves(current).filter(
    (leaf) => !accountedNew.has(leaf.group),
  );
  const count = Math.min(oldAnchors.length, newAnchors.length);
  for (let at = 0; at < count; at++) {
    const old = oldAnchors[at];
    const nu = newAnchors[at];
    if (old !== undefined && nu !== undefined) pairs.push({ old, new: nu });
  }
  return pairs.sort((a, b) => a.old.group - b.old.group);
}

function depthOf(index: SegmentIndex, blockIndex: number): number {
  let depth = 0;
  for (let parent = index.blocks[blockIndex]?.parent; parent !== null; ) {
    if (parent === undefined) break;
    depth++;
    parent = index.blocks[parent]?.parent;
  }
  return depth;
}

function ancestorsOf(index: SegmentIndex, leaf: StructuralGroupRef): number[] {
  const contains = (block: SourceBlock): boolean =>
    block.firstGroup <= leaf.group && leaf.group <= block.lastGroup;
  let candidates: number[] = [];

  if (leaf.type !== undefined && leaf.type !== null) {
    candidates = index.blocks.flatMap((block, at) =>
      block.type === leaf.type &&
      block.firstGroup === leaf.group &&
      contains(block)
        ? [at]
        : [],
    );
  } else {
    // A table/frontmatter is folded into one alignment leaf at its first group.
    candidates = index.blocks.flatMap((block, at) =>
      (block.type === "table" || block.type === "frontmatter") &&
      block.firstGroup === leaf.group
        ? [at]
        : [],
    );
    if (candidates.length === 0) {
      const type = index.groupTypes[leaf.group];
      candidates = index.blocks.flatMap((block, at) =>
        block.type === type &&
        block.firstGroup === leaf.group &&
        contains(block)
          ? [at]
          : [],
      );
    }
  }

  const leafIndex = candidates.at(-1);
  if (leafIndex === undefined) return [];
  const chain: number[] = [];
  for (let at: number | null = leafIndex; at !== null; ) {
    chain.push(at);
    at = index.blocks[at]?.parent ?? null;
  }
  return chain.reverse();
}

/**
 * Derive only unambiguous one-to-one block mappings. Each matched leaf votes
 * along its ancestor chain, but only for equal types at equal depths. If an old
 * block points at several current blocks, or vice versa, none of those votes
 * becomes a mapping; adjacent lookalike containers therefore cannot cross.
 */
function containerMappings(
  baseline: SegmentIndex,
  current: SegmentIndex,
  evidence: Alignment | ReadonlyArray<StructuralAlignmentPair>,
): Map<number, number> {
  const oldCandidates = new Map<number, Set<number>>();
  const newCandidates = new Map<number, Set<number>>();
  for (const pair of normalizePairs(baseline, current, evidence)) {
    const olds = ancestorsOf(baseline, pair.old);
    const news = ancestorsOf(current, pair.new);
    const newsByDepth = new Map(news.map((at) => [depthOf(current, at), at]));
    for (const old of olds) {
      const oldBlock = baseline.blocks[old];
      const nu = newsByDepth.get(depthOf(baseline, old));
      const newBlock = nu === undefined ? undefined : current.blocks[nu];
      if (
        oldBlock === undefined ||
        nu === undefined ||
        newBlock?.type !== oldBlock.type
      )
        continue;
      const oldSet = oldCandidates.get(old) ?? new Set<number>();
      oldSet.add(nu);
      oldCandidates.set(old, oldSet);
      const newSet = newCandidates.get(nu) ?? new Set<number>();
      newSet.add(old);
      newCandidates.set(nu, newSet);
    }
  }

  const mappings = new Map<number, number>();
  for (const [old, candidates] of oldCandidates) {
    if (candidates.size !== 1) continue;
    const nu = candidates.values().next().value;
    if (nu === undefined || newCandidates.get(nu)?.size !== 1) continue;
    mappings.set(old, nu);
  }

  // Unique votes can still transpose two indistinguishable sibling lists.
  // Ordered alignment never licenses crossing mapped siblings.
  const crossing = new Set<number>();
  for (const [old, nu] of mappings) {
    const left = baseline.blocks[old];
    const right = current.blocks[nu];
    if (left === undefined || right === undefined) continue;
    for (const [otherOld, otherNu] of mappings) {
      if (otherOld <= old) continue;
      const otherLeft = baseline.blocks[otherOld];
      const otherRight = current.blocks[otherNu];
      if (
        otherLeft?.parent === left.parent &&
        otherRight?.parent === right.parent &&
        otherNu < nu
      ) {
        crossing.add(old);
        crossing.add(otherOld);
      }
    }
  }
  for (const old of crossing) mappings.delete(old);
  return mappings;
}

function refOf(
  index: SegmentIndex,
  blockIndex: number,
): StructuralBlockRef | null {
  const block = index.blocks[blockIndex];
  return block === undefined
    ? null
    : {
        index: blockIndex,
        type: block.type,
        start: block.start,
        end: block.end,
      };
}

function fallbackParts(
  baseline: SegmentIndex,
  block: SourceBlock,
): StructuralFallbackPart[] {
  const images = [...baseline.images.values()]
    .filter((image) => image.start >= block.start && image.end <= block.end)
    .sort((a, b) => a.start - b.start);
  if (images.length === 0) return [];
  const parts: StructuralFallbackPart[] = [];
  let at = block.start;
  for (const image of images) {
    if (image.start > at) {
      parts.push({
        kind: "text",
        text: baseline.source.slice(at, image.start),
      });
    }
    parts.push({ kind: "image", url: image.url, alt: image.alt });
    at = image.end;
  }
  if (at < block.end) {
    parts.push({ kind: "text", text: baseline.source.slice(at, block.end) });
  }
  return parts;
}

function insertionOffset(
  current: SegmentIndex,
  parentIndex: number | null,
  afterIndex: number | null,
): number {
  if (afterIndex !== null) return current.blocks[afterIndex]?.end ?? 0;
  const first = current.blocks.find(
    (block) => block.parent === parentIndex && block.childIndex === 0,
  );
  if (first !== undefined) return first.start;
  if (parentIndex === null) return current.source.length;
  return current.blocks[parentIndex]?.end ?? current.source.length;
}

/**
 * Plan whole-block removals without producing HAST or decorations.
 *
 * `goneGroups` is the complete baseline leaf-group coverage judged deleted by
 * the caller (including an expanded folded table leaf). The function selects
 * outermost wholly covered blocks, maps their old parent through unambiguous
 * matched-leaf ancestry, and anchors each after the nearest retained direct
 * predecessor. Blocks with no unique legal parent are returned in `unplanned`
 * for the caller's existing fallback path.
 */
export function planStructuralDeletions(
  baseline: SegmentIndex,
  current: SegmentIndex,
  alignment: Alignment | ReadonlyArray<StructuralAlignmentPair>,
  goneGroups: ReadonlySet<number>,
): StructuralDeletionPlan {
  const mappings = containerMappings(baseline, current, alignment);
  const planned: StructuralDeletion[] = [];
  const unplanned: SourceBlock[] = [];

  for (const block of blocksWhollyInGroups(baseline, goneGroups)) {
    const oldIndex = baseline.blocks.indexOf(block);
    if (oldIndex < 0) continue;
    const parentIndex =
      block.parent === null ? null : (mappings.get(block.parent) ?? undefined);
    if (parentIndex === undefined) {
      unplanned.push(block);
      continue;
    }

    let afterIndex: number | null = null;
    for (let candidate = oldIndex - 1; candidate >= 0; candidate--) {
      const oldPredecessor = baseline.blocks[candidate];
      if (
        oldPredecessor === undefined ||
        oldPredecessor.parent !== block.parent ||
        oldPredecessor.childIndex >= block.childIndex
      ) {
        continue;
      }
      const mapped = mappings.get(candidate);
      if (
        mapped === undefined ||
        current.blocks[mapped]?.parent !== parentIndex
      ) {
        continue;
      }
      afterIndex = mapped;
      break;
    }

    const old = refOf(baseline, oldIndex);
    const parent = parentIndex === null ? null : refOf(current, parentIndex);
    const after = afterIndex === null ? null : refOf(current, afterIndex);
    if (old === null || (parentIndex !== null && parent === null)) {
      unplanned.push(block);
      continue;
    }
    const parts = fallbackParts(baseline, block);
    planned.push({
      old,
      parent,
      after,
      order: block.childIndex,
      fallback: {
        at: insertionOffset(current, parentIndex, afterIndex),
        text: baseline.source.slice(block.start, block.end),
        ...(parts.length === 0 ? {} : { parts }),
      },
    });
  }
  return { planned, unplanned };
}
