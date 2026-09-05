import type { SearchPart, SearchQualifier } from "@todou/shared";
import { SEARCH_QUALIFIERS } from "@todou/shared";

export type SuggestionContext = {
  slug: string;
  query: string;
  caret: number;
  parts: SearchPart[];
};

/**
 * One offered completion. A single line: an icon, the syntax in a monospace
 * run, and at most a very short grey note beside it — never a second line of
 * description. The dropdown is something to glance at mid-keystroke.
 */
export type CompletionRow = {
  key: string;
  /** The syntax itself, e.g. `harness:` or `area:web`. */
  text: string;
  /** A few words at most, on the same line. */
  hint?: string;
  icon: "qualifier" | "value" | "project";
  /** The whole query after accepting this, and where the caret lands. */
  apply: { value: string; caret: number };
};

/**
 * What one source offers, and whether the caret is actually on something it
 * recognises. `matched` is the whole ordering rule: a source that only
 * *could* be useful stays below the search row.
 */
export type SourceResult<Row> = { matched: boolean; rows: Row[] };

export type SuggestionSource = (
  ctx: SuggestionContext,
) => SourceResult<CompletionRow>;

/**
 * The offered rows, in order: **the search row is first** unless something is
 * genuinely being completed.
 *
 * The reader is typing a search query, not filling in a form. Putting a
 * completion above the search row means Enter submits something they did not
 * ask for, and the only evidence that they wanted one is that what they typed
 * actually prefixes something. Everything else — the full list of keys after
 * a space, say — is still shown, because that is how the syntax is
 * discovered, but it waits below.
 *
 * `limit` is spent here rather than inside each source, so that a source
 * added later lands in the same budget without having to remember one. The
 * matched rows spend it first — they are what the reader is completing — the
 * search row is never spent, and whatever is left goes to the rest.
 */
export function orderRows<Row>(
  results: Array<SourceResult<Row>>,
  search: Row,
  limit = 10,
): Row[] {
  const matched = results
    .filter((r) => r.matched)
    .flatMap((r) => r.rows)
    .slice(0, limit);
  const rest = results.filter((r) => !r.matched).flatMap((r) => r.rows);
  return [...matched, search, ...rest.slice(0, limit - matched.length)];
}

const EMPTY: SourceResult<CompletionRow> = { matched: false, rows: [] };

/**
 * The bare word the caret stands in, or an empty one where it stands. Null
 * where a key cannot go at all: inside a filter, which already has one, and
 * inside quotes, which is how one asks for a literal.
 */
export function textAt(
  ctx: SuggestionContext,
): { start: number; text: string } | null {
  for (const part of ctx.parts) {
    if (ctx.caret < part.start || ctx.caret > part.end) continue;
    if (part.kind === "filter") return null;
    if (part.kind === "text") {
      if (part.raw.startsWith('"')) return null;
      return {
        start: part.start,
        text: ctx.query.slice(part.start, ctx.caret),
      };
    }
  }
  return { start: ctx.caret, text: "" };
}

/** Splice `text` over `[start, end)` and put the caret after it. */
function splice(
  query: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  return {
    value: query.slice(0, start) + text + query.slice(end),
    caret: start + text.length,
  };
}

/**
 * Splice, and leave the caret past a space, so that taking an offer ends a
 * word rather than parking the caret against the next one.
 *
 * Only values do this. A key is completed to its colon and the value comes
 * next with nothing in between, so a space there would have to be deleted
 * again — and a prefix completed to `ACC-` is mid-word by construction.
 *
 * The cost, taken deliberately: `label:` reads a comma-separated list, and
 * closing it after one value means a second one needs a backspace. That is
 * the rare path; ending a word is every time.
 */
function spliceThenSpace(
  query: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const spliced = splice(query, start, end, text);
  const after = spliced.value.slice(spliced.caret);
  return {
    value: /^\s/.test(after)
      ? spliced.value
      : `${spliced.value.slice(0, spliced.caret)} ${after}`,
    caret: spliced.caret + 1,
  };
}

const KEYS = Object.keys(SEARCH_QUALIFIERS) as SearchQualifier[];

/** A one-line reminder of what a key takes, short enough to sit inline. */
const KEY_HINT: Record<SearchQualifier, string> = {
  is: "body, comment or spec",
  state: "open or closed",
  status: "a status name",
  label: "a label name",
  assignee: "a login, or @me",
  harness: "which agent wrote it",
  session: "which session wrote it",
};

/**
 * Keys, offered against the word the caret is in. Only a non-empty prefix of
 * a real key counts as a match; a bare space lists them all, below search.
 */
