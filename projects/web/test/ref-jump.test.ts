import type { ReferenceDirectory } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  couldBeRef,
  couldNameProject,
  foldRefSpelling,
  type JumpCandidate,
  type JumpContext,
  refJumpCandidates,
} from "../src/lib/ref-jump.ts";

/**
 * The same directory the editor's completion tests use: `M` held by mirror,
 * `X` by a project this viewer cannot read, `C` contested — and nobody
 * holding `T`, so this project's own token is the only thing that spells
 * its cards.
 */
const DIRECTORY: ReferenceDirectory = {
  entries: [
    { prefix: "M", slug: "mirror", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "X", slug: "hidden", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "C", slug: "one", from: "2020-01-01T00:00:00.000Z", to: null },
    { prefix: "C", slug: "two", from: "2020-01-01T00:00:00.000Z", to: null },
  ],
  contested: [{ prefix: "C", from: "2020-01-01T00:00:00.000Z", to: null }],
};

const GITHUB = {
  prefix: "GH-",
  url_template: "https://github.com/o/r/issues/<num>",
};

const base: JumpContext = {
  slug: "todou",
  prefix: "T",
  autolinks: [],
  readableSlugs: ["todou", "mirror"],
  directory: DIRECTORY,
  origin: "http://localhost:3000",
};

const issue = (
  slug: string,
  number: number,
  over: Omit<Partial<Extract<JumpCandidate, { kind: "issue" }>>, "kind"> = {},
): JumpCandidate[] => [{ kind: "issue", slug, number, ...over }];

const of = (q: string, over: Partial<JumpContext> = {}) =>
  refJumpCandidates(q, { ...base, ...over });

