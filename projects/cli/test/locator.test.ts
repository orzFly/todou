import type { ReferenceConfig, ReferenceDirectory } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import {
  checkQualifiedPrefix,
  type LadderInputs,
  resolvePrefixedRef,
} from "../src/locator.ts";

const SINCE = "2026-01-01T00:00:00Z";
const NOW = "2026-06-01T00:00:00Z";
const LATER = "2026-09-01T00:00:00Z";

const AUTOLINK = {
  id: 1,
  prefix: "GH-",
  url_template: "https://github.com/example/repo/issues/<num>",
};

/** `main` writes `T-N`, and used to write `M-N`. */
function mainConfig(over: Partial<ReferenceConfig["format"]> = {}) {
  return {
    format: {
      prefix: "T",
      history: [
        { prefix: "M", effective_from: SINCE },
        { prefix: "T", effective_from: "2026-03-01T00:00:00Z" },
      ],
      ...over,
    },
    autolinks: [AUTOLINK],
  } satisfies ReferenceConfig;
}

/** `sandbox` writes `#N` — no prefix, so it claims nothing globally. */
const SANDBOX_CONFIG: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [],
};

function held(rows: Array<[prefix: string, slug: string]>): ReferenceDirectory {
  return {
    entries: rows.map(([prefix, slug]) => ({
      prefix,
      slug,
      from: SINCE,
      to: null,
    })),
    contested: [],
  };
}

const DIRECTORY = held([
  ["T", "main"],
  ["MU", "muon"],
  ["M", "mirror"],
]);

function inputs(over: Partial<LadderInputs> = {}): LadderInputs {
  return {
    project: "main",
    config: mainConfig(),
    directory: DIRECTORY,
    at: NOW,
    ...over,
  };
}

