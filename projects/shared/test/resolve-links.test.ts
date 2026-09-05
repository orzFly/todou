import { describe, expect, it } from "vitest";
import {
  type ReferenceToken,
  type ScanConfig,
  scanReferenceTokens,
} from "../src/references-grammar.ts";
import {
  findMarkdownLinks,
  hrefFor,
  linkFor,
  maskForResolve,
  maskMarkdownCode,
  parseInternalHref,
  type ResolvedTarget,
  type ResolveEdit,
  spliceResolved,
} from "../src/resolve-links.ts";

const AT = "2026-06-01T00:00:00Z";
const ORIGIN = "https://todou.example";

/** Project ids the fake resolver below hands out, one per slug. */
const IDS: Record<string, number> = { todou: 7, alpha: 12, roise: 3 };

const ANCHOR: ScanConfig = {
  internalPrefix: null,
  cross: {
    slugs: ["todou", "alpha", "roise"],
    directory: {
      entries: [{ prefix: "T", slug: "todou", from: "2025-01-01", to: null }],
      contested: [],
    },
    at: AT,
  },
};

/**
 * The server's job, stubbed: a token names a project by slug or means "here",
 * and every card exists at the number written. That is enough to exercise the
 * splice and the masking, which is all this module owns.
 */
function targetOf(
  token: ReferenceToken,
  here = "todou",
): ResolvedTarget | null {
  if (token.type === "issue") {
    const slug = token.slug ?? here;
    const id = IDS[slug];
    if (id === undefined) return null;
    return {
      kind: "issue",
      projectId: id,
      number: token.number,
      ...(token.commentId === undefined ? {} : { commentId: token.commentId }),
    };
  }
  if (token.type === "comment") {
    return {
      kind: "issue",
      projectId: IDS[here] as number,
      number: 1,
      commentId: token.commentId,
    };
  }
  return null;
}

/** The whole pure pipeline: mask, scan, rewrite tokens and hrefs, splice. */
function resolve(text: string, options: { origin?: string } = {}): string {
  const links = findMarkdownLinks(text, options);
  const masked = maskForResolve(text, links);
  const edits: ResolveEdit[] = [];
  for (const token of scanReferenceTokens(masked, ANCHOR)) {
    if (token.type === "text" || token.type === "autolink") continue;
    const target = targetOf(token);
    if (target === null) continue;
    edits.push({
      start: token.start,
      end: token.end,
      text: linkFor(target, token.text),
    });
  }
  for (const link of links) {
    const found = link.target;
    if (found === null || found.project.kind === "id") continue;
    const id = IDS[found.project.slug];
    if (id === undefined) continue;
    const target: ResolvedTarget =
      found.kind === "issue"
        ? {
            kind: "issue",
            projectId: id,
            number: found.number,
            ...(found.commentId === undefined
              ? {}
              : { commentId: found.commentId }),
          }
        : {
            kind: "attachment",
            projectId: id,
            id: found.id,
            variant: found.variant,
            name: found.name,
          };
    edits.push(
      link.bare
        ? { start: link.start, end: link.end, text: linkFor(target, link.href) }
        : {
            start: link.hrefStart,
            end: link.hrefEnd,
            text: hrefFor(target),
          },
    );
  }
  return spliceResolved(text, edits);
}

describe("token rewrites", () => {
  const cases: Array<[string, string]> = [
    ["#12", "[#12](/projects/7/issues/12)"],
    ["alpha#3", "[alpha#3](/projects/12/issues/3)"],
    ["alpha/3", "[alpha/3](/projects/12/issues/3)"],
    ["alpha/#3", "[alpha/#3](/projects/12/issues/3)"],
    ["roise/T-3", "[roise/T-3](/projects/3/issues/3)"],
    ["T-9", "[T-9](/projects/7/issues/9)"],
    ["#12#comment-34", "[#12#comment-34](/projects/7/issues/12#comment-34)"],
    ["#comment-34", "[#comment-34](/projects/7/issues/1#comment-34)"],
  ];
  for (const [written, stored] of cases) {
    it(`stores ${written} as an id link`, () => {
      expect(resolve(`see ${written} now`)).toBe(`see ${stored} now`);
    });
  }

  it("keeps a target nobody claims verbatim", () => {
    expect(resolve("see nowhere#3 and elsewhere/4")).toBe(
      "see nowhere#3 and elsewhere/4",
    );
  });

  it("reads a hyphen between two refs as a separator", () => {
    expect(resolve("#12-#15")).toBe(
      "[#12](/projects/7/issues/12)-[#15](/projects/7/issues/15)",
    );
  });
});

