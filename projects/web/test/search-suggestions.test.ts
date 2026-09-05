import { parseSearchQuery } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type CompletionRow,
  hasQualifier,
  orderRows,
  qualifierKeySource,
  qualifierValueSource,
  type SuggestionContext,
  type ValuePools,
} from "../src/components/search/suggestions.ts";

const POOLS: ValuePools = {
  label: [{ value: "area:web" }, { value: "kind:bug" }],
  status: [{ value: "Todo" }, { value: "In Progress" }],
  assignee: [{ value: "alice" }],
  harness: [{ value: "codex", hint: "12" }, { value: "claude-code" }],
  session: [{ value: "sess-a", hint: "codex" }],
};

/** `query` with `|` marking the caret. */
function at(marked: string): SuggestionContext {
  const caret = marked.indexOf("|");
  const query = marked.replace("|", "");
  return { slug: "todou", query, caret, parts: parseSearchQuery(query) };
}

const keys = (marked: string) => qualifierKeySource(at(marked));
const values = (marked: string) => qualifierValueSource(POOLS)(at(marked));

describe("the qualifier key source", () => {
  it("matches a non-empty prefix of a key", () => {
    const { matched, rows } = keys("har|");
    expect(matched).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["harness:"]);
    expect(rows[0]?.apply).toEqual({ value: "harness:", caret: 8 });
  });

  it("lists every key after a space, but does not call it a match", () => {
    // The full table is how the syntax is discovered; it just waits below
    // the search row so Enter cannot trip over it.
    const { matched, rows } = keys("部署 |");
    expect(matched).toBe(false);
    expect(rows).toHaveLength(7);
  });

  it("offers nothing for a word that prefixes no key", () => {
    expect(keys("部署|")).toEqual({ matched: false, rows: [] });
  });

  it("keeps a leading minus when it completes", () => {
    const { matched, rows } = keys("-lab|");
    expect(matched).toBe(true);
    expect(rows[0]?.apply).toEqual({ value: "-label:", caret: 7 });
  });

  it("stays out of a filter and out of quotes", () => {
    expect(keys("harness:cod|").rows).toEqual([]);
    expect(keys('"har|').rows).toEqual([]);
  });

  it("completes the word the caret is in, not the whole query", () => {
    const { rows } = keys("部署 sta|");
    expect(rows.map((r) => r.text)).toEqual(["state:", "status:"]);
    expect(rows[0]?.apply).toEqual({ value: "部署 state:", caret: 9 });
  });

  it("leaves the caret on the colon, with no space after it", () => {
    // Only a *value* ends a word (T-268). A key is followed immediately by
    // its value, and so is any other mid-word completion — a prefix offered
    // as `ACC-` is there to have `1` typed onto it.
    const { rows } = keys("har|");
    expect(rows[0]?.apply).toEqual({ value: "harness:", caret: 8 });
  });

  it("says in one line what a key takes", () => {
    const { rows } = keys("harn|");
    expect(rows[0]?.hint).toBe("which agent wrote it");
    for (const row of rows) expect(row.hint ?? "").not.toContain("\n");
  });
});

describe("the qualifier value source", () => {
  it("matches as soon as the colon is there, even with nothing typed", () => {
    const { matched, rows } = values("label:|");
    expect(matched).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["area:web", "kind:bug"]);
  });

  it("narrows to what has been typed, case-insensitively", () => {
    expect(values("status:in|").rows.map((r) => r.text)).toEqual([
      '"In Progress"',
    ]);
    expect(values("label:AREA|").rows.map((r) => r.text)).toEqual(["area:web"]);
  });

  it("quotes a value that would not read back as one", () => {
    const { rows } = values("status:In|");
    const row = rows.find((r) => r.text.includes("Progress")) as CompletionRow;
    expect(row.text).toBe('"In Progress"');
    expect(row.apply).toEqual({ value: 'status:"In Progress" ', caret: 21 });
  });

  it("ends the word, so the next one can just be typed", () => {
    const { rows } = values("label:kin|");
    expect(rows[0]?.apply).toEqual({ value: "label:kind:bug ", caret: 15 });
  });

  it("does not stack a second space on one that is already there", () => {
    const { rows } = values("label:kin| 部署");
    // The caret still steps past the space: taking an offer leaves the reader
    // at the start of the next word either way.
    expect(rows[0]?.apply).toEqual({ value: "label:kind:bug 部署", caret: 15 });
  });

  it("offers a closed set without asking the project", () => {
    expect(values("is:|").rows.map((r) => r.text)).toEqual([
      "body",
      "comment",
      "spec",
    ]);
    expect(values("state:|").rows.map((r) => r.text)).toEqual([
      "open",
      "closed",
    ]);
  });

  it("puts the values that stand for themselves in the same list", () => {
    expect(values("harness:|").rows.map((r) => r.text)).toEqual([
      "none",
      "codex",
      "claude-code",
    ]);
    expect(values("assignee:|").rows.map((r) => r.text)).toContain("@me");
  });

  it("replaces only the value under the caret", () => {
    const { rows } = values("label:area:web,kind|");
    const row = rows[0] as CompletionRow;
    expect(row.apply.value).toBe("label:area:web,kind:bug ");
  });

  it("offers nothing where no value goes", () => {
    expect(values("部署|")).toEqual({ matched: false, rows: [] });
    expect(values("label:a |")).toEqual({ matched: false, rows: [] });
  });
});

describe("row order", () => {
  const row = (key: string) => ({ key }) as { key: string };
  const search = row("search");

  it("puts search first until something is really being completed", () => {
    expect(
      orderRows(
        [
          { matched: false, rows: [row("a"), row("b")] },
          { matched: false, rows: [row("c")] },
        ],
        search,
      ).map((r) => r.key),
    ).toEqual(["search", "a", "b", "c"]);
  });

  it("lifts a matching source above it, and only that source", () => {
    expect(
      orderRows(
        [
          { matched: false, rows: [row("a")] },
          { matched: true, rows: [row("b")] },
        ],
        search,
      ).map((r) => r.key),
    ).toEqual(["b", "search", "a"]);
  });

  const many = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));

  it("stops at ten, however much a source has to say", () => {
    // A project with forty labels used to open a panel taller than the
    // window, which then gave the page its own scrollbar (T-268).
    const rows = orderRows([{ matched: true, rows: many("m", 40) }], search);
    expect(rows).toHaveLength(11);
    expect(rows.at(-1)).toBe(search);
  });

  it("spends what the matched rows left on the ones below", () => {
    const rows = orderRows(
      [
        { matched: true, rows: many("m", 3) },
        { matched: false, rows: many("u", 20) },
      ],
      search,
    ).map((r) => r.key);
    expect(rows).toHaveLength(11);
    expect(rows.slice(0, 4)).toEqual(["m0", "m1", "m2", "search"]);
    expect(rows.slice(4)).toEqual(many("u", 7).map((r) => r.key));
  });

  it("gives the whole budget to the rows below when nothing matched", () => {
    const rows = orderRows([{ matched: false, rows: many("u", 40) }], search);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toBe(search);
  });
});

describe("hasQualifier", () => {
  it("is what keeps a jump from dropping half the query", () => {
    // `label:bug T-141` offering a jump that forgets the label is a lie
    // about where the reader is going.
    expect(hasQualifier(parseSearchQuery("T-141"))).toBe(false);
    expect(hasQualifier(parseSearchQuery("label:bug T-141"))).toBe(true);
  });
});
