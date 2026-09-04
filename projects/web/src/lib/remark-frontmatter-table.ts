import type { Text as HastText } from "hast";
import type { Data, Parent, Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";

/** mdast's own position type, without pulling in `unist` as a dependency. */
type Position = NonNullable<Text["position"]>;

/**
 * The subtree a frontmatter block becomes (T-240). Registered with mdast below
 * rather than cast into place, so the walker in `spec-source-index` narrows on
 * these types the way it does on a table's.
 */
export interface Frontmatter extends Parent {
  type: "frontmatter";
  children: FrontmatterBody[];
}

export interface FrontmatterBody extends Parent {
  type: "frontmatterBody";
  children: FrontmatterFieldNode[];
}

export interface FrontmatterFieldNode extends Parent {
  type: "frontmatterField";
  children: Array<FrontmatterKey | FrontmatterValue>;
}

export interface FrontmatterKey extends Parent {
  type: "frontmatterKey";
  children: Text[];
}

export interface FrontmatterValue extends Parent {
  type: "frontmatterValue";
  children: Text[];
}

/** What `mdast-util-to-hast` renders an unknown node as, when we say so. */
type HastData = Data & {
  hName?: string;
  hProperties?: Record<string, unknown>;
  /** Handed to hast verbatim, in place of converting `children`. */
  hChildren?: HastText[];
};

declare module "mdast" {
  interface RootContentMap {
    frontmatter: Frontmatter;
    frontmatterBody: FrontmatterBody;
    frontmatterField: FrontmatterFieldNode;
    frontmatterKey: FrontmatterKey;
    frontmatterValue: FrontmatterValue;
    /**
     * `remark-frontmatter`'s other flavour. Core mdast registers `yaml` and
     * leaves this one to whoever turns TOML on.
     */
    toml: Omit<import("mdast").Yaml, "type"> & { type: "toml" };
  }
}

/**
 * One field of a frontmatter block: where its key and its value each sit in
 * the source, as absolute half-open offsets. `key` is null for a line that has
 * no key at all — TOML's `[section]`, or anything ahead of the first field.
 */
export type FrontmatterField = {
  key: { start: number; end: number } | null;
  value: { start: number; end: number };
  /** 1-based source lines, inclusive; `endLine` grows with continuation lines. */
  line: number;
  endLine: number;
};

/**
 * The flavours `remark-frontmatter` is switched on for, both of them by the
 * user's ruling on this card. A module constant because it is passed as a
 * plugin option, and a fresh array on every render is a fresh plugin list:
 * react-markdown rebuilds the whole document, and a rebuilt text node
 * collapses whatever selection was sitting in it (T-60).
 */
export const FRONTMATTER_FLAVOURS: Array<"yaml" | "toml"> = ["yaml", "toml"];

/** The separator each flavour writes between a key and its value. */
const SEPARATOR: Record<string, string> = { yaml: ":", toml: "=" };

/** Absolute offset each 1-based source line starts at. */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Cut a frontmatter block into fields, one line at a time — deliberately not
 * by parsing YAML (T-240).
 *
 * The whole decoration chain rests on every rendered character sitting at a
 * known source offset: `sourceRangesOfText` maps a word-level highlight back
 * onto the source by addition, `decorateText` enters a text node only while
 * its span and its value agree character for character, and `offsetAt` turns a
 * reviewer's line/column selection into an offset. Parsing and rendering the
 * *result* breaks all three at once — a key can be normalised, the order
 * reshuffled, `~` spelled `null` — so what comes out of here is only ever a
 * verbatim slice of the source. That is also what lets an annotation anchor on
 * one key or one value, and what lets the page's own search find them.
 *
 * The price, stated where a reader will look for it: a `meta:` with indented
 * children lands whole in one value cell, because a continuation line has
 * nothing but its indentation to say it is one. `white-space: pre-wrap` on the
 * cell keeps that readable; expanding a nested map into rows of its own needs
 * real YAML semantics and is not this card's.
 */
export function frontmatterFields(
  source: string,
  block: { start: { line: number }; end: { line: number } },
  sep: string,
): FrontmatterField[] {
  const starts = lineStartsOf(source);
  const fields: FrontmatterField[] = [];
  // Between the two fences: the opening one is the block's first line, the
  // closing one its last.
  for (let line = block.start.line + 1; line <= block.end.line - 1; line++) {
    const from = starts[line - 1];
    if (from === undefined) continue;
    const next = starts[line];
    const to = next === undefined ? source.length : next - 1;
    const text = source.slice(from, to);
    const at = text.indexOf(sep);
    // A key is one unindented token, so what stands before the FIRST separator
    // decides: `url: https://x.test/a:b` is one field whose value keeps the
    // second colon, while `two words: three` is prose continuing the field
    // above. The padding TOML writes around `=` is not part of the token —
    // testing the trimmed candidate is what lets `name = "bot-one"` open a
    // field, which is how TOML is ordinarily spelled. Leading indentation
    // survives the trim, which is what makes an indented line a continuation.
    const key = at < 0 ? "" : text.slice(0, at).trimEnd();
    const opens = at >= 0 && !/\s/.test(key);
    const last = fields.at(-1);
    if (!opens) {
      if (last === undefined) {
        fields.push({
          key: null,
          value: { start: from, end: to },
          line,
          endLine: line,
        });
        continue;
      }
      last.value.end = to;
      last.endLine = line;
      continue;
    }
    let value = from + at + sep.length;
    while (value < to && (source[value] === " " || source[value] === "\t")) {
      value++;
    }
    fields.push({
      // The trimmed token, so the padding around a TOML `=` belongs to neither
      // cell — the same way the `|` between two table cells belongs to neither.
      key: { start: from, end: from + key.length },
      value: { start: value, end: to },
      line,
      endLine: line,
    });
  }
  return fields;
}

/**
 * A position for a generated node. Only the offsets are load-bearing — every
 * consumer reads those, and `lineColAt` derives line and column off the source
 * — so the columns are left at the line's start rather than invented.
 */
function spanOf(
  range: { start: number; end: number },
  line: number,
  endLine: number,
): Position {
  return {
    start: { line, column: 1, offset: range.start },
    end: { line: endLine, column: 1, offset: range.end },
  };
}

/**
 * One cell, holding its slice of the source twice over.
 *
 * The mdast `text` child is what `buildSegmentIndex` reads, and `hChildren` is
 * what gets rendered — because the two doors do not agree. `mdast-util-to-hast`
 * runs every mdast `text` node through `trimLines`, which strips the leading
 * indentation off each line of a value: the nested map that `white-space:
 * pre-wrap` exists to keep readable would arrive on the page already flattened,
 * and the rendered text would stop being a slice of the source, which is the
 * invariant the whole decoration chain stands on. `hChildren` is handed to hast
 * verbatim. Both are cut from the same `slice`, so they cannot drift apart.
 */
function cellOf<Type extends "frontmatterKey" | "frontmatterValue">(
  type: Type,
  tagName: "th" | "td",
  source: string,
  range: { start: number; end: number },
  line: number,
  endLine: number,
): { type: Type; data: HastData; children: Text[]; position: Position } {
  const position = spanOf(range, line, endLine);
  const value = source.slice(range.start, range.end);
  // An empty range sends no child at all: there is nothing to slice, and a
  // childless cell is what leaves it group-less in the index — abstaining
  // rather than claiming to hold prose it does not have.
  const children: Text[] =
    value === "" ? [] : [{ type: "text", value, position }];
  return {
    type,
    data: {
      hName: tagName,
      hChildren: children.map((child) => ({ ...child })),
    },
    children,
    position,
  };
}

const keyCell = (
  source: string,
  range: { start: number; end: number },
  line: number,
): FrontmatterKey => cellOf("frontmatterKey", "th", source, range, line, line);

const valueCell = (
  source: string,
  range: { start: number; end: number },
  line: number,
  endLine: number,
): FrontmatterValue =>
  cellOf("frontmatterValue", "td", source, range, line, endLine);

/** The subtree one frontmatter block becomes. */
function tableOf(
  source: string,
  block: Position,
  fields: FrontmatterField[],
): Frontmatter {
  const rows = fields.map(
    (field): FrontmatterFieldNode => ({
      type: "frontmatterField",
      data: { hName: "tr" } satisfies HastData,
      children: [
        // Both cells always, even where the key is null: `tableOf` in
        // spec-source-index takes a table's width from its first row, so a
        // keyless field leading the block would narrow the whole frontmatter
        // to one column and drop every value out of the diff. The CSS gives
        // the row whose key cell is empty its full width back.
        keyCell(
          source,
          field.key ?? { start: field.value.start, end: field.value.start },
          field.line,
        ),
        valueCell(source, field.value, field.line, field.endLine),
      ],
      position: spanOf(
        { start: field.key?.start ?? field.value.start, end: field.value.end },
        field.line,
        field.endLine,
      ),
    }),
  );
  const first = fields[0];
  const last = fields.at(-1);
  const body: FrontmatterBody = {
    type: "frontmatterBody",
    data: { hName: "tbody" } satisfies HastData,
    children: rows,
    position: spanOf(
      {
        start:
          first?.key?.start ?? first?.value.start ?? block.start.offset ?? 0,
        end: last?.value.end ?? block.end.offset ?? 0,
      },
      first?.line ?? block.start.line,
      last?.endLine ?? block.end.line,
    ),
  };
  return {
    type: "frontmatter",
    data: {
      hName: "table",
      hProperties: { className: ["markdown-frontmatter"] },
    } satisfies HastData,
    children: [body],
    // The whole block, both fences included: that is the range a wholly-new
    // frontmatter is highlighted over, and the source a removed one is quoted
    // from.
    position: block,
  };
}

/**
 * remark plugin: swap each `yaml` / `toml` node for a two-column table of its
 * fields (T-240). It consumes what `remark-frontmatter` produces, so it has to
 * run after it.
 *
 * A table-shaped subtree rather than a bespoke one, because the compare engine
 * already reads that shape: `spec-source-index` knows `table` / `tableRow` /
 * `tableCell`, `table-align` already pairs rows by their leftmost cell, and
 * `rehype-decorations` already splices a removed row back where it stood.
 * Frontmatter is a two-column table whose keys are the row keys, so nothing
 * new has to be taught — the data is laid out at an entrance that exists.
 *
 * Custom node types plus `data.hName`, not real mdast `table` nodes: the
 * `table` handler in `mdast-util-to-hast` makes row 0 a `<thead>` header, and
 * frontmatter has no header — the first field would be drawn as one. `hName`
 * renames an element after that handler has run and cannot undo what it did,
 * so the unknown-node route is the only one that controls the output exactly.
 * It also puts the `<tbody>` there explicitly, which is what keeps
 * `applyOverlay` from appending a removed field's stand-in row to the end of
 * the table instead of into its body.
 */
export const remarkFrontmatterTable: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  const children: RootContent[] = [];
  for (const child of tree.children) {
    const sep = SEPARATOR[child.type];
    if (sep === undefined || child.position === undefined) {
      children.push(child);
      continue;
    }
    const fields = frontmatterFields(source, child.position, sep);
    // Nothing between the fences: the node goes, and with it the two `<hr>`s
    // that used to stand in for it.
    if (fields.length === 0) continue;
    children.push(tableOf(source, child.position, fields));
  }
  tree.children = children;
};
