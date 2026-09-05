import { describe, expect, it } from "vitest";
import {
  type ScanConfig,
  scanReferenceTokens,
} from "../src/references-grammar.ts";
import {
  maskMarkdownCode,
  type RespellInputs,
  respellForMove,
} from "../src/respell.ts";

const SINCE = "2026-01-01T00:00:00Z";
const AT = "2026-06-01T00:00:00Z";
const LONG_AGO = "2025-06-01T00:00:00Z";
const ORIGIN = "homelab";

const DIRECTORY = {
  entries: [{ prefix: "T", slug: "todou", from: SINCE, to: null }],
  contested: [],
};

function anchorOf(over: Partial<ScanConfig> = {}): ScanConfig {
  return {
    internalPrefix: null,
    cross: {
      slugs: [ORIGIN, "roise", "todou"],
      directory: DIRECTORY,
      at: AT,
    },
    ...over,
  };
}

function inputsOf(over: Partial<RespellInputs> = {}): RespellInputs {
  return { anchor: anchorOf(), originSlug: ORIGIN, ...over };
}

/**
 * The reviewer's question about reformatting, as an assertion: the runs of
 * text BETWEEN the reference tokens have to come back byte for byte. Sliced
 * out of the unmasked string on purpose, so a stray edit inside a code fence
 * fails here too.
 */
function expectOnlyTokensTouched(
  before: string,
  after: string,
  anchor: ScanConfig,
): void {
  const gaps = (text: string) =>
    scanReferenceTokens(maskMarkdownCode(text), anchor)
      .filter((token) => token.type === "text")
      .map((token) => text.slice(token.start, token.end));
  expect(gaps(after)).toEqual(gaps(before));
}

/** Respell and hold the output to both the expected text and that invariant. */
function respelt(
  text: string,
  inputs: RespellInputs,
  expected: string,
  rewritten = 1,
): void {
  const result = respellForMove(text, inputs);
  expect(result).toEqual({
    text: expected,
    changed: expected !== text,
    skipped: false,
    rewritten,
  });
  expectOnlyTokensTouched(text, result.text, inputs.anchor);
}

const nothingHappened = (text: string) => ({
  text,
  changed: false,
  skipped: false,
  rewritten: 0,
});

const abandoned = (text: string) => ({
  text,
  changed: false,
  skipped: true,
  rewritten: 0,
});

describe("maskMarkdownCode", () => {
  it("blanks code regions without moving an offset", () => {
    const text = [
      "before `#1` after",
      "```",
      "#2 inside a fence",
      "```",
      "#3 outside",
    ].join("\n");
    const masked = maskMarkdownCode(text);

    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n").map((line) => line.length)).toEqual(
      text.split("\n").map((line) => line.length),
    );
    expect(masked.split("\n")[0]).toBe("before      after");
    expect(masked.split("\n")[2]).toBe(" ".repeat("#2 inside a fence".length));
    expect(masked.split("\n")[4]).toBe("#3 outside");
  });

  it("takes tildes, an indented fence and a multi-backtick run", () => {
    const text = ["   ~~~", "#1", "   ~~~", "``#2`` and ``#3``"].join("\n");
    const masked = maskMarkdownCode(text);

    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")[1]).toBe("  ");
    // Two spans, not one: the closing run is the first match of the opening
    // one, so the prose between them is not code and must survive.
    expect(masked.split("\n")[3]).toBe("       and       ");
  });

  it("masks an unclosed fence to the end of the text", () => {
    const text = ["intro #1", "```ts", "#2", "still #3"].join("\n");
    const masked = maskMarkdownCode(text);

    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")[0]).toBe("intro #1");
    expect(masked.slice(masked.indexOf("\n") + 1)).toBe(
      `${" ".repeat("```ts".length)}\n  \n${" ".repeat("still #3".length)}`,
    );
  });

  it("leaves text with no code alone", () => {
    const text = "plain #1 and roise#7";
    expect(maskMarkdownCode(text)).toBe(text);
  });
});