describe("href normalisation", () => {
  it("rewrites a slug-form issue href and leaves the text alone", () => {
    expect(resolve("[the card](/projects/alpha/issues/3)")).toBe(
      "[the card](/projects/12/issues/3)",
    );
  });

  it("carries a comment anchor across", () => {
    expect(resolve("[there](/projects/alpha/issues/3#comment-9)")).toBe(
      "[there](/projects/12/issues/3#comment-9)",
    );
  });

  it("rewrites an attachment href, name segment intact", () => {
    expect(
      resolve("![shot](/api/projects/alpha/attachments/5/download/a%20b.png)"),
    ).toBe("![shot](/api/projects/12/attachments/5/download/a%20b.png)");
  });

  it("keeps the /view twin a /view twin", () => {
    expect(resolve("[f](/api/projects/roise/attachments/8/view)")).toBe(
      "[f](/api/projects/3/attachments/8/view)",
    );
  });

  it("leaves an external href alone", () => {
    expect(resolve("[gh](https://example.com/projects/alpha/issues/3)")).toBe(
      "[gh](https://example.com/projects/alpha/issues/3)",
    );
  });

  it("normalises a same-origin absolute URL only when the origin is known", () => {
    const text = "[here](https://todou.example/projects/alpha/issues/3)";
    expect(resolve(text)).toBe(text);
    expect(resolve(text, { origin: ORIGIN })).toBe(
      "[here](/projects/12/issues/3)",
    );
  });

  it("wraps a bare pasted URL, keeping it as the link text", () => {
    expect(
      resolve("see https://todou.example/projects/alpha/issues/3 today", {
        origin: ORIGIN,
      }),
    ).toBe(
      "see [https://todou.example/projects/alpha/issues/3](/projects/12/issues/3) today",
    );
  });

  it("wraps an angle-bracket autolink", () => {
    expect(
      resolve("<https://todou.example/projects/alpha/issues/3>", {
        origin: ORIGIN,
      }),
    ).toBe(
      "[https://todou.example/projects/alpha/issues/3](/projects/12/issues/3)",
    );
  });

  it("leaves a sentence's full stop out of the URL", () => {
    expect(
      resolve("go to https://todou.example/projects/alpha/issues/3.", {
        origin: ORIGIN,
      }),
    ).toBe(
      "go to [https://todou.example/projects/alpha/issues/3](/projects/12/issues/3).",
    );
  });
});

describe("what the rewrite must not touch", () => {
  it("leaves a fenced block verbatim", () => {
    const text = "```\n#12 and alpha#3\n```\n#4";
    expect(resolve(text)).toBe(
      "```\n#12 and alpha#3\n```\n[#4](/projects/7/issues/4)",
    );
  });

  it("leaves an inline code span verbatim", () => {
    expect(resolve("`#12` but #4")).toBe(
      "`#12` but [#4](/projects/7/issues/4)",
    );
  });

  it("leaves a link inside a fence unrecognised", () => {
    const text = "```\n[a](/projects/alpha/issues/3)\n```";
    expect(findMarkdownLinks(text)).toEqual([]);
    expect(resolve(text)).toBe(text);
  });

  it("does not scan tokens inside a link's own text", () => {
    const text = "[see #12 here](https://example.com/)";
    expect(resolve(text)).toBe(text);
  });

  it("does not scan tokens inside a link's href", () => {
    const text = "[x](https://example.com/#12)";
    expect(resolve(text)).toBe(text);
  });

  it("leaves a reference-style definition verbatim", () => {
    const text = "[ref]: /projects/alpha/issues/3\n\nsee [ref]";
    expect(resolve(text)).toBe(text);
  });
});

describe("idempotence", () => {
  const sources = [
    "#12 and alpha#3 and #comment-7",
    "[the card](/projects/alpha/issues/3) plus #4",
    "![shot](/api/projects/alpha/attachments/5/download/a.png)",
    "see https://todou.example/projects/alpha/issues/3 today",
    "`#12` in code, #12 outside, ```\nfenced #12\n```",
  ];
  for (const source of sources) {
    it(`settles after one pass: ${source.slice(0, 32)}`, () => {
      const once = resolve(source, { origin: ORIGIN });
      expect(resolve(once, { origin: ORIGIN })).toBe(once);
      // Nothing is left for a second pass to see, which is the stronger
      // claim: the mask hides the whole rewritten link from the scanner.
      const masked = maskForResolve(
        once,
        findMarkdownLinks(once, { origin: ORIGIN }),
      );
      expect(
        scanReferenceTokens(masked, ANCHOR).filter(
          (token) => token.type !== "text",
        ),
      ).toEqual([]);
    });
  }
});

