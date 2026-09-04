import { describe, expect, it } from "vitest";
import {
  buildSegmentIndex,
  type TableMatrix,
  tableOf,
} from "../src/lib/spec-source-index.ts";
import { alignFrontmatter, alignTable } from "../src/lib/table-align.ts";

/** The matrix of the one table in a fixture. */
function matrix(...lines: string[]): TableMatrix {
  const index = buildSegmentIndex(`${lines.join("\n")}\n`);
  const found = tableOf(
    index,
    index.blocks.findIndex((block) => block.type === "table"),
  );
  if (found === null) throw new Error("the fixture holds no table");
  return found;
}

const T3 = matrix(
  "| 名称 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 行证据 | 纯新增 | A |",
  "| 覆盖证据 | 重写 | B |",
  "| 第三行 | 会被删掉 | C |",
);

describe("alignTable columns (T-221)", () => {
  it("pairs all three when two columns were swapped (K)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 判定 | 渠道 |",
        "| --- | --- | --- |",
        "| 行证据 | A | 纯新增 |",
        "| 覆盖证据 | B | 重写 |",
        "| 第三行 | C | 会被删掉 |",
      ),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 2],
      [2, 1],
    ]);
    expect(result.columns.oldOnly).toEqual([]);
    expect(result.columns.newOnly).toEqual([]);
    // Nothing moved between rows either, so the whole table is unchanged.
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.rows.newOnly).toEqual([]);
  });

  it("keeps the column whose header was renamed (L)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 来源渠道 | 判定 |",
        "| --- | --- | --- |",
        "| 行证据 | 纯新增 | A |",
        "| 覆盖证据 | 重写 | B |",
        "| 第三行 | 会被删掉 | C |",
      ),
    );
    // 名称 and 判定 key on their headers; the one left over is one against
    // one, so it pairs on position and its header reads word by word.
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("loses exactly one column when the middle one goes (D)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 判定 |",
        "| --- | --- |",
        "| 行证据 | A |",
        "| 覆盖证据 | B |",
        "| 第三行 | C |",
      ),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(result.columns.oldOnly).toEqual([1]);
    expect(result.columns.newOnly).toEqual([]);
  });

  it("loses exactly one column when the last one goes (D2)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 渠道 |",
        "| --- | --- |",
        "| 行证据 | 纯新增 |",
        "| 覆盖证据 | 重写 |",
        "| 第三行 | 会被删掉 |",
      ),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.columns.oldOnly).toEqual([2]);
  });

  it("gains exactly one column when one is inserted (J)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 渠道 | 备注 | 判定 |",
        "| --- | --- | --- | --- |",
        "| 行证据 | 纯新增 | 甲 | A |",
        "| 覆盖证据 | 重写 | 乙 | B |",
        "| 第三行 | 会被删掉 | 丙 | C |",
      ),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
    ]);
    expect(result.columns.oldOnly).toEqual([]);
    expect(result.columns.newOnly).toEqual([2]);
  });

  it("pairs a dropped column with an unrelated new one", () => {
    // Recording the behaviour, which is T-211's rule and not a table rule: the
    // headers key two columns, and the single leftover on each side has a
    // unique position, so the position is the evidence. It reads as a rewrite
    // rather than a removal plus an addition.
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 备注 | 判定 |",
        "| --- | --- | --- |",
        "| 行证据 | 甲 | A |",
        "| 覆盖证据 | 乙 | B |",
        "| 第三行 | 丙 | C |",
      ),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(result.columns.oldOnly).toEqual([]);
  });

  it("pairs two columns sharing a header in order of appearance", () => {
    const result = alignTable(
      matrix("| 甲 | 甲 |", "| --- | --- |", "| 一 | 二 |"),
      matrix("| 甲 | 甲 |", "| --- | --- |", "| 壹 | 贰 |"),
    );
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("alignTable rows (T-221)", () => {
  it("pairs rows whose key cell moved, adding and removing nothing", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 渠道 | 判定 |",
        "| --- | --- | --- |",
        "| 第三行 | 会被删掉 | C |",
        "| 行证据 | 纯新增 | A |",
        "| 覆盖证据 | 重写 | B |",
      ),
    );
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 2],
      [2, 3],
      [3, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.rows.newOnly).toEqual([]);
  });

  it("keys on the leftmost surviving column when the first one went", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 渠道 | 判定 |",
        "| --- | --- |",
        "| 纯新增 | A |",
        "| 重写 | B |",
        "| 会被删掉 | C |",
      ),
    );
    expect(result.columns.oldOnly).toEqual([0]);
    // 渠道 is the key now, and every row still finds itself by it.
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
  });

  it("loses one row and keeps the rest (M)", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 判定 |",
        "| --- | --- |",
        "| 行证据 | A |",
        "| 第三行 | C |",
      ),
    );
    expect(result.columns.oldOnly).toEqual([1]);
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [3, 2],
    ]);
    expect(result.rows.oldOnly).toEqual([2]);
  });

  it("gains one row and keeps the rest", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 渠道 | 判定 |",
        "| --- | --- | --- |",
        "| 行证据 | 纯新增 | A |",
        "| 新的一行 | 新渠道 | D |",
        "| 覆盖证据 | 重写 | B |",
        "| 第三行 | 会被删掉 | C |",
      ),
    );
    expect(result.rows.newOnly).toEqual([2]);
    expect(result.rows.oldOnly).toEqual([]);
  });

  it("pairs the one row rewritten end to end", () => {
    const result = alignTable(
      T3,
      matrix(
        "| 名称 | 渠道 | 判定 |",
        "| --- | --- | --- |",
        "| 行证据 | 纯新增 | A |",
        "| 改写的行 | 改写的渠道 | 乙 |",
        "| 第三行 | 会被删掉 | C |",
      ),
    );
    // Two rows key on their names; the leftover is one against one.
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
  });

  it("splits two rows that share nothing with their replacements", () => {
    const result = alignTable(
      matrix(
        "| 名称 | 渠道 |",
        "| --- | --- |",
        "| 行证据 | 纯新增 |",
        "| 甲 | 乙 |",
        "| 丙 | 丁 |",
      ),
      matrix(
        "| 名称 | 渠道 |",
        "| --- | --- |",
        "| 行证据 | 纯新增 |",
        "| 戊 | 己 |",
        "| 庚 | 辛 |",
      ),
    );
    // Two candidates on each side, none of them sharing a word: the position
    // no longer speaks, and the similarity floor refuses both.
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([2, 3]);
    expect(result.rows.newOnly).toEqual([2, 3]);
  });

  it("pairs the header rows of two tables that have nothing else", () => {
    const result = alignTable(
      matrix("| 甲 | 乙 |", "| --- | --- |"),
      matrix("| 甲 | 丙 |", "| --- | --- |"),
    );
    expect(result.rows.pairs).toEqual([[0, 0]]);
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.columns.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("lets a padded cell abstain from being a key without failing its row", () => {
    const result = alignTable(
      matrix(
        "| 名称 | 渠道 |",
        "| --- | --- |",
        "| 行证据 | 纯新增 |",
        "| 第三行 |",
      ),
      matrix("| 渠道 |", "| --- |", "| 纯新增 |", "| 会被删掉 |"),
    );
    // 渠道 is the key column, and the ragged old row has no cell there at all.
    // It still competes on its words, and wins on position.
    expect(result.columns.oldOnly).toEqual([0]);
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
  });

  it("finds the row that went when the key column is all images (T-230)", () => {
    const result = alignTable(
      matrix("| 截图 |", "| --- |", "| ![](/a.png) |", "| ![](/b.png) |"),
      matrix("| 截图 |", "| --- |", "| ![](/b.png) |"),
    );
    // Reading `text` alone, every key here is the empty string and the rows can
    // only pair in order of appearance — which named the *last* row as the one
    // that went (`oldOnly: [2]`) when it was the first.
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([1]);
    expect(result.rows.newOnly).toEqual([]);
  });

  it("sees two rows of images swap places (T-230)", () => {
    const result = alignTable(
      matrix(
        "| 截图 |",
        "| --- |",
        "| ![](/a.png) |",
        "| ![](/b.png) |",
        "| ![](/c.png) |",
      ),
      matrix(
        "| 截图 |",
        "| --- |",
        "| ![](/a.png) |",
        "| ![](/c.png) |",
        "| ![](/b.png) |",
      ),
    );
    // Nothing is drawn either way, so this is about the reading, not the
    // picture — the same reading K asserts for two columns changing places.
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 3],
      [3, 2],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.rows.newOnly).toEqual([]);
  });
});

