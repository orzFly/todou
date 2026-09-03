import { describe, expect, it } from "vitest";
import {
  parseRefLocator,
  resolveClaim,
  resolveSlugAt,
  type ScanConfig,
  type SlugClaim,
  scanReferenceTokens,
} from "../src/references-grammar.ts";

const SINCE = "2026-01-01T00:00:00Z";
const AFTER = "2026-06-01T00:00:00Z";
const BEFORE = "2025-06-01T00:00:00Z";

const DIRECTORY = {
  entries: [{ prefix: "T", slug: "todou", from: SINCE, to: null }],
  contested: [],
};

function crossConfig(over: Partial<ScanConfig> = {}): ScanConfig {
  return {
    internalPrefix: null,
    cross: {
      slugs: ["todou", "mirror"],
      directory: DIRECTORY,
      since: SINCE,
      at: AFTER,
    },
    ...over,
  };
}

type Ref = { slug: string | null; number: number; commentId?: number };

function refs(text: string, config: ScanConfig): Ref[] {
  return scanReferenceTokens(text, config).flatMap((token) =>
    token.type === "issue"
      ? [
          {
            slug: token.slug,
            number: token.number,
            ...(token.commentId === undefined
              ? {}
              : { commentId: token.commentId }),
          },
        ]
      : [],
  );
}

function rendered(text: string, config: ScanConfig): string {
  return scanReferenceTokens(text, config)
    .map((token) => token.text)
    .join("");
}

describe("scanReferenceTokens without cross input", () => {
  it("reproduces the #N grammar", () => {
    expect(
      refs("see #12 and #13, not #12 again", { internalPrefix: null }),
    ).toEqual([
      { slug: null, number: 12 },
      { slug: null, number: 13 },
      { slug: null, number: 12 },
    ]);
    expect(refs("channel#4chat", { internalPrefix: null })).toEqual([]);
    expect(refs("#7 first", { internalPrefix: null })).toEqual([
      { slug: null, number: 7 },
    ]);
  });

  it("reproduces the PREFIX-N grammar and its boundaries", () => {
    const config = { internalPrefix: "T" };
    expect(refs("fixes T-76, see T-9", config)).toEqual([
      { slug: null, number: 76 },
      { slug: null, number: 9 },
    ]);
    expect(refs("SOME-T-76", config)).toEqual([]);
    expect(refs("xT-76", config)).toEqual([]);
    expect(refs("see #12", config)).toEqual([]);
    expect(refs("fixes T-76", { internalPrefix: null })).toEqual([]);
    expect(refs("t-76", config)).toEqual([]);
    expect(refs("T-1234567890", config)).toEqual([]);
    expect(refs("FOOBAR-8?", { internalPrefix: "FOOBAR" })).toEqual([
      { slug: null, number: 8 },
    ]);
  });

  it("leaves autolink tokens to the autolink rules, in order", () => {
    const config: ScanConfig = {
      internalPrefix: "T",
      autolinks: [
        { prefix: "GH-", url_template: "https://example.com/gh/<num>" },
        { prefix: "#", url_template: "https://example.com/hash/<num>" },
      ],
    };
    expect(scanReferenceTokens("T-1 GH-2 #3", config)).toEqual([
      { type: "issue", slug: null, number: 1, start: 0, end: 3, text: "T-1" },
      { type: "text", start: 3, end: 4, text: " " },
      {
        type: "autolink",
        href: "https://example.com/gh/2",
        start: 4,
        end: 8,
        text: "GH-2",
      },
      { type: "text", start: 8, end: 9, text: " " },
      {
        type: "autolink",
        href: "https://example.com/hash/3",
        start: 9,
        end: 11,
        text: "#3",
      },
    ]);
  });

  it("keeps the new syntax dark", () => {
    const config = { internalPrefix: "T" };
    expect(refs("todou/T-12", config)).toEqual([{ slug: null, number: 12 }]);
    expect(refs("todou#12", { internalPrefix: null })).toEqual([]);
    expect(refs("#comment-99", { internalPrefix: null })).toEqual([]);
  });
});