describe("refJumpCandidates · this project's own card", () => {
  it("takes every spelling of its own number", () => {
    for (const q of [
      "215",
      "#215",
      "T-215",
      // Shift-free, which the box accepted before it understood anything
      // else (T-141) — unlike prose, where the token is case-sensitive.
      "t-215",
      " T-215 ",
      "todou#215",
      "todou/215",
      "todou/#215",
    ]) {
      expect(of(q), q).toEqual(issue("todou", 215));
    }
  });

  it("reads leading zeros as the number, and zero as nothing", () => {
    expect(of("007")).toEqual(issue("todou", 7));
    expect(of("0")).toEqual([]);
  });

  it("keeps the prefix a qualified form wrote, for the query layer to check", () => {
    // `T` is this project's own and will pass; `X` is another project's and
    // will not. Both have to survive the reading — silently dropping the
    // prefix is what T-214 stopped the CLI doing.
    expect(of("todou/T-215")).toEqual(
      issue("todou", 215, { writtenPrefix: "T" }),
    );
    expect(of("todou/X-215")).toEqual(
      issue("todou", 215, { writtenPrefix: "X" }),
    );
  });

  it("reads a bare number and #N when the format is #N too", () => {
    const own = { prefix: null };
    expect(of("#215", own)).toEqual(issue("todou", 215));
    expect(of("215", own)).toEqual(issue("todou", 215));
  });

  it("does not read a foreign-looking prefix as its own", () => {
    // Nobody holds `T` in the directory, so with `#N` in force there is
    // nothing for `T-215` to be.
    expect(of("T-215", { prefix: null })).toEqual([]);
  });

  it("does not resolve a prefix this project has retired", () => {
    // The box asks what a spelling means *now*, like the renderer: a claim
    // that closed when the format changed is not a claim.
    const retired: ReferenceDirectory = {
      ...DIRECTORY,
      entries: [
        ...DIRECTORY.entries,
        {
          prefix: "T",
          slug: "todou",
          from: "2020-01-01T00:00:00.000Z",
          to: "2021-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(of("T-215", { prefix: null, directory: retired })).toEqual([]);
  });
});

describe("refJumpCandidates · another project's card", () => {
  it("resolves a bare prefix with exactly one readable holder", () => {
    expect(of("M-3")).toEqual(issue("mirror", 3));
    expect(of("mirror#3")).toEqual(issue("mirror", 3));
    expect(of("mirror/M-3")).toEqual(
      issue("mirror", 3, { writtenPrefix: "M" }),
    );
  });

  it("offers nothing for a contested, unheld, or unreadable project", () => {
    expect(of("C-4")).toEqual([]);
    expect(of("ZZ-4")).toEqual([]);
    expect(of("hidden#1")).toEqual([]);
    expect(of("nowhere/4")).toEqual([]);
    // `X` has a holder, but not one this viewer may see — so no candidate
    // and therefore no request, which is what keeps its existence secret.
    expect(of("X-215")).toEqual([]);
  });
});

describe("refJumpCandidates · comment anchors", () => {
  it("hangs an anchor off an issue reference", () => {
    expect(of("T-141#comment-1837")).toEqual(
      issue("todou", 141, { commentId: 1837 }),
    );
    expect(of("mirror#3#comment-9")).toEqual(
      issue("mirror", 3, { commentId: 9 }),
    );
  });

  it("reads a bare anchor as a comment whose card is still unknown", () => {
    expect(of("#comment-1837")).toEqual([
      { kind: "comment", slug: "todou", commentId: 1837 },
    ]);
  });
});

describe("refJumpCandidates · pasted URLs", () => {
  it("takes one of ours, with or without an anchor", () => {
    expect(of("http://localhost:3000/projects/mirror/issues/3")).toEqual(
      issue("mirror", 3),
    );
    expect(
      of("http://localhost:3000/projects/mirror/issues/3#comment-9"),
    ).toEqual(issue("mirror", 3, { commentId: 9 }));
  });

  it("leaves anything else to be searched", () => {
    expect(of("https://elsewhere/projects/todou/issues/1")).toEqual([]);
    expect(of("http://localhost:3000/projects/todou/issues/1?x=1")).toEqual([]);
    expect(of("http://localhost:3000/projects/hidden/issues/1")).toEqual([]);
  });
});

describe("refJumpCandidates · autolinks", () => {
  it("offers the external link a rule expands to", () => {
    expect(of("GH-76", { autolinks: [GITHUB] })).toEqual([
      {
        kind: "external",
        href: "https://github.com/o/r/issues/76",
        text: "GH-76",
      },
    ]);
  });

  it("offers both readings when # is the autolink and T- the format", () => {
    // docs/external-trackers.md's recommended mirror setup. Card first,
    // external second; the reader picks.
    const hash = {
      prefix: "#",
      url_template: "https://github.com/o/r/issues/<num>",
    };
    expect(of("#76", { autolinks: [hash] })).toEqual([
      { kind: "issue", slug: "todou", number: 76 },
      {
        kind: "external",
        href: "https://github.com/o/r/issues/76",
        text: "#76",
      },
    ]);
  });
});

describe("refJumpCandidates · the cross-project grammar shut", () => {
  it("resolves nothing foreign, and this project's own numbers as ever", () => {
    expect(of("mirror#3", { directory: null })).toEqual([]);
    expect(of("M-3", { directory: null })).toEqual([]);
    expect(of("#215", { directory: null })).toEqual(issue("todou", 215));
  });
});

describe("refJumpCandidates · ordinary queries", () => {
  it("stays out of the way of anything that is not one whole reference", () => {
    for (const q of ["T-215 折行", "1234567890", "全文搜索", "", "   "]) {
      expect(of(q), q).toEqual([]);
    }
  });
});

describe("foldRefSpelling", () => {
  it("puts each half of a reference in the only case it can have", () => {
    // A slug is all-lower and a prefix all-upper at the schema level, so
    // there is exactly one spelling to fold towards and nothing to guess.
    expect(foldRefSpelling("m-11")).toBe("M-11");
    expect(foldRefSpelling("MIRROR/11")).toBe("mirror/11");
    expect(foldRefSpelling("Mirror#11")).toBe("mirror#11");
    expect(foldRefSpelling("MIRROR/m-11")).toBe("mirror/M-11");
    expect(foldRefSpelling("MIRROR#1#comment-2")).toBe("mirror#1#comment-2");
    expect(foldRefSpelling("MY-PROJ/1")).toBe("my-proj/1");
    // The `-$` half of the lookahead: a prefix waiting for its number.
    expect(foldRefSpelling("acc-")).toBe("ACC-");
    expect(foldRefSpelling("ACCEL/")).toBe("accel/");
  });

  it("leaves alone anything that is not shaped like a reference", () => {
    for (const text of ["#comment-1462", "my-proj-1", "2026-09", "全文搜索"]) {
      expect(foldRefSpelling(text), text).toBe(text);
    }
  });
});

describe("refJumpCandidates · case folding", () => {
  const shifted: Array<[string, JumpCandidate[]]> = [
    ["m-11", issue("mirror", 11)],
    ["MIRROR/11", issue("mirror", 11)],
    ["Mirror/11", issue("mirror", 11)],
    ["MIRROR#11", issue("mirror", 11)],
    ["mirror/m-11", issue("mirror", 11, { writtenPrefix: "M" })],
    ["MIRROR/m-11", issue("mirror", 11, { writtenPrefix: "M" })],
    ["TODOU/1", issue("todou", 1)],
    ["MIRROR#1#comment-2", issue("mirror", 1, { commentId: 2 })],
  ];

  it("reaches the same card the canonical spelling reaches", () => {
    for (const [q, expected] of shifted) expect(of(q), q).toEqual(expected);
  });

  it("folds nothing that already resolved, so no jump moves", () => {
    // The invariant the whole rung rests on: folding is a second attempt
    // after the first found nothing, never a rewrite of the first.
    const lower = { prefix: "GH-", url_template: "https://gh/<num>" };
    expect(of("gh-9", { autolinks: [{ ...lower, prefix: "gh-" }] })).toEqual([
      { kind: "external", href: "https://gh/9", text: "gh-9" },
    ]);
    // Written upper-case, the same query has to be folded to get there —
    // and arrives spelled the way the rule writes it.
    expect(of("gh-9", { autolinks: [lower] })).toEqual([
      { kind: "external", href: "https://gh/9", text: "GH-9" },
    ]);
  });

  it("still offers nothing where the folded spelling names nobody", () => {
    // `covid-19` does fold to `COVID-19`; no project holds `COVID`.
    for (const q of ["covid-19", "my-proj-1", "2026-09", "c-1", "x-215"]) {
      expect(of(q), q).toEqual([]);
    }
  });
});

describe("refJumpCandidates · a project named without a card", () => {
  const project = (slug: string): JumpCandidate[] => [
    { kind: "project", slug },
  ];

  it("takes the four shapes that name a project and stop", () => {
    for (const q of ["M-", "m-", "mirror/", "MIRROR/", "mirror#", "mirror/#"]) {
      expect(of(q), q).toEqual(project("mirror"));
    }
    expect(of("todou/")).toEqual(project("todou"));
  });

  it("says nothing about a project the reader cannot reach", () => {
    // Contested resolves to nothing at all; unreadable is dropped before it
    // could become a request, which is what keeps it a secret (T-150).
    expect(of("C-")).toEqual([]);
    expect(of("X-")).toEqual([]);
    expect(of("hidden/")).toEqual([]);
    expect(of("nowhere/")).toEqual([]);
  });

  it("wants the separator, and leaves a card a card", () => {
    // A bare project name is a perfectly good search term; `sandbox` and
    // `homelab` especially.
    expect(of("mirror")).toEqual([]);
    expect(of("M")).toEqual([]);
    expect(of("M-1")).toEqual(issue("mirror", 1));
  });

  it("stays shut with the cross-project grammar", () => {
    // `mirror/1` does not resolve without a directory either.
    expect(of("mirror/", { directory: null })).toEqual([]);
    expect(of("M-", { directory: null })).toEqual([]);
  });
});

describe("couldNameProject", () => {
  it("passes the shapes Enter has to resolve without any digits", () => {
    for (const q of ["ACC-", "acc-", "accel/", "ACCEL#", "accel/#", " ACC- "]) {
      expect(couldNameProject(q), q).toBe(true);
    }
  });

  it("rejects a card, a bare word, and anything with a space in it", () => {
    for (const q of ["T-215", "accel", "ACC- 部署", "", "   "]) {
      expect(couldNameProject(q), q).toBe(false);
    }
  });
});

describe("couldBeRef", () => {
  it("passes everything the grammar could still resolve", () => {
    for (const q of [
      "215",
      "#215",
      "T-215",
      "todou/X-215",
      "#comment-1837",
      "http://localhost:3000/projects/todou/issues/1",
      // Resolves to nothing, but only the format can say so.
      "bug123",
    ]) {
      expect(couldBeRef(q), q).toBe(true);
    }
  });

  it("rejects what no format could make a reference", () => {
    // Every shape ends in digits and holds no whitespace, which is what
    // lets Enter skip waiting for the project's format on these.
    for (const q of ["全文搜索", "T-215 折行", "WordDiff", "", "   "]) {
      expect(couldBeRef(q), q).toBe(false);
    }
  });
});
