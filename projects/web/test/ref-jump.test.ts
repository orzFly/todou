import type { ReferenceDirectory } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
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
  since: "2020-01-01T00:00:00.000Z",
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
    for (const directory of [null, { ...DIRECTORY, since: null }]) {
      expect(of("mirror#3", { directory })).toEqual([]);
      expect(of("M-3", { directory })).toEqual([]);
      expect(of("#215", { directory })).toEqual(issue("todou", 215));
    }
  });
});

describe("refJumpCandidates · ordinary queries", () => {
  it("stays out of the way of anything that is not one whole reference", () => {
    for (const q of ["T-215 折行", "1234567890", "全文搜索", "", "   "]) {
      expect(of(q), q).toEqual([]);
    }
  });
});