describe("qualified cross-project forms", () => {
  it("accepts all four spellings as one meaning", () => {
    for (const written of ["todou#12", "todou/12", "todou/T-12", "todou/#12"]) {
      expect(refs(`see ${written} here`, crossConfig())).toEqual([
        { slug: "todou", number: 12 },
      ]);
    }
  });

  it("does not check the written prefix, only its shape", () => {
    expect(refs("todou/NOPE-12", crossConfig())).toEqual([
      { slug: "todou", number: 12 },
    ]);
    expect(refs("todou/nope-12", crossConfig())).toEqual([]);
  });

  it("outranks this project's own format", () => {
    expect(refs("todou/T-12", crossConfig({ internalPrefix: "T" }))).toEqual([
      { slug: "todou", number: 12 },
    ]);
  });

  it("swallows an unknown project rather than falling back to a local ref", () => {
    const config = crossConfig({ internalPrefix: "T" });
    expect(refs("nowhere/T-12", config)).toEqual([]);
    expect(rendered("nowhere/T-12", config)).toBe("nowhere/T-12");
  });

  it("needs the usual left boundary", () => {
    expect(refs("xtodou#12", crossConfig())).toEqual([]);
    expect(refs("SOME-todou#12", crossConfig())).toEqual([]);
  });
});

describe("bare foreign prefixes", () => {
  it("resolves through a single holder", () => {
    expect(refs("fixes T-12", crossConfig())).toEqual([
      { slug: "todou", number: 12 },
    ]);
  });

  it("stays text with no holder or several", () => {
    expect(refs("fixes X-12", crossConfig())).toEqual([]);
    const contested = crossConfig();
    expect(
      refs("fixes T-12", {
        ...contested,
        cross: {
          ...contested.cross,
          slugs: ["todou"],
          directory: {
            entries: DIRECTORY.entries,
            contested: [{ prefix: "T", from: SINCE, to: null }],
          },
        },
      }),
    ).toEqual([]);
  });

  it("never shadows this project's own format", () => {
    expect(refs("fixes T-12", crossConfig({ internalPrefix: "T" }))).toEqual([
      { slug: null, number: 12 },
    ]);
  });

  it("yields to an autolink claiming the same token", () => {
    const config = crossConfig({
      autolinks: [
        { prefix: "T-", url_template: "https://example.com/t/<num>" },
      ],
    });
    expect(refs("fixes T-12", config)).toEqual([]);
    expect(scanReferenceTokens("T-12", config)[0]).toMatchObject({
      type: "autolink",
      href: "https://example.com/t/12",
    });
  });

  it("stays text without a directory", () => {
    const config = crossConfig();
    expect(
      refs("fixes T-12", {
        ...config,
        cross: { slugs: ["todou"], since: SINCE, at: AFTER },
      }),
    ).toEqual([]);
  });
});

describe("comment anchors", () => {
  it("binds to the issue token in front of it", () => {
    expect(refs("todou/T-12#comment-99", crossConfig())).toEqual([
      { slug: "todou", number: 12, commentId: 99 },
    ]);
    expect(refs("#12#comment-99", crossConfig())).toEqual([
      { slug: null, number: 12, commentId: 99 },
    ]);
    expect(
      refs("T-12#comment-99", crossConfig({ internalPrefix: "T" })),
    ).toEqual([{ slug: null, number: 12, commentId: 99 }]);
  });

  it("stands alone for this project", () => {
    expect(scanReferenceTokens("see #comment-99", crossConfig())).toEqual([
      { type: "text", start: 0, end: 4, text: "see " },
      {
        type: "comment",
        commentId: 99,
        start: 4,
        end: 15,
        text: "#comment-99",
      },
    ]);
  });

  it("outranks an autolink of the same shape", () => {
    const config = crossConfig({
      autolinks: [
        { prefix: "comment-", url_template: "https://example.com/c/<num>" },
      ],
    });
    expect(scanReferenceTokens("#comment-99", config)[0]).toMatchObject({
      type: "comment",
      commentId: 99,
    });
  });

  it("leaves a malformed suffix as text behind the issue ref", () => {
    expect(scanReferenceTokens("todou#12#comment-x", crossConfig())).toEqual([
      {
        type: "issue",
        slug: "todou",
        number: 12,
        start: 0,
        end: 8,
        text: "todou#12",
      },
      { type: "text", start: 8, end: 18, text: "#comment-x" },
    ]);
  });
});

