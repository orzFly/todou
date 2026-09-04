import { describe, expect, it } from "vitest";
import {
  type AlignGroup,
  alignGroups,
  matchByWords,
} from "../src/lib/group-align.ts";
import type { SourceBlockType } from "../src/lib/spec-source-index.ts";

let next = 0;

/** A group with a fresh number; `at` never matters to the alignment itself. */
function group(type: SourceBlockType | null, text: string): AlignGroup {
  return { group: next++, type, text, at: 0 };
}

const para = (text: string) => group("paragraph", text);
const cell = (text: string) => group("tableCell", text);
const head = (text: string) => group("heading", text);
const code = (text: string) => group("code", text);
const table = (text: string) => group("table", text);

/** T-209's repro: the paragraph that was deleted above a renumbered heading. */
const T209_PARA =
  "上一版把裁决写在评论里，读者要在时间线里翻找才能知道当前版本过没过；这一版把裁决落到卡片头部的固定位置，任何时候打开都能一眼看到，不必回溯历史。";

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
    // Between two anchors with one block on each side, the position is the
    // evidence; nothing else gets a vote.
    const result = alignGroups([cell("二")], [cell("三")]);
    expect(paired(result)).toEqual([["二", "三"]]);
  });

  it("pairs one for one at the same size, sharing nothing at all", () => {
    // Every word replaced but the bulk unchanged: still one block rewritten.
    const result = alignGroups(
      [para("aaaa bbbb cccc dddd eeee ffff gggg")],
      [para("hhhh iiii jjjj kkkk llll mmmm nnnn")],
    );
    expect(paired(result)).toEqual([
      [
        "aaaa bbbb cccc dddd eeee ffff gggg",
        "hhhh iiii jjjj kkkk llll mmmm nnnn",
      ],
    ]);
  });

  it("pairs two blocks however far apart their lengths", () => {
    // A cell holding one word can lose every character of it and still be
    // the cell that was rewritten. T-209 shipped a gate that refused this on
    // a length ratio; the ratio was never the question (T-211).
    expect(paired(alignGroups([cell("否")], [cell("需要人工确认")]))).toEqual([
      ["否", "需要人工确认"],
    ]);
  });

  it("pairs the renumbered heading across a deleted paragraph (T-211)", () => {
    // T-209's repro, and the card this one exists for. The line diff used to
    // cut the two headings into different hunks over one blank line, so the
    // deleted paragraph met `5.6 CLI` alone and came out struck through,
    // inline, beside the new heading's words. Over the whole document the run
    // is 2×1: 5.5 scores 0.50 against 5.6, the paragraph 0.00, so the heading
    // takes the pair and the paragraph is what went.
    const result = alignGroups(
      [para(T209_PARA), head("5.5 CLI")],
      [head("5.6 CLI")],
    );
    expect(paired(result)).toEqual([["5.5 CLI", "5.6 CLI"]]);
    expect(result.oldOnly.map((o) => [o.group.text, o.newIndex])).toEqual([
      [T209_PARA, 0],
    ]);
    expect(result.newOnly).toEqual([]);
  });

  it("pairs a short pointer with the paragraph that replaced it", () => {
    // Expanding `见下表。` into the table's prose is an ordinary edit. It
    // shares not one word with what replaced it (bag similarity 0.00), and
    // pairs anyway: one block, one counterpart, no competition. T-209's gate
    // refused it on both of its measures and rendered a marker plus a whole
    // new block.
    const result = alignGroups([para("见下表。")], [para(T209_PARA)]);
    expect(paired(result)).toEqual([["见下表。", T209_PARA]]);
  });

  it("decides each type class on its own", () => {
    // One paragraph and one fence on each side is two 1×1 questions. Read as
    // a single 2×2 it would put `intro` and `outro` up against the similarity
    // floor, which two unrelated single words cannot clear.
    const result = alignGroups(
      [para("intro"), code("```ts\na = 1;\n```")],
      [para("outro"), code("```ts\na = 2;\n```")],
    );
    expect(paired(result)).toEqual([
      ["intro", "outro"],
      ["```ts\na = 1;\n```", "```ts\na = 2;\n```"],
    ]);
  });

  it("never pairs code with prose", () => {
    const result = alignGroups([para("说明")], [code("```\nx\n```")]);
    expect(result.pairs).toEqual([]);
    expect(result.oldOnly.map((o) => o.group.text)).toEqual(["说明"]);
    expect(result.newOnly.map((g) => g.text)).toEqual(["```\nx\n```"]);
  });

  it("scores a block whose sentences were reordered as the same block", () => {
    // What a bag of words buys over diffing them: reordering two sentences
    // leaves every word in place, so the bag reads 1.00 where the old
    // diff-based measure read 0.60. The unrelated third paragraph scores 0.00
    // either way and is what went.
    const result = alignGroups(
      [para("甲句在前。乙句在后。"), para("毫不相干的第三段。")],
      [para("乙句在后。甲句在前。")],
    );
    expect(paired(result)).toEqual([
      ["甲句在前。乙句在后。", "乙句在后。甲句在前。"],
    ]);
    expect(result.oldOnly.map((o) => [o.group.text, o.newIndex])).toEqual([
      ["毫不相干的第三段。", 1],
    ]);
  });

  it("puts a dropped old leaf at the seam of the new leaf it lost to", () => {
    // The fence is identical on both sides, so it anchors and the run is the
    // two paragraphs against one. 旧甲 takes the pair at 0.80 against 旧乙's
    // 0.40, and 旧乙 lands after the new paragraph, where it used to sit.
    const result = alignGroups(
      [para("旧甲。"), para("旧乙。"), code("```\nk\n```")],
      [para("旧甲改。"), code("```\nk\n```")],
    );
    expect(paired(result)).toEqual([["旧甲。", "旧甲改。"]]);
    expect(result.oldOnly.map((o) => [o.group.text, o.newIndex])).toEqual([
      ["旧乙。", 1],
    ]);
    expect(result.newOnly).toEqual([]);
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
    // 101 × 101 clears the 10 000-pair guard; nothing is equal, so it is one
    // run. Real revisions get nowhere near: the widest measured is 30 × 14.
    const olds = Array.from({ length: 101 }, (_, i) => cell(`旧${i}`));
    const news = Array.from({ length: 101 }, (_, i) => cell(`新${i}`));
    const result = alignGroups(olds, news);
    expect(paired(result)).toEqual(olds.map((o, i) => [o.text, `新${i}`]));
    expect(result.oldOnly).toEqual([]);
    expect(result.newOnly).toEqual([]);
  });

  it("drops the surplus when a wide run's two sides differ in length", () => {
    const olds = Array.from({ length: 101 }, (_, i) => cell(`旧${i}`));
    const news = Array.from({ length: 103 }, (_, i) => cell(`新${i}`));
    const result = alignGroups(olds, news);
    expect(result.pairs).toHaveLength(101);
    expect(result.newOnly.map((g) => g.text)).toEqual(["新101", "新102"]);
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

  it("pairs a table only with a table (T-221)", () => {
    // A document's leaves hold whole tables now, so the class has to keep them
    // apart from prose the way it always kept cells apart.
    const result = alignGroups(
      [para("说明"), table("甲\n乙\n一\n二")],
      [para("说明改"), table("甲\n乙\n一\n贰")],
    );
    expect(paired(result)).toEqual([
      ["说明", "说明改"],
      ["甲\n乙\n一\n二", "甲\n乙\n一\n贰"],
    ]);
    const mixed = alignGroups([cell("一")], [table("一\n二")]);
    expect(mixed.pairs).toEqual([]);
    expect(mixed.oldOnly).toHaveLength(1);
    expect(mixed.newOnly).toHaveLength(1);
  });

  describe("images (T-223)", () => {
    // The shape a spec document actually carries: one shared prefix, one
    // attachment id, one filename.
    const A = "/api/projects/p/attachments/929/download/toolbar-v1.png";
    const B = "/api/projects/p/attachments/1401/download/toolbar-v2.png";
    const C = "/api/projects/p/attachments/930/download/panel-v1.png";
    const D = "/api/projects/p/attachments/1402/download/panel-v2.png";
    const img = (url: string) => group("image", `![](${url})`);

    it("pairs a swapped image one for one, sharing no url at all", () => {
      // 1×1 is its own evidence: the position is unique, so the similarity
      // floor is never asked — the same reasoning T-142 used for 二 → 三.
      const result = alignGroups([img("/a.png")], [img("/b.png")]);
      expect(paired(result)).toEqual([["![](/a.png)", "![](/b.png)"]]);
    });

    it("keeps two images swapped at once in their own order", () => {
      const result = alignGroups([img(A), img(C)], [img(B), img(D)]);
      expect(paired(result)).toEqual([
        [`![](${A})`, `![](${B})`],
        [`![](${C})`, `![](${D})`],
      ]);
    });

    it("never pairs an image with prose, a fence or a table", () => {
      for (const other of [
        para("这里本来是一段文字说明。"),
        code("```js\na();\n```"),
        table("甲\n乙"),
      ]) {
        const result = alignGroups([other], [img(B)]);
        expect(result.pairs).toEqual([]);
        expect(result.oldOnly).toHaveLength(1);
        expect(result.newOnly).toHaveLength(1);
      }
    });
  });
});