describe("respellForMove", () => {
  it("qualifies a bare ref and leaves position-independent forms alone", () => {
    respelt(
      "see #12 and roise#7, plus T-9 — code: `#13`",
      inputsOf(),
      "see homelab#12 and roise#7, plus T-9 — code: `#13`",
    );
  });

  it("qualifies the origin's own prefixed format", () => {
    const inputs = inputsOf({ anchor: anchorOf({ internalPrefix: "CH" }) });
    // `#19` is not a reference at all under this anchor, so it must survive
    // exactly as typed while `CH-19` becomes position-independent.
    respelt("fixes CH-19, not #19", inputs, "fixes homelab#19, not #19");
  });

  it("leaves an autolink alone", () => {
    const inputs = inputsOf({
      anchor: anchorOf({
        autolinks: [
          { prefix: "GH-", url_template: "https://example.com/<num>" },
        ],
      }),
    });
    respelt("GH-4 and #5", inputs, "GH-4 and homelab#5");
  });

  it("never reaches inside a fence", () => {
    const text = ["#1 outside", "```", "#2 inside", "```", "tail #3"].join(
      "\n",
    );
    respelt(
      text,
      inputsOf(),
      ["homelab#1 outside", "```", "#2 inside", "```", "tail homelab#3"].join(
        "\n",
      ),
      2,
    );
  });

  it("carries a comment anchor along with the address that holds it", () => {
    // The old address redirects, comment aliases included, so the suffix is
    // still the origin's id — rewriting it would split one locator in two.
    respelt("see #7#comment-42", inputsOf(), "see homelab#7#comment-42");
  });

  it("remaps a bare comment anchor to the copy that landed", () => {
    respelt(
      "as in #comment-100 above",
      inputsOf({ commentIdMap: new Map([[100, 205]]) }),
      "as in #comment-205 above",
    );
  });

  it("qualifies a comment anchor that lives on another of the origin's cards", () => {
    respelt(
      "see #comment-77",
      inputsOf({ foreignCommentIssue: new Map([[77, 7]]) }),
      "see homelab#7#comment-77",
    );
  });

  it("leaves a comment anchor nobody could place", () => {
    expect(respellForMove("see #comment-99", inputsOf())).toEqual(
      nothingHappened("see #comment-99"),
    );
  });

  it("splices several tokens in one pass", () => {
    const text = [
      "Body mentioning #1, #comment-100 and roise#7#comment-8.",
      "",
      "| ref | note |",
      "| --- | --- |",
      "| #2 | inline `#3` stays |",
    ].join("\n");
    respelt(
      text,
      inputsOf({ commentIdMap: new Map([[100, 205]]) }),
      [
        "Body mentioning homelab#1, #comment-205 and roise#7#comment-8.",
        "",
        "| ref | note |",
        "| --- | --- |",
        "| homelab#2 | inline `#3` stays |",
      ].join("\n"),
      3,
    );
  });

  it("is idempotent", () => {
    const inputs = inputsOf({ commentIdMap: new Map([[100, 205]]) });
    const once = respellForMove("#1 and #comment-100", inputs);
    expect(once.changed).toBe(true);
    expect(respellForMove(once.text, inputs)).toEqual(
      nothingHappened(once.text),
    );
  });

  it("respells a segment written long before the directory's holds", () => {
    const inputs = inputsOf({
      anchor: anchorOf({
        cross: {
          slugs: [ORIGIN, "roise", "todou"],
          directory: DIRECTORY,
          at: LONG_AGO,
        },
      }),
    });
    respelt("see #12", inputs, `see ${ORIGIN}#12`);
  });

  it("abandons a segment whose origin slug named someone else back then", () => {
    const inputs = inputsOf({
      anchor: anchorOf({
        cross: {
          slugs: [ORIGIN, "roise", "todou"],
          directory: DIRECTORY,
          slugEntries: [
            { slug: ORIGIN, canonical: "roise", from: SINCE, to: null },
          ],
          at: AT,
        },
      }),
    });
    expect(respellForMove("see #12", inputs)).toEqual(abandoned("see #12"));
  });

  it("abandons a segment whose spelling would stop resolving", () => {
    // A bare ref may follow a hyphen; a slug-qualified one may not, so this
    // rewrite would silently delete the reference.
    expect(respellForMove("range #12-#15", inputsOf())).toEqual(
      abandoned("range #12-#15"),
    );
  });

  it("spells a card's own anchor as an old address when asked to", () => {
    // What a caller with no un-respelled promise passes: the qualified old
    // address instead of the new id, which is a form a second pass cannot
    // mistake for a bare id it still owes a rewrite.
    const inputs = inputsOf({ foreignCommentIssue: new Map([[2, 19]]) });
    respelt("see #comment-2", inputs, "see homelab#19#comment-2");
    expect(respellForMove("see homelab#19#comment-2", inputs)).toEqual(
      nothingHappened("see homelab#19#comment-2"),
    );
  });

  it("says nothing happened when there is nothing to respell", () => {
    for (const text of ["", "no references here", "roise#7 only"]) {
      expect(respellForMove(text, inputsOf())).toEqual(nothingHappened(text));
    }
  });
});