export const qualifierKeySource: SuggestionSource = (ctx) => {
  const token = textAt(ctx);
  if (token === null) return EMPTY;
  const negated = token.text.startsWith("-");
  const typed = (negated ? token.text.slice(1) : token.text).toLowerCase();
  if (typed.includes(":")) return EMPTY;
  const keys = KEYS.filter((k) => k.startsWith(typed));
  return {
    matched: typed !== "" && keys.length > 0,
    rows: keys.map((key) => ({
      key: `qualifier:${key}`,
      text: `${negated ? "-" : ""}${key}:`,
      hint: KEY_HINT[key],
      icon: "qualifier" as const,
      apply: splice(
        ctx.query,
        token.start,
        token.start + token.text.length,
        `${negated ? "-" : ""}${key}:`,
      ),
    })),
  };
};

/** One offerable value of a key, and the short note that goes beside it. */
export type ValueOption = { value: string; hint?: string };
export type ValuePools = Partial<Record<SearchQualifier, ValueOption[]>>;

/** A value needs quoting exactly when it would not survive being read back. */
export function quoteValue(value: string): string {
  return /[\s,"]/.test(value) ? `"${value.replaceAll('"', "")}"` : value;
}

/**
 * The closed-set values, which need no project to answer. `@me` and `none`
 * come from the registry rather than a second list.
 */
function builtinValues(key: SearchQualifier): ValueOption[] {
  const spec = SEARCH_QUALIFIERS[key];
  return [
    ...spec.values.map((value) => ({ value })),
    ...spec.special.map((value) => ({ value })),
  ];
}

/**
 * Values, offered whenever the caret stands where one goes. The colon is
 * already typed by then, so the intent is not in doubt and this always counts
 * as a match — including on an empty value, where the whole list is what the
 * reader is asking for.
 */
export function qualifierValueSource(pools: ValuePools): SuggestionSource {
  return (ctx) => {
    for (const part of ctx.parts) {
      if (part.kind !== "filter") continue;
      const valuesFrom = part.keyEnd + 1;
      if (ctx.caret < valuesFrom || ctx.caret > part.end) continue;

      // The value the caret is inside, or the empty one it is sitting at.
      const on = part.values.find(
        (v) => ctx.caret >= v.start && ctx.caret <= v.end,
      );
      const start = on?.start ?? ctx.caret;
      const end = on?.end ?? ctx.caret;
      const typed = (on === undefined ? "" : on.value).toLowerCase();

      const offered = [...builtinValues(part.key), ...(pools[part.key] ?? [])];
      const rows = offered
        .filter((o) => o.value.toLowerCase().startsWith(typed))
        .map((o) => ({
          key: `value:${part.key}:${o.value}`,
          text: quoteValue(o.value),
          ...(o.hint === undefined ? {} : { hint: o.hint }),
          icon: "value" as const,
          apply: spliceThenSpace(ctx.query, start, end, quoteValue(o.value)),
        }));
      return { matched: true, rows };
    }
    return EMPTY;
  };
}

/** A project in the completion pool, with its equivalent spellings ranked. */
export type ProjectRefOption = {
  slug: string;
  /** The project's name, the short grey note at the end of the line. */
  name: string;
  /**
   * Insertable spellings, best first: `["ACC-", "accel/"]` where there is a
   * prefix, `["homelab/"]` where there is not.
   */
  spellings: string[];
};

/**
 * Projects, offered against the bare word the caret is in and matched
 * case-insensitively — which is the point: `ac` has to reach `ACC-` and
 * `TOD` has to reach `todou/`, and reaching for shift first is exactly the
 * thing that does not happen mid-query.
 *
 * **One row per project.** The spellings are synonyms, so a second row for
 * the same project buys the reader nothing and costs a line of a panel that
 * only has ten. The best one that matches wins; typing one more character
 * (`acce`, past the prefix) is how the other one is asked for.
 *
 * Nothing is completed to itself: once `ACC-` is typed, offering `ACC-` is
 * an offer to press Tab for no change.
 */
export function projectRefSource(pool: ProjectRefOption[]): SuggestionSource {
  return (ctx) => {
    const token = textAt(ctx);
    if (token === null) return EMPTY;
    const typed = token.text.toLowerCase();
    if (typed === "") return EMPTY;

    const rows: CompletionRow[] = [];
    for (const project of pool) {
      const spelling = project.spellings.find(
        (candidate) =>
          candidate.toLowerCase().startsWith(typed) &&
          candidate.toLowerCase() !== typed,
      );
      if (spelling === undefined) continue;
      rows.push({
        key: `project:${project.slug}`,
        text: spelling,
        hint: project.name,
        icon: "project" as const,
        // No trailing space: a prefix is completed to `ACC-` so that a
        // number can be typed straight onto it (T-268).
        apply: splice(
          ctx.query,
          token.start,
          token.start + token.text.length,
          spelling,
        ),
      });
    }
    return { matched: rows.length > 0, rows };
  };
}

/** Whether the query already carries a qualifier — a jump would drop it. */
export function hasQualifier(parts: SearchPart[]): boolean {
  return parts.some((part) => part.kind === "filter");
}
