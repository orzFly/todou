import { describe, expect, it } from "vitest";
import { type AlignGroup, alignGroups } from "../src/lib/group-align.ts";
import type { SourceBlockType } from "../src/lib/spec-source-index.ts";

let next = 0;

/** A group with a fresh number; `at` never matters to the alignment itself. */
function group(type: SourceBlockType | null, text: string): AlignGroup {
  return { group: next++, type, text, at: 0 };
}

const para = (text: string) => group("paragraph", text);
const cell = (text: string) => group("tableCell", text);
const head = (text: string) => group("heading", text);

const paired = (result: ReturnType<typeof alignGroups>) =>
  result.pairs.map((p) => [p.old.text, p.new.text]);

describe("alignGroups", () => {
  it("anchors equal groups and draws nothing on them", () => {
    const olds = [cell("一"), cell("二")];
    const news = [cell("一"), cell("贰")];
    const result = alignGroups(olds, news);
    expect(paired(result)).toEqual([["二", "贰"]]);
    expect(result.oldOnly).toEqual([]);
    expect(result.newOnly).toEqual([]);
  });

  it("pairs one for one even with nothing in common", () => {
    // T-142's flagship: 二 → 三 shares no character and must stay word-level.
    const result = alignGroups([cell("二")], [cell("三")]);
    expect(paired(result)).toEqual([["二", "三"]]);
  });

  it("never pairs a paragraph with a table cell", () => {
    // T-163 itself: a paragraph replaced by a whole table.
    const result = alignGroups(
      [para("这一段会被整段删掉，用来看纯删除的 marker 还在不在。")],
      [cell("引擎"), cell("渠道"), cell("判定")],
    );
    expect(result.pairs).toEqual([]);
    expect(result.oldOnly.map((o) => o.newIndex)).toEqual([0]);
    expect(result.newOnly.map((g) => g.text)).toEqual(["引擎", "渠道", "判定"]);
  });

  it("pairs a paragraph with a heading, which is a real edit", () => {
    const result = alignGroups([para("小节说明")], [head("小节说明标题")]);
    expect(paired(result)).toEqual([["小节说明", "小节说明标题"]]);
  });

  it("picks the similar counterpart out of a run, not the first", () => {
    const result = alignGroups(
      [head("引擎矩阵")],
      [head("引擎与渠道矩阵"), para("新增的一整段说明文字。")],
    );
    expect(paired(result)).toEqual([["引擎矩阵", "引擎与渠道矩阵"]]);
    expect(result.newOnly.map((g) => g.text)).toEqual([
      "新增的一整段说明文字。",
    ]);
  });

  it("finds that counterpart when the new block comes first", () => {
    const result = alignGroups(
      [head("引擎矩阵")],
      [para("新增的一整段说明文字。"), head("引擎与渠道矩阵")],
    );
    expect(paired(result)).toEqual([["引擎矩阵", "引擎与渠道矩阵"]]);
    expect(result.newOnly.map((g) => g.text)).toEqual([
      "新增的一整段说明文字。",
    ]);
  });

  it("leaves the unrelated old block unpaired, at the seam it sat in", () => {
    const result = alignGroups(
      [para("段落甲。"), para("段落乙。")],
      [para("段落甲改。")],
    );
    expect(paired(result)).toEqual([["段落甲。", "段落甲改。"]]);
    expect(result.oldOnly.map((o) => [o.group.text, o.newIndex])).toEqual([
      ["段落乙。", 1],
    ]);
  });

  it("refuses a pair below the similarity floor", () => {
    const result = alignGroups(
      [para("完全不相干的一段旧文字。"), para("另一段旧文字。")],
      [para("与之毫无关系的全新内容")],
    );
    expect(result.pairs).toEqual([]);
    expect(result.oldOnly).toHaveLength(2);
    expect(result.newOnly).toHaveLength(1);
  });

  it("keeps unmatched neighbours at one seam so they share a marker", () => {
    const result = alignGroups(
      [para("旧甲。"), para("旧乙。"), para("保留段。")],
      [para("保留段。")],
    );
    expect(result.oldOnly.map((o) => o.newIndex)).toEqual([0, 0]);
  });

  it("zips by position once the run is too wide to score", () => {
    // 11 × 11 clears the 100-pair guard; nothing is equal, so it is one run.
    const olds = Array.from({ length: 11 }, (_, i) => cell(`旧${i}`));
    const news = Array.from({ length: 11 }, (_, i) => cell(`新${i}`));
    const result = alignGroups(olds, news);
    expect(paired(result)).toEqual(olds.map((o, i) => [o.text, `新${i}`]));
    expect(result.oldOnly).toEqual([]);
    expect(result.newOnly).toEqual([]);
  });

  it("drops the surplus when a wide run's two sides differ in length", () => {
    const olds = Array.from({ length: 11 }, (_, i) => cell(`旧${i}`));
    const news = Array.from({ length: 13 }, (_, i) => cell(`新${i}`));
    const result = alignGroups(olds, news);
    expect(result.pairs).toHaveLength(11);
    expect(result.newOnly.map((g) => g.text)).toEqual(["新11", "新12"]);
  });

  it("only ever pairs an untyped group with another untyped one", () => {
    const result = alignGroups([group(null, "甲")], [para("甲改")]);
    expect(result.pairs).toEqual([]);
    expect(result.oldOnly).toHaveLength(1);
    expect(result.newOnly).toHaveLength(1);
    expect(
      paired(alignGroups([group(null, "甲")], [group(null, "甲改")])),
    ).toEqual([["甲", "甲改"]]);
  });

  it("has nothing to say about two empty sides", () => {
    expect(alignGroups([], [])).toEqual({
      pairs: [],
      oldOnly: [],
      newOnly: [],
    });
  });
});
