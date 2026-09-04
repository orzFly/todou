import { describe, expect, it } from "vitest";
import {
  bagWith,
  coalescedWordDiff,
  type WordDiffResult,
  wordBag,
  wordDiff,
} from "../src/lib/word-diff.ts";

/**
 * The diff read back out of its offsets, as the sequence a reader sees. Both
 * texts are sliced by the result itself, so an assertion here is also an
 * assertion that the offsets land where they claim to.
 */
function script(
  oldText: string,
  newText: string,
  result: WordDiffResult,
): string[] {
  const out: string[] = [];
  const dels = [...result.del];
  const inss = [...result.ins];
  let newPos = 0;
  while (dels.length > 0 || inss.length > 0) {
    const at = Math.min(
      dels[0]?.at ?? Number.POSITIVE_INFINITY,
      inss[0]?.start ?? Number.POSITIVE_INFINITY,
    );
    if (at > newPos) {
      out.push(`eq ${newText.slice(newPos, at)}`);
      newPos = at;
    }
    const gone = dels[0]?.at === at ? dels.shift() : undefined;
    if (gone !== undefined)
      out.push(`del ${oldText.slice(gone.from, gone.to)}`);
    const born = inss[0]?.start === at ? inss.shift() : undefined;
    if (born !== undefined) {
      out.push(`ins ${newText.slice(born.start, born.end)}`);
      newPos = born.end;
    }
  }
  if (newPos < newText.length) out.push(`eq ${newText.slice(newPos)}`);
  return out;
}

/**
 * The card's evidence, flattened the way the segment index hands a list item
 * to the differ: one line of prose rewritten almost end to end, with the last
 * sentence untouched.
 */
const EVIDENCE_OLD =
  "format.ts 增加 displayWidth()（East Asian Wide/Fullwidth 区间硬编码，不引依赖），table() 改用它补齐。CJK 标题的列表从「必错位」变成对齐可读——这是「可读输出」的字面修复。";
const EVIDENCE_NEW =
  "引入 string-width（sindresorhus，纯 ESM，无 native 依赖），table() 的 padding 改按它计宽。CJK 双宽、emoji、零宽符、ANSI 转义都由库处理，比手搓区间表可靠。CJK 标题的列表从「必错位」变成对齐可读——这是「可读输出」的字面修复。";