describe("the cross-syntax cutoff", () => {
  it("stays closed for content written before it", () => {
    const config = crossConfig({ internalPrefix: "T" });
    const pre: ScanConfig = {
      ...config,
      cross: { ...config.cross, slugs: ["todou"], since: SINCE, at: BEFORE },
    };
    expect(refs("todou/T-12", pre)).toEqual([{ slug: null, number: 12 }]);
    expect(refs("#comment-99", pre)).toEqual([]);
  });

  it("fails closed when the cutoff is unknown", () => {
    const config = crossConfig();
    expect(
      refs("todou#12", {
        ...config,
        cross: { slugs: ["todou"], since: null, at: AFTER },
      }),
    ).toEqual([]);
  });
});

describe("token stream integrity", () => {
  it("covers the input exactly, whatever the config", () => {
    const text = "a todou#12 b T-3 c #comment-9 d GH-4 e nowhere/T-1 f";
    for (const config of [
      { internalPrefix: null },
      { internalPrefix: "T" },
      crossConfig(),
      crossConfig({ internalPrefix: "T" }),
      crossConfig({
        autolinks: [
          { prefix: "GH-", url_template: "https://example.com/<num>" },
        ],
      }),
    ]) {
      expect(rendered(text, config)).toBe(text);
    }
  });
});

describe("resolveClaim", () => {
  const entries = [
    {
      prefix: "T",
      slug: "todou",
      from: "2026-01-01T00:00:00Z",
      to: "2026-03-01T00:00:00Z",
    },
    { prefix: "T", slug: "mirror", from: "2026-03-01T00:00:00Z", to: null },
  ];

  it("treats a hold as [from, to)", () => {
    expect(resolveClaim(entries, [], "T", "2026-01-01T00:00:00Z")).toBe(
      "todou",
    );
    expect(resolveClaim(entries, [], "T", "2026-02-28T23:59:59Z")).toBe(
      "todou",
    );
    expect(resolveClaim(entries, [], "T", "2026-03-01T00:00:00Z")).toBe(
      "mirror",
    );
    expect(resolveClaim(entries, [], "T", "2025-12-31T23:59:59Z")).toBeNull();
  });

  it("declines overlapping and contested windows", () => {
    const overlap = [
      { prefix: "T", slug: "todou", from: SINCE, to: null },
      { prefix: "T", slug: "mirror", from: SINCE, to: null },
    ];
    expect(resolveClaim(overlap, [], "T", AFTER)).toBeNull();
    expect(
      resolveClaim(
        [{ prefix: "T", slug: "todou", from: SINCE, to: null }],
        [{ prefix: "T", from: SINCE, to: null }],
        "T",
        AFTER,
      ),
    ).toBeNull();
  });
});

const T1 = "2026-02-01T00:00:00Z";
const BETWEEN = "2026-03-01T00:00:00Z";
const T2 = "2026-04-01T00:00:00Z";

/**
 * Two shapes at once: `oldname` was retired and nobody took it, while
 * `handover` changed hands at T2 — the project that held it renamed itself
 * to `todou` and another took the spelling over.
 */
const SLUG_ENTRIES: SlugClaim[] = [
  { slug: "oldname", canonical: "todou", from: T1, to: T2 },
  { slug: "handover", canonical: "todou", from: T1, to: T2 },
  { slug: "todou", canonical: "todou", from: T2, to: null },
  { slug: "handover", canonical: "handover", from: T2, to: null },
];

function historyConfig(at: string, entries = SLUG_ENTRIES): ScanConfig {
  return {
    internalPrefix: null,
    cross: {
      slugs: ["todou", "handover"],
      since: SINCE,
      at,
      slugEntries: entries,
    },
  };
}

