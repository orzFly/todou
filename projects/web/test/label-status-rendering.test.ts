import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PICKER_ROW } from "../src/components/issue/picker-row.ts";

// Anchored on the package directory vitest runs from, not on
// `import.meta.url`: under this setup that is not a `file:` URL.
const SRC = resolve(process.cwd(), "src");

/**
 * A label has one drawing and a status has one drawing (T-715). Twice before,
 * a component was shared but a second way of using it was not ruled out, and
 * the sidebar and the timeline ended up drawing the same label differently.
 *
 * The components themselves take no styling props, so choosing another look
 * through them fails `pnpm typecheck`; the label and status completion pools
 * are typed to carry the entity for the same reason. This test covers what
 * the type checker cannot: drawing one by hand, around the components.
 *
 * Blind spots, stated so nobody mistakes this for a proof:
 * - Only `.tsx` under `src/` is read. A `.ts` helper that returns a style
 *   object built from a colour is not seen.
 * - A name is recognised by the variable holding it (`status`, `s`, `label`,
 *   `l`, `from`, `to`, anything ending in `Status` or `Label`). A status held
 *   in `x` and printed as `{x.name}` is not seen.
 * - A drawing that never reads `.color` and never prints a name — a label
 *   rendered from a hard-coded string — is not seen.
 * - Comments are not stripped, so a comment mentioning `status.color` counts
 *   as a read. That errs loud.
 */

/** The files that own a drawing. Everything they do is the drawing. */
const OWNERS = new Set([
  "components/issue/label-chip.tsx",
  "components/issue/status-pill.tsx",
]);

/**
 * Reads of `.color` that are not drawing a label or a status, with how many
 * each file holds. Exact counts: a new read beside an old one fails, and so
 * does an exception that no longer exists, so this list cannot rot.
 */
const COLOR_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  "components/insights/status-flow-chart.tsx": {
    count: 2,
    reason: "a status is a series in a chart, coloured as its fill",
  },
  "components/insights/chart-frame.tsx": {
    count: 1,
    reason: "a chart legend's swatch, whatever the series is",
  },
  "components/shared/issue-link.tsx": {
    count: 2,
    reason: "the open/closed glyph of a reference draws the issue, tinted",
  },
  "pages/project-settings.tsx": {
    count: 2,
    reason: "the label editor's draft edits a colour",
  },
  "components/settings/statuses-section.tsx": {
    count: 11,
    reason:
      "the status editor's draft edits a colour, and hands it to StatusPill " +
      "as the open row's preview",
  },
};

/** Uses of the prefix split outside the drawing, with the same exact counts. */
const SPLIT_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  "components/issue/label-picker.tsx": {
    count: 2,
    reason: "offering `prefix:` + typed text as names to create",
  },
};

const NAME_HOLDER = /^(s|l|st|lbl|from|to|status|label|\w+Status|\w+Label)$/;

type Hit = { file: string; line: number; text: string };

function hits(file: string, source: string, pattern: RegExp): Hit[] {
  const out: Hit[] = [];
  source.split("\n").forEach((text, i) => {
    for (const _ of text.matchAll(pattern)) {
      out.push({ file, line: i + 1, text: text.trim() });
    }
  });
  return out;
}

function colorReads(file: string, source: string): Hit[] {
  return hits(file, source, /\b[A-Za-z_$][\w$]*\??\.color\b/g);
}

/**
 * `{status.name}` as a JSX child — not `name={status.name}`, which hands the
 * name to a prop, and not `${status.name}` inside a string.
 */
function namesAsText(file: string, source: string): Hit[] {
  const out: Hit[] = [];
  source.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(
      /(?<![=$])\{\s*(?:[\w$]+\??\.)*([\w$]+)\??\.name\s*\}/g,
    )) {
      if (NAME_HOLDER.test(m[1] as string)) {
        out.push({ file, line: i + 1, text: text.trim() });
      }
    }
  });
  return out;
}

function prefixSplits(file: string, source: string): Hit[] {
  return hits(file, source, /\b(splitLabelName|groupLabelsByPrefix)\b/g);
}

/**
 * The props each owner component may take: the entity, plus behaviour that
 * changes no pixel of the label itself. A `valueOnly`, `bordered` or
 * `className` is a second drawing waiting for a caller.
 */
const ALLOWED_PROPS: Record<string, string[]> = {
  LabelChip: ["label"],
  LabelChips: ["labels", "onRemove"],
  StatusPill: ["status"],
  // The dot's cell doubles as a board column's or list group's select-all
  // box (T-732, T-768).
  StatusHeading: ["status", "select"],
};