describe("matchByWords (T-221)", () => {
  it("pairs one against one on position alone", () => {
    expect(matchByWords(["二"], ["三"])).toEqual({
      pairs: [[0, 0]],
      oldOnly: [],
      newOnly: [],
    });
  });

  it("names the new index an unmatched old one lost to", () => {
    // 旧甲 takes the pair; 旧乙 lost to nothing that follows, so it lands at
    // the end — which is where its marker goes.
    expect(matchByWords(["旧甲。", "旧乙。"], ["旧甲改。"])).toEqual({
      pairs: [[0, 0]],
      oldOnly: [[1, 1]],
      newOnly: [],
    });
    // The other order: 旧乙 loses to the new leaf standing in front of it.
    expect(matchByWords(["旧乙。", "旧甲。"], ["旧甲改。"])).toEqual({
      pairs: [[1, 0]],
      oldOnly: [[0, 0]],
      newOnly: [],
    });
  });

  it("has an answer when one side is empty", () => {
    expect(matchByWords(["甲", "乙"], [])).toEqual({
      pairs: [],
      oldOnly: [
        [0, 0],
        [1, 0],
      ],
      newOnly: [],
    });
    expect(matchByWords([], ["甲"])).toEqual({
      pairs: [],
      oldOnly: [],
      newOnly: [0],
    });
  });
});