describe("qualified forms through slug history", () => {
  it("resolves a retired spelling to the project that held it", () => {
    expect(refs("see oldname#12", historyConfig(BETWEEN))).toEqual([
      { slug: "todou", number: 12 },
    ]);
  });

  it("follows a reused slug across the handover", () => {
    expect(refs("handover#12", historyConfig(BETWEEN))).toEqual([
      { slug: "todou", number: 12 },
    ]);
    expect(refs("handover#12", historyConfig(AFTER))).toEqual([
      { slug: "handover", number: 12 },
    ]);
  });

  it("resolves an unclaimed old spelling to its last holder", () => {
    expect(refs("oldname#12", historyConfig(AFTER))).toEqual([
      { slug: "todou", number: 12 },
    ]);
  });

  it("still resolves content older than the project's current slug", () => {
    expect(refs("todou#12", historyConfig(T1))).toEqual([
      { slug: "todou", number: 12 },
    ]);
  });

  it("stays literal for a slug nobody ever held", () => {
    expect(refs("nowhere#12", historyConfig(AFTER))).toEqual([]);
    expect(rendered("nowhere#12", historyConfig(AFTER))).toBe("nowhere#12");
  });

  it("normalises the token while leaving the author's spelling alone", () => {
    expect(scanReferenceTokens("oldname/T-12", historyConfig(AFTER))).toEqual([
      {
        type: "issue",
        slug: "todou",
        number: 12,
        start: 0,
        end: 12,
        text: "oldname/T-12",
      },
    ]);
  });

  it("falls back to the slug set with no history to consult", () => {
    expect(refs("oldname#12", historyConfig(AFTER, []))).toEqual([]);
    expect(refs("todou#12", historyConfig(AFTER, []))).toEqual([
      { slug: "todou", number: 12 },
    ]);
    const config = crossConfig();
    expect(refs("oldname#12", config)).toEqual([]);
    expect(refs("todou#12", config)).toEqual([{ slug: "todou", number: 12 }]);
  });
});

describe("resolveSlugAt", () => {
  it("prefers the holder at the time over the current one", () => {
    expect(
      resolveSlugAt(SLUG_ENTRIES, ["todou", "handover"], "handover", BETWEEN),
    ).toBe("todou");
    expect(
      resolveSlugAt(SLUG_ENTRIES, ["todou", "handover"], "handover", AFTER),
    ).toBe("handover");
  });

  it("treats a hold as [from, to)", () => {
    expect(resolveSlugAt(SLUG_ENTRIES, [], "handover", T1)).toBe("todou");
    expect(resolveSlugAt(SLUG_ENTRIES, [], "handover", T2)).toBe("handover");
  });

  it("falls through to the current holder, then the last one", () => {
    expect(resolveSlugAt(SLUG_ENTRIES, ["todou"], "todou", BEFORE)).toBe(
      "todou",
    );
    expect(resolveSlugAt(SLUG_ENTRIES, [], "oldname", AFTER)).toBe("todou");
    expect(resolveSlugAt(SLUG_ENTRIES, [], "nowhere", AFTER)).toBeNull();
  });

  it("still resolves a live slug when the timestamp is unusable", () => {
    expect(resolveSlugAt(SLUG_ENTRIES, ["todou"], "todou", "not a date")).toBe(
      "todou",
    );
  });
});

describe("parseRefLocator (T-214)", () => {
  it("reads a bare prefix off the whole argument", () => {
    expect(parseRefLocator("T-76")).toEqual({
      kind: "prefixed",
      prefix: "T",
      number: 76,
    });
    expect(parseRefLocator("FOOBAR-8")).toEqual({
      kind: "prefixed",
      prefix: "FOOBAR",
      number: 8,
    });
    expect(parseRefLocator("A_2X-9")).toEqual({
      kind: "prefixed",
      prefix: "A_2X",
      number: 9,
    });
  });

  it("reads all four qualified spellings, carrying the prefix", () => {
    const bare = { kind: "qualified", slug: "todou", number: 16, prefix: null };
    expect(parseRefLocator("todou/16")).toEqual(bare);
    expect(parseRefLocator("todou#16")).toEqual(bare);
    expect(parseRefLocator("todou/#16")).toEqual(bare);
    expect(parseRefLocator("todou/T-76")).toEqual({
      kind: "qualified",
      slug: "todou",
      number: 76,
      prefix: "T",
    });
  });

  it.each([
    // The first two are deliberately uncovered: no shape question to answer,
    // and the CLI's own parser takes numbers past the nine-digit cap here.
    "16",
    "#16",
    "t-76",
    "2T-76",
    "T-",
    "T-1234567890",
    "T-76x",
    "todou/",
    "todou/abc",
    "TODOU/16",
    "todou/1234567890",
    // A locator is one whole argument; a comment anchor is not part of it.
    "todou#16#comment-3",
  ])('reads nothing out of "%s"', (value) => {
    expect(parseRefLocator(value)).toBeNull();
  });
});