function extraProps(file: string, source: string): Hit[] {
  const out: Hit[] = [];
  for (const m of source.matchAll(/export function (\w+)\(\{([^}]*)\}/g)) {
    const allowed = ALLOWED_PROPS[m[1] as string] ?? [];
    const props = (m[2] as string)
      .split(",")
      .map((p) => p.split("=")[0]?.trim() ?? "")
      .filter((p) => p !== "");
    if (props.some((p) => !allowed.includes(p))) {
      const line = source.slice(0, m.index).split("\n").length;
      out.push({ file, line, text: `${m[1]}(${props.join(",").trim()})` });
    }
  }
  return out;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(path));
    else if (entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function sources(): Array<{ file: string; source: string }> {
  return tsxFiles(SRC).map((path) => ({
    file: relative(SRC, path),
    source: readFileSync(path, "utf8"),
  }));
}

function countBy(list: Hit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const hit of list) out[hit.file] = (out[hit.file] ?? 0) + 1;
  return out;
}

const expectedCounts = (exceptions: Record<string, { count: number }>) =>
  Object.fromEntries(Object.entries(exceptions).map(([f, e]) => [f, e.count]));

// Each fixture is a drawing this codebase actually had before T-715, kept
// verbatim, so the scanner is shown to catch the thing it exists for.
const BEFORE = {
  filterBarStatus: `            <>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {s.name}
            </>`,
  pickerSelectedLabel: `              const { prefix } = splitLabelName(label.name);`,
  listGroupHeader: `            style={{ backgroundColor: status.color }}
          <span className="font-medium">{status.name}</span>`,
  blocksClearAt: `              {status.name} or later`,
  labelChipVariants: `export function LabelChip({
  label,
  valueOnly = false,
  bordered = true,
  truncate = false,
  className,
}: {`,
};

describe("the scanner catches the drawings it exists for", () => {
  it("flags a hand-drawn status dot and name", () => {
    expect(colorReads("x.tsx", BEFORE.filterBarStatus)).toHaveLength(1);
    expect(namesAsText("x.tsx", BEFORE.filterBarStatus)).toHaveLength(1);
    expect(colorReads("x.tsx", BEFORE.listGroupHeader)).toHaveLength(1);
    expect(namesAsText("x.tsx", BEFORE.listGroupHeader)).toHaveLength(1);
  });

  it("flags a status name printed as plain text", () => {
    expect(namesAsText("x.tsx", BEFORE.blocksClearAt)).toHaveLength(1);
    expect(namesAsText("x.tsx", "<b>{row.item.status.name}</b>")).toHaveLength(
      1,
    );
  });

  it("flags a hand-split label prefix", () => {
    expect(prefixSplits("x.tsx", BEFORE.pickerSelectedLabel)).toHaveLength(1);
  });

  it("flags a component that grew a styling prop", () => {
    expect(extraProps("x.tsx", BEFORE.labelChipVariants)).toHaveLength(1);
    expect(
      extraProps("x.tsx", "export function StatusPill({ status }: {"),
    ).toHaveLength(0);
    expect(
      extraProps(
        "x.tsx",
        "export function StatusPill({ status, className }: {",
      ),
    ).toHaveLength(1);
  });

  it("leaves names handed to props and strings alone", () => {
    for (const ok of [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scanner reads
      "aria-label={`delete ${status.name}`}",
      "name={status.name}",
      "<span>{project.name}</span>",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text the scanner reads
      "text: `moved ${from.name} → ${to.name}`,",
    ]) {
      expect(namesAsText("x.tsx", ok)).toEqual([]);
    }
  });
});