/** The matrix of the frontmatter block in a fixture. */
function frontmatter(...lines: string[]): TableMatrix {
  const index = buildSegmentIndex(`${lines.join("\n")}\n`);
  const found = tableOf(
    index,
    index.blocks.findIndex((block) => block.type === "frontmatter"),
  );
  if (found === null) throw new Error("the fixture holds no frontmatter");
  return found;
}

describe("alignFrontmatter", () => {
  const base = frontmatter(
    "---",
    "title: Design",
    "status: draft",
    "reviewer: ~",
    "---",
  );

  it("pairs two columns by position and never loses one", () => {
    const result = alignFrontmatter(base, base);
    expect(result.columns).toEqual({
      pairs: [
        [0, 0],
        [1, 1],
      ],
      oldOnly: [],
      newOnly: [],
    });
  });

  it("reports a removed field as removed", () => {
    const result = alignFrontmatter(
      base,
      frontmatter("---", "title: Design", "status: draft", "---"),
    );
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([2]);
    expect(result.rows.newOnly).toEqual([]);
  });

  it("reports an added field as added", () => {
    const result = alignFrontmatter(
      frontmatter("---", "title: Design", "status: draft", "---"),
      base,
    );
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.rows.newOnly).toEqual([2]);
  });

  it("reads a reordering as no change at all", () => {
    // Key pairing never looks at position, and a key/value block has no order
    // to change: the same three fields are still the same three fields.
    const result = alignFrontmatter(
      base,
      frontmatter(
        "---",
        "reviewer: ~",
        "title: Design",
        "status: draft",
        "---",
      ),
    );
    expect(result.rows.pairs).toEqual([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
    expect(result.rows.newOnly).toEqual([]);
  });

  // The boundary with `alignTable`, and the reason this function exists: one
  // field out and one field in must read as two events, not as a rename.
  it("keeps one field out and one in as two events, not a rename", () => {
    const result = alignFrontmatter(
      base,
      frontmatter(
        "---",
        "title: Design",
        "status: draft",
        "approved_by: bot-one",
        "---",
      ),
    );
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.rows.oldOnly).toEqual([2]);
    expect(result.rows.newOnly).toEqual([2]);
  });

  it("pairs a field whose value changed, so the value can be word-diffed", () => {
    const result = alignFrontmatter(
      base,
      frontmatter(
        "---",
        "title: Design",
        "status: approved",
        "reviewer: ~",
        "---",
      ),
    );
    expect(result.rows.pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(result.rows.oldOnly).toEqual([]);
  });

  it("gives up both sides when the two blocks share no key", () => {
    const result = alignFrontmatter(
      frontmatter("---", "title: Design", "---"),
      frontmatter("---", "owner: bot-one", "---"),
    );
    expect(result.rows.pairs).toEqual([]);
    expect(result.rows.oldOnly).toEqual([0]);
    expect(result.rows.newOnly).toEqual([0]);
  });
});