describe("coalescedWordDiff (T-180)", () => {
  it("reads a heavily rewritten line as before/after, not as fragments", () => {
    expect(
      script(
        EVIDENCE_OLD,
        EVIDENCE_NEW,
        coalescedWordDiff(EVIDENCE_OLD, EVIDENCE_NEW),
      ),
    ).toEqual([
      "del format.ts 增加 displayWidth()（East Asian Wide/Fullwidth 区间硬编码，不引",
      "ins 引入 string-width（sindresorhus，纯 ESM，无 native ",
      "eq 依赖），table() ",
      "del 改用它补齐。CJK ",
      "ins 的 padding 改按它计宽。CJK 双宽、emoji、零宽符、ANSI 转义都由库处理，比手搓区间表可靠。CJK ",
      "eq 标题的列表从「必错位」变成对齐可读——这是「可读输出」的字面修复。",
    ]);
  });

  it("leaves the bare diff fragmented, for similarity to measure", () => {
    // `similarity()` scores how much genuinely changed and pairs blocks by it
    // (T-163); reading a coalesced diff there would count the folded-in
    // anchors as change and push pairs under the floor line.
    const bare = script(
      EVIDENCE_OLD,
      EVIDENCE_NEW,
      wordDiff(EVIDENCE_OLD, EVIDENCE_NEW),
    );
    expect(bare.length).toBeGreaterThan(20);
    expect(bare).toContain("del East");
    expect(bare).toContain("ins sindresorhus，纯");
  });

  const unchanged = (oldText: string, newText: string) =>
    expect(
      script(oldText, newText, coalescedWordDiff(oldText, newText)),
    ).toEqual(script(oldText, newText, wordDiff(oldText, newText)));

  it("keeps a replaced Chinese word word-level (T-142)", () => {
    unchanged("这一版发布第二版。", "这一版发布第三版。");
  });

  it("keeps a replaced English word word-level", () => {
    unchanged(
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown wolf jumps over the lazy dog.",
    );
  });

  it("keeps two scattered small edits apart", () => {
    const old = "先跑单元测试，再跑集成测试。";
    const now = "先跑冒烟测试，再跑回归测试。";
    unchanged(old, now);
    expect(script(old, now, coalescedWordDiff(old, now))).toContain(
      "eq 测试，再跑",
    );
  });

  it("keeps two adjacent small edits apart", () => {
    unchanged(
      "端口改成 3000，把主机改成 localhost。",
      "端口改成 4000，把主机改成 0.0.0.0。",
    );
  });

  it("leaves an anchor standing when it ties with its neighbours", () => {
    expect(
      script(
        "aaaaa mid bbbbb",
        "ccccc mid ddddd",
        coalescedWordDiff("aaaaa mid bbbbb", "ccccc mid ddddd"),
      ),
    ).toEqual(["del aaaaa", "ins ccccc", "eq  mid ", "del bbbbb", "ins ddddd"]);
  });

  it("folds the same anchor in once the changes outweigh it by one", () => {
    expect(
      script(
        "aaaaaa mid bbbbbb",
        "cccccc mid dddddd",
        coalescedWordDiff("aaaaaa mid bbbbbb", "cccccc mid dddddd"),
      ),
    ).toEqual(["del aaaaaa mid bbbbbb", "ins cccccc mid dddddd"]);
  });

  it("folds in an anchor the change only outgrew by absorbing an earlier one", () => {
    // `YYY ` outweighs the `bb ` on its left and survives on its own…
    expect(
      script(
        "P bb YYY cccc Q",
        "P YYY Q",
        coalescedWordDiff("P bb YYY cccc Q", "P YYY Q"),
      ),
    ).toEqual(["eq P ", "del bb ", "eq YYY ", "del cccc ", "eq Q"]);
    // …and does not once `bb ` has swallowed `X ` and the `aaaa ` before it.
    expect(
      script(
        "P aaaa X bb YYY cccc Q",
        "P X YYY Q",
        coalescedWordDiff("P aaaa X bb YYY cccc Q", "P X YYY Q"),
      ),
    ).toEqual(["eq P ", "del aaaa X bb YYY cccc ", "ins X YYY ", "eq Q"]);
  });

  it("never folds in what a line opens or closes with", () => {
    expect(
      script(
        "X qwerty uiop asdf.",
        "X zxcvb nmkl hgfd.",
        coalescedWordDiff("X qwerty uiop asdf.", "X zxcvb nmkl hgfd."),
      ),
    ).toEqual(["eq X ", "del qwerty uiop asdf", "ins zxcvb nmkl hgfd", "eq ."]);
  });

  it("has nothing to fold in a text that did not change", () => {
    expect(coalescedWordDiff("同一段文字。", "同一段文字。")).toEqual({
      ins: [],
      del: [],
    });
  });
});

describe("wordBag (T-211)", () => {
  it("weighs each word by its length and leaves the spaces out", () => {
    const bag = wordBag("5.5 CLI");
    expect([...bag.weights]).toEqual([
      ["5.5", 3],
      ["CLI", 3],
    ]);
    expect(bag.total).toBe(6);
  });

  it("segments Chinese and drops the punctuation", () => {
    const bag = wordBag("见下表。");
    expect([...bag.weights]).toEqual([
      ["见", 1],
      ["下表", 2],
    ]);
    expect(bag.total).toBe(3);
  });
});

describe("bagWith (T-239)", () => {
  it("is the prose bag itself when there is no picture", () => {
    expect(bagWith("见下表。", [])).toEqual(wordBag("见下表。"));
  });

  it("adds one entry per picture, whatever the url spends on its path", () => {
    const prose = wordBag("见下表。");
    // The real shape of an attachment url: almost all of it is the path every
    // attachment in a deployment shares, which is exactly what must not be
    // weighed (T-239). A short url would pass this test either way.
    const bag = bagWith("见下表。", [
      "/api/projects/p/attachments/929/download/toolbar-v1.png",
    ]);
    expect(bag.total).toBe(prose.total + 1);
    expect(bag.weights.size).toBe(prose.weights.size + 1);
    // Nothing the segmenter can produce collides with the picture's key, so
    // the prose side of the bag comes through untouched.
    for (const [word, weight] of prose.weights) {
      expect(bag.weights.get(word)).toBe(weight);
    }
  });

  it("counts the same url twice when a cell shows it twice", () => {
    const url = "/api/projects/p/attachments/929/download/toolbar-v1.png";
    const once = bagWith("", [url]);
    const twice = bagWith("", [url, url]);
    expect(once.total).toBe(1);
    expect(twice.total).toBe(2);
    expect([...twice.weights.values()]).toEqual([2]);
  });
});