describe("labels and statuses are drawn only by their components (T-715)", () => {
  const all = sources();
  const others = all.filter(({ file }) => !OWNERS.has(file));

  it("finds the source tree and both owners", () => {
    // An empty scan agrees with every assertion below.
    expect(all.length).toBeGreaterThan(100);
    for (const owner of OWNERS) {
      expect(all.map((s) => s.file)).toContain(owner);
    }
  });

  it("reads .color only in the owners and the listed exceptions", () => {
    const found = others.flatMap((s) => colorReads(s.file, s.source));
    expect(countBy(found), JSON.stringify(found, null, 1)).toEqual(
      expectedCounts(COLOR_EXCEPTIONS),
    );
  });

  it("prints no label or status name as bare text", () => {
    expect(others.flatMap((s) => namesAsText(s.file, s.source))).toEqual([]);
  });

  it("splits label prefixes only in the owner and the listed exceptions", () => {
    const found = others.flatMap((s) => prefixSplits(s.file, s.source));
    expect(countBy(found), JSON.stringify(found, null, 1)).toEqual(
      expectedCounts(SPLIT_EXCEPTIONS),
    );
  });

  it("gives the owner components no styling props", () => {
    const owners = all.filter(({ file }) => OWNERS.has(file));
    expect(owners.flatMap((s) => extraProps(s.file, s.source))).toEqual([]);
    // The four entry points, so a fifth is a decision rather than a drift.
    const exported = owners.flatMap((s) =>
      [...s.source.matchAll(/export function (\w+)/g)].map((m) => m[1]),
    );
    expect(exported.sort()).toEqual([
      "LabelChip",
      "LabelChips",
      "StatusHeading",
      "StatusPill",
    ]);
  });
});

/**
 * A status is offered for choice in one way, at one row height (T-739). The
 * new-issue page once picked its status from a `Select` of its own, whose
 * rows were 4px shorter than the card page's `StatusMenu`; the user chose the
 * shorter row, which `PICKER_ROW` now is, and every status row is held to it.
 *
 * Blind spots, stated so nobody mistakes this for a proof:
 * - A picker is a `.tsx` that draws a `StatusPill` and holds a row. A status
 *   held in some other element than a pill — a bare `<option>` — is not seen,
 *   though the T-715 scan above flags its name printed as text.
 * - Rows are told apart from other tags by name, by `role="option"`, or by
 *   spreading the search box's `QueryBox` row props (`{...option}`). A
 *   hand-built `<div onClick>` list is not a row to this scan.
 * - In the search box a row's height is `QueryBox`'s, not `PICKER_ROW`: its
 *   rows pad 6px where the pickers pad 4px. What holds a status row there to
 *   30px is the pill pulled into the pad by `IN_ROW`, which is asserted by
 *   text, not measured; `IN_ROW` changed to some other pull is not seen.
 * - A row is recognised as narrow by naming `PICKER_ROW` in its opening tag.
 *   A class placed after it in `cn()` that overrides the height is not seen;
 *   `picker-row-geometry.test.tsx` covers that for the rendered pickers.
 * - Counted per file, not per row: the filter bar's sort rows may skip
 *   `PICKER_ROW`, so a wide status row added there goes unseen only if a
 *   sort row is removed in the same change.
 */

/** Opening tags that are a row of a menu, a select or a listbox. */
const ROW_TAG =
  /^(SelectItem|DropdownMenuItem|DropdownMenuCheckboxItem|DropdownMenuRadioItem|CommandItem)$/;

/**
 * Every opening JSX tag in a source, as text, with its line. Braces are
 * counted so that an arrow function in a handler does not end the tag.
 */