describe("findMarkdownLinks", () => {
  it("reports spans that index back into the source", () => {
    const text = "a [b](/projects/alpha/issues/3) c";
    const [link] = findMarkdownLinks(text);
    expect(link).toBeDefined();
    expect(text.slice(link?.start, link?.end)).toBe(
      "[b](/projects/alpha/issues/3)",
    );
    expect(text.slice(link?.hrefStart, link?.hrefEnd)).toBe(
      "/projects/alpha/issues/3",
    );
    expect(link?.bare).toBe(false);
  });

  it("covers the image marker in the span", () => {
    const text = "![b](/x)";
    expect(findMarkdownLinks(text)[0]?.start).toBe(0);
  });

  it("reads a destination in angle brackets", () => {
    const [link] = findMarkdownLinks("[b](</projects/alpha/issues/3>)");
    expect(link?.href).toBe("/projects/alpha/issues/3");
    expect(link?.target).toEqual({
      kind: "issue",
      project: { kind: "slug", slug: "alpha" },
      number: 3,
    });
  });

  it("reads a destination followed by a title", () => {
    const [link] = findMarkdownLinks('[b](/projects/alpha/issues/3 "t")');
    expect(link?.href).toBe("/projects/alpha/issues/3");
  });

  it("handles nested brackets in the link text", () => {
    const [link] = findMarkdownLinks("[a [b] c](/projects/alpha/issues/3)");
    expect(link?.href).toBe("/projects/alpha/issues/3");
  });

  it("skips an escaped bracket", () => {
    expect(findMarkdownLinks("\\[a](/x)")).toEqual([]);
  });
});

describe("parseInternalHref", () => {
  it("tells an id spelling from a slug spelling", () => {
    expect(parseInternalHref("/projects/7/issues/3")).toEqual({
      kind: "issue",
      project: { kind: "id", id: 7 },
      number: 3,
    });
    expect(parseInternalHref("/projects/alpha/issues/3")).toEqual({
      kind: "issue",
      project: { kind: "slug", slug: "alpha" },
      number: 3,
    });
  });

  it("rejects a query, a foreign anchor and a protocol-relative URL", () => {
    expect(parseInternalHref("/projects/7/issues/3?x=1")).toBeNull();
    expect(parseInternalHref("/projects/7/issues/3#event-4")).toBeNull();
    expect(parseInternalHref("//todou.example/projects/7/issues/3")).toBeNull();
  });

  it("rejects an absolute URL from another origin", () => {
    expect(
      parseInternalHref(
        "https://elsewhere.example/projects/7/issues/3",
        ORIGIN,
      ),
    ).toBeNull();
  });
});

describe("spliceResolved", () => {
  it("keeps every byte outside a span", () => {
    expect(
      spliceResolved("abcdef", [
        { start: 1, end: 3, text: "XY Z" },
        { start: 4, end: 5, text: "" },
      ]),
    ).toBe("aXY Zdf");
  });

  it("sorts edits given out of order", () => {
    expect(
      spliceResolved("abcdef", [
        { start: 4, end: 5, text: "E" },
        { start: 0, end: 1, text: "A" },
      ]),
    ).toBe("AbcdEf");
  });

  it("throws on overlapping spans", () => {
    expect(() =>
      spliceResolved("abcdef", [
        { start: 0, end: 3, text: "x" },
        { start: 2, end: 4, text: "y" },
      ]),
    ).toThrow(/overlap/);
  });

  it("throws on a span outside the text", () => {
    expect(() =>
      spliceResolved("abc", [{ start: 1, end: 9, text: "x" }]),
    ).toThrow(/outside the text/);
  });
});

describe("stored forms", () => {
  it("writes a comment anchor into the href", () => {
    expect(
      hrefFor({ kind: "issue", projectId: 7, number: 3, commentId: 9 }),
    ).toBe("/projects/7/issues/3#comment-9");
  });

  it("escapes a bracket in the link text", () => {
    expect(
      linkFor({ kind: "issue", projectId: 7, number: 3 }, "https://x/a[1]"),
    ).toBe("[https://x/a\\[1\\]](/projects/7/issues/3)");
  });
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
