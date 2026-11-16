import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    count: 4,
    reason: "colour pickers and their mutation payloads edit a colour",
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
 * Each owner exports components that destructure exactly one prop: the
 * entity. A `valueOnly`, `bordered` or `className` is a second drawing
 * waiting for a caller.
 */
function extraProps(file: string, source: string): Hit[] {
  const out: Hit[] = [];
  for (const m of source.matchAll(/export function (\w+)\(\{([^}]*)\}/g)) {
    const props = (m[2] as string).split(",").filter((p) => p.trim() !== "");
    if (props.length !== 1) {
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

  it("flags a component that grew a second prop", () => {
    expect(extraProps("x.tsx", BEFORE.labelChipVariants)).toHaveLength(1);
    expect(
      extraProps("x.tsx", "export function StatusPill({ status }: {"),
    ).toHaveLength(0);
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

  it("gives every owner component exactly one prop", () => {
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