function fails(
  prefix: string,
  raw: string,
  over: Partial<LadderInputs> = {},
): CliError {
  try {
    resolvePrefixedRef(prefix, raw, inputs(over));
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error(`"${raw}" resolved instead of failing`);
}

describe("resolvePrefixedRef, rung 1: this project's own prefix", () => {
  it("takes the current project without consulting the directory", () => {
    expect(resolvePrefixedRef("T", "T-3", inputs())).toEqual({
      project: "main",
    });
  });

  it("does not admit a retired prefix, which resolves globally instead", () => {
    // `M` was main's prefix until March; letting it match here would be a
    // second resolution rule, disagreeing with the same token in prose.
    expect(resolvePrefixedRef("M", "M-3", inputs())).toEqual({
      project: "mirror",
    });
  });
});

describe("resolvePrefixedRef, rung 2: an autolink prefix", () => {
  it("refuses with the external URL it would have meant", () => {
    const error = fails("GH", "GH-12");
    expect(error.message).toBe(
      '"GH-12" uses the autolink prefix "GH-", which points outside todou',
    );
    expect(error.hint).toBe(
      "autolinks are external links, not todou cards — it resolves to " +
        "https://github.com/example/repo/issues/12",
    );
  });
});

describe("resolvePrefixedRef, rung 3: the cross-project directory", () => {
  it("resolves a sole holder", () => {
    expect(resolvePrefixedRef("MU", "MU-7", inputs())).toEqual({
      project: "muon",
    });
  });

  it("ignores a hold that has lapsed by now", () => {
    const lapsed: ReferenceDirectory = {
      entries: [{ prefix: "CH", slug: "mica", from: SINCE, to: NOW }],
      contested: [],
    };
    expect(fails("CH", "CH-7", { directory: lapsed }).message).toContain(
      'no project uses the prefix "CH"',
    );
    expect(
      resolvePrefixedRef(
        "CH",
        "CH-7",
        inputs({ directory: lapsed, at: SINCE }),
      ),
    ).toEqual({ project: "mica" });
  });

  it("refuses two readable holders, listing both spellings", () => {
    const both = held([
      ["M", "mirror"],
      ["M", "muon"],
    ]);
    const error = fails("M", "M-3", { directory: both });
    expect(error.message).toBe(
      'prefix "M" is used by more than one project (from "M-3")',
    );
    expect(error.hint).toBe("write it qualified: mirror/3 or muon/3");
  });

  it("joins three holders with commas and an or", () => {
    const three = held([
      ["M", "mirror"],
      ["M", "muon"],
      ["M", "mica"],
    ]);
    expect(fails("M", "M-3", { directory: three }).hint).toBe(
      "write it qualified: mica/3, mirror/3, or muon/3",
    );
  });

  it("refuses a contested window even with one readable holder", () => {
    const contested: ReferenceDirectory = {
      ...held([["M", "mirror"]]),
      contested: [{ prefix: "M", from: SINCE, to: null }],
    };
    const error = fails("M", "M-3", { directory: contested });
    // Same first line as two visible holders: to whoever typed it these are
    // one situation, differing only in what can be listed.
    expect(error.message).toBe(
      'prefix "M" is used by more than one project (from "M-3")',
    );
    expect(error.hint).toBe(
      "one of them is not readable to you; write it qualified, e.g. mirror/3",
    );
    expect(`${error.message}${error.hint}`).not.toContain("muon");
  });

  it("refuses a contested window with no readable holder at all", () => {
    const contested: ReferenceDirectory = {
      ...held([]),
      contested: [{ prefix: "M", from: SINCE, to: null }],
    };
    const error = fails("M", "M-3", { directory: contested });
    expect(error.message).toBe(
      'prefix "M" is used by more than one project (from "M-3")',
    );
    expect(error.hint).toBe(
      "one of them is not readable to you; write it as <slug>/3 naming the project you mean",
    );
    expect(`${error.message}${error.hint}`).not.toContain("mirror");
  });
});

describe("resolvePrefixedRef, rung 4: nobody holds it", () => {
  it("suggests a near miss, and nothing else", () => {
    const withFoobar = held([
      ["T", "main"],
      ["FOOBAR", "mica"],
    ]);
    const error = fails("FOO", "FOO-76", { directory: withFoobar });
    expect(error.message).toBe(
      'no project uses the prefix "FOO" (from "FOO-76")',
    );
    expect(error.hint).toBe("did you mean 'FOOBAR-76'?");
  });

  it("otherwise names this project's own spelling and what is in reach", () => {
    const error = fails("FOO", "FOO-76");
    expect(error.message).toBe(
      'no project uses the prefix "FOO" (from "FOO-76")',
    );
    expect(error.hint).toBe(
      'write this project\'s own card as "T-76" or "main/76"; ' +
        "prefixes in reach: M- (mirror), MU- (muon), T- (main)",
    );
  });

  it("caps the list at five and says there are more", () => {
    const many = held([
      ["FF", "p6"],
      ["EE", "p5"],
      ["DD", "p4"],
      ["CC", "p3"],
      ["BB", "p2"],
      ["AA", "p1"],
    ]);
    const hint = fails("ZZZQ", "ZZZQ-1", { directory: many }).hint;
    expect(hint).toContain(
      "prefixes in reach: AA- (p1), BB- (p2), CC- (p3), DD- (p4), EE- (p5), …",
    );
    expect(hint).not.toContain("p6");
  });

  it("leaves a prefix out of the list when it would be refused anyway", () => {
    const shared: ReferenceDirectory = {
      ...held([
        ["A", "alpha"],
        ["M", "bravo"],
        ["M", "charlie"],
      ]),
      contested: [{ prefix: "M", from: SINCE, to: null }],
    };
    const hint = fails("ZZZQ", "ZZZQ-1", { directory: shared }).hint;
    expect(hint).toContain("prefixes in reach: A- (alpha)");
    expect(hint).not.toContain("M-");
  });

  it("takes the directory being unreadable as nobody holding it", () => {
    // The config was readable, so this prefix is known not to be ours;
    // guessing the number against the current project would be wrong.
    expect(fails("FOO", "FOO-1", { directory: null }).message).toBe(
      'no project uses the prefix "FOO" (from "FOO-1")',
    );
  });
});

describe("resolvePrefixedRef without the inputs it wants", () => {
  it("falls back to the current project when the config is unreadable", () => {
    // An old server or a network blip must not fail a command over
    // spelling — this is the pre-T-214 reading, kept for exactly that.
    expect(
      resolvePrefixedRef("FOO", "FOO-1", inputs({ config: null })),
    ).toEqual({ project: "main", loose: true });
  });

  it("still resolves with no current project at all", () => {
    expect(
      resolvePrefixedRef(
        "MU",
        "MU-7",
        inputs({ project: undefined, config: null }),
      ),
    ).toEqual({ project: "muon" });
  });

  it("reports the missing project when the ladder cannot resolve either", () => {
    const error = fails("FOO", "FOO-1", { project: undefined, config: null });
    expect(error.message).toBe("no project selected");
    expect(error.hint).toContain("-p/--project");
  });

  it("still refuses a conflict with no current project", () => {
    const both = held([
      ["M", "mirror"],
      ["M", "muon"],
    ]);
    expect(
      fails("M", "M-3", { project: undefined, config: null, directory: both })
        .hint,
    ).toBe("write it qualified: mirror/3 or muon/3");
  });
});

describe("checkQualifiedPrefix", () => {
  it("admits the project's current prefix and any it ever used", () => {
    expect(() =>
      checkQualifiedPrefix("main", "T", "main/T-76", mainConfig()),
    ).not.toThrow();
    // A ref pasted out of an old commit message is the main reason to type
    // this form, and the slug has already settled which project it is.
    expect(() =>
      checkQualifiedPrefix("main", "M", "main/M-76", mainConfig()),
    ).not.toThrow();
  });

  it("refuses a prefix the named project never wrote", () => {
    const error = (() => {
      try {
        checkQualifiedPrefix("main", "FOO", "main/FOO-76", mainConfig());
      } catch (thrown) {
        return thrown as CliError;
      }
      throw new Error("main/FOO-76 was accepted");
    })();
    expect(error.message).toBe(
      '"main/FOO-76" says prefix "FOO", but project "main" writes its issues as "T-76"',
    );
    expect(error.hint).toBe('write "main/T-76" or "main/76"');
  });

  it("spells the refusal in `#N` for a project with no prefix", () => {
    const error = (() => {
      try {
        checkQualifiedPrefix("sandbox", "FOO", "sandbox/FOO-1", SANDBOX_CONFIG);
      } catch (thrown) {
        return thrown as CliError;
      }
      throw new Error("sandbox/FOO-1 was accepted");
    })();
    expect(error.message).toBe(
      '"sandbox/FOO-1" says prefix "FOO", but project "sandbox" writes its issues as "#1"',
    );
    expect(error.hint).toBe('write "sandbox/#1" or "sandbox/1"');
  });

  it("checks nothing when the config cannot be read", () => {
    expect(() =>
      checkQualifiedPrefix("main", "FOO", "main/FOO-76", null),
    ).not.toThrow();
  });

  it("admits anything in the history without weighing when it applied", () => {
    // No interval arithmetic here on purpose: the slug has already said
    // which project this is, so the prefix is only being sanity-checked.
    const config = mainConfig({
      history: [
        { prefix: "T", effective_from: SINCE },
        { prefix: "Z", effective_from: LATER },
      ],
    });
    expect(() =>
      checkQualifiedPrefix("main", "Z", "main/Z-3", config),
    ).not.toThrow();
  });
});