function openingTags(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  for (const m of source.matchAll(/<([A-Za-z][\w.]*)\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = (m.index as number) + m[0].length; i < source.length; i++) {
      const c = source[i] as string;
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "`" || (depth > 0 && c === "'")) {
        quote = c;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    out.push({
      line: source.slice(0, m.index).split("\n").length,
      text: `${m[1]} ${source.slice((m.index as number) + m[0].length, end)}`,
    });
  }
  return out;
}

function rows(file: string, source: string): Hit[] {
  return openingTags(source)
    .filter(
      ({ text }) =>
        ROW_TAG.test(text.split(" ")[0] as string) ||
        /role="option"|\.\.\.optionProps\(|\{\.\.\.option\}/.test(text),
    )
    .map(({ line, text }) => ({ file, line, text: text.trim() }));
}

/**
 * A row is narrow if its opening tag names `PICKER_ROW`, or is one of the
 * search box's `QueryBox` rows, whose pills and chips `IN_ROW` holds to the
 * same 30px — asserted below rather than trusted.
 */
const narrow = (row: Hit) => /PICKER_ROW|\{\.\.\.option\}/.test(row.text);

const isStatusPicker = (file: string, source: string) =>
  /<StatusPill\b/.test(source) && rows(file, source).length > 0;

/** The pickers that offer a status. A sixth is a decision, not a drift. */
const STATUS_PICKERS = [
  "components/issue/bulk-status-menu.tsx",
  "components/issue/filter-bar.tsx",
  "components/issue/ref-picker.tsx",
  "components/issue/status-menu.tsx",
  "components/search-box.tsx",
];

/** Rows in a status picker that hold no status, with exact counts. */
const WIDE_ROW_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  "components/issue/filter-bar.tsx": {
    count: 6,
    reason:
      "the sort order's five `SelectItem`s and the disabled `None defined` " +
      "row hold no status",
  },
};

// Verbatim from before T-739, as the T-715 fixtures above are.
const BEFORE_T739 = {
  newIssueSelect: `                <Select value={statusId} onValueChange={setStatusId}>
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={defaultStatus?.name ?? "Status"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.data.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        <StatusPill status={s} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>`,
  searchOption: `const OPTION = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm";`,
};

describe("the T-739 scanner catches the drawings it exists for", () => {
  it("flags the new-issue page's own status select", () => {
    expect(isStatusPicker("x.tsx", BEFORE_T739.newIssueSelect)).toBe(true);
    const found = rows("x.tsx", BEFORE_T739.newIssueSelect);
    expect(found).toHaveLength(1);
    expect(found.filter((r) => !narrow(r))).toHaveLength(1);
  });

  it("flags a status row that left PICKER_ROW out", () => {
    const found = rows(
      "x.tsx",
      `<DropdownMenuItem key={s.id} className="cursor-pointer" onSelect={() => onStatus(s)}>`,
    );
    expect(found).toHaveLength(1);
    expect(narrow(found[0] as Hit)).toBe(false);
  });

  it("does not end a row's tag at an arrow function", () => {
    const [row] = rows(
      "x.tsx",
      `<DropdownMenuItem onSelect={() => go()} className={cn(PICKER_ROW)}>`,
    );
    expect(row && narrow(row)).toBe(true);
  });

  it("flags a header search option not built from PICKER_ROW", () => {
    expect(BEFORE_T739.searchOption).not.toMatch(
      /const OPTION = cn\([^)]*PICKER_ROW/,
    );
  });
});

describe("one status picker, one row height (T-739)", () => {
  const all = sources();

  it("offers a status only through the listed pickers", () => {
    expect(
      all.filter((s) => isStatusPicker(s.file, s.source)).map((s) => s.file),
    ).toEqual(STATUS_PICKERS);
  });

  it("holds every row of a status picker to PICKER_ROW", () => {
    const found = all
      .filter((s) => STATUS_PICKERS.includes(s.file))
      .flatMap((s) => rows(s.file, s.source).filter((r) => !narrow(r)));
    expect(countBy(found), JSON.stringify(found, null, 1)).toEqual(
      expectedCounts(WIDE_ROW_EXCEPTIONS),
    );
    // A 22px pill pulled 2px into each of the box's 6px pads makes a 30px
    // row, and every pill and chip the box draws sits in that pull.
    const search = all.find((s) => s.file === "components/search-box.tsx");
    const source = search?.source ?? "";
    expect(source).toMatch(/const IN_ROW = "-my-0\.5 /);
    const drawn = source.match(/<(StatusPill|LabelChip)\b/g) ?? [];
    const pulled =
      source.match(
        /<span className=\{IN_ROW\}>\s*<(StatusPill|LabelChip)\b/g,
      ) ?? [];
    expect(drawn.length).toBeGreaterThan(0);
    expect(pulled).toHaveLength(drawn.length);
  });

  it("keeps PICKER_ROW the narrow row the user chose", () => {
    // 30px: a 22px pill with 4px above and below. The 34px row the card page
    // had is the one T-739 retired.
    expect(PICKER_ROW.split(" ")).toEqual(
      expect.arrayContaining(["min-h-7.5", "py-1"]),
    );
    expect(
      all.flatMap((s) => hits(s.file, s.source, /\bmin-h-8\.5\b/g)),
    ).toEqual([]);
  });

  it("holds the editor's status, label and person rows to the same 30px", () => {
    // CodeMirror's panel cannot take a class string, so its theme spells the
    // row out; this pins the spelling to PICKER_ROW's height.
    const theme = readFileSync(
      join(SRC, "lib/editor/ref-completion.ts"),
      "utf8",
    );
    for (const row of ["cm-completion-face", "cm-completion-user"]) {
      const block = theme.match(new RegExp(`li\\.${row}": \\{([^}]*)\\}`))?.[1];
      expect(block, row).toMatch(/minHeight: "1\.875rem"/);
      expect(block, row).toMatch(/padding: "0\.25rem 0\.5rem"/);
    }
  });
});
