import { describe, expect, it } from "vitest";
import type { CliConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";
import {
  type AliasRow,
  baseRemainder,
  buildAliasTable,
  coveringBase,
  localizeIssueUrl,
  rewriteServer,
} from "../src/server-alias.ts";

const API = "http://gateway.test/todou";

const ROWS: AliasRow[] = [{ alias: "https://public.test", server: API }];

describe("baseRemainder", () => {
  it("returns the empty remainder for an exact match", () => {
    expect(baseRemainder(API, API)).toBe("");
    expect(baseRemainder("https://public.test", "https://public.test")).toBe(
      "",
    );
  });

  it("returns the rest of the path past the base's prefix", () => {
    expect(baseRemainder(`${API}/projects/p/issues/1`, API)).toBe(
      "/projects/p/issues/1",
    );
  });

  it("keeps the query and the fragment", () => {
    expect(baseRemainder(`${API}/projects/p/issues/1?a=1#comment-2`, API)).toBe(
      "/projects/p/issues/1?a=1#comment-2",
    );
  });

  it("lets an origin-rooted base cover any path on it", () => {
    expect(
      baseRemainder("https://public.test/x/y", "https://public.test"),
    ).toBe("/x/y");
  });

  it("treats the origin root as no path of its own", () => {
    // What the URL `https://public.test/` leaves behind: nothing addressable.
    expect(baseRemainder("https://public.test/", "https://public.test")).toBe(
      "",
    );
  });

  it("refuses a different host", () => {
    expect(
      baseRemainder("https://elsewhere.test/projects/p/issues/1", API),
    ).toBe(null);
  });

  it("refuses a path that only looks like the prefix", () => {
    // A byte-prefix comparison would cover this; the paths are different.
    expect(
      baseRemainder("https://public.test/bar/projects/p/issues/1", "/bar"),
    ).toBeNull();
    expect(
      baseRemainder("http://gateway.test/todoubar/projects/p/issues/1", API),
    ).toBeNull();
  });

  it("refuses a host that only starts with the base's", () => {
    // `https://public.test` must not claim `https://public.test.attacker.test`.
    expect(
      baseRemainder(
        "https://public.test.attacker.test/projects/p/issues/1",
        "https://public.test",
      ),
    ).toBeNull();
  });

  it("refuses a different scheme", () => {
    expect(
      baseRemainder(
        "https://public.test/projects/p/issues/1",
        "http://public.test",
      ),
    ).toBeNull();
  });

  it("normalizes scheme case, host case, and a default port into one base", () => {
    const url = "https://todou.example/projects/p/issues/1";
    expect(baseRemainder(url, "HTTPS://Todou.Example:443")).toBe(
      "/projects/p/issues/1",
    );
    expect(baseRemainder(url, "https://todou.example")).toBe(
      "/projects/p/issues/1",
    );
  });

  it("ignores a trailing slash on either side", () => {
    expect(baseRemainder(`${API}/projects/p/issues/1/`, `${API}/`)).toBe(
      "/projects/p/issues/1/",
    );
    expect(baseRemainder(`https://public.test/`, API)).toBeNull();
  });

  it("does not throw on something that is not a URL", () => {
    expect(baseRemainder("not a url", API)).toBeNull();
    expect(baseRemainder(API, "todou.example")).toBeNull();
  });
});

describe("buildAliasTable", () => {
  it("flattens every entry's instead_of and normalizes both sides", () => {
    const config: CliConfig = {
      default_server: "https://todou.example",
      servers: {
        "http://gateway.test/todou/": {
          tokens: {},
          instead_of: ["https://todou.example/", "https://todou.internal"],
        },
        "https://elsewhere.test": { tokens: {}, instead_of: [] },
      },
      bindings: [],
    };
    expect(buildAliasTable(config)).toEqual([
      { alias: "https://todou.example", server: "http://gateway.test/todou" },
      { alias: "https://todou.internal", server: "http://gateway.test/todou" },
    ]);
  });

  it("is empty for a config with no aliases", () => {
    expect(
      buildAliasTable({
        servers: { "https://todou.example": { tokens: {}, instead_of: [] } },
        bindings: [],
      }),
    ).toEqual([]);
  });
});

describe("rewriteServer", () => {
  it("substitutes the prefix and keeps the remainder", () => {
    expect(
      rewriteServer("https://public.test/projects/p/issues/1", ROWS),
    ).toEqual({
      server: API,
      from: "https://public.test",
    });
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(rewriteServer("https://elsewhere.test/x", ROWS)).toEqual({
      server: "https://elsewhere.test/x",
    });
  });

  it("returns an unparseable input unchanged rather than throwing", () => {
    // `todou login` checks the scheme itself, and a nonsense --server
    // should fail where it is used, not where it is rewritten.
    for (const given of ["not a url", "todou.example", "ftp://x"]) {
      expect(rewriteServer(given, ROWS)).toEqual({ server: given });
    }
  });

  it("lets the longest alias win", () => {
    const table: AliasRow[] = [
      { alias: "https://public.test", server: "http://gateway.test/todou" },
      {
        alias: "https://public.test/staging",
        server: "http://gateway.test/todou-staging",
      },
    ];
    expect(
      rewriteServer("https://public.test/staging/projects/p/issues/1", table),
    ).toEqual({
      server: "http://gateway.test/todou-staging",
      from: "https://public.test/staging",
    });
  });

  it("throws when the winning alias names two different servers", () => {
    const table: AliasRow[] = [
      { alias: "https://public.test", server: "http://gateway.test/todou" },
      { alias: "https://public.test", server: "http://other.test/todou" },
    ];
    expect(() => rewriteServer("https://public.test/x", table)).toThrow(
      CliError,
    );
    expect(() => rewriteServer("https://public.test/x", table)).toThrow(
      /one address cannot be two servers/,
    );
  });

  it("does not mind the same alias twice on one server", () => {
    const table: AliasRow[] = [
      { alias: "https://public.test", server: "http://gateway.test/todou" },
      { alias: "https://public.test", server: "http://gateway.test/todou" },
    ];
    expect(rewriteServer("https://public.test/x", table)).toEqual({
      server: "http://gateway.test/todou",
      from: "https://public.test",
    });
  });

  it("ignores a contradiction no input reaches", () => {
    // A duplicate elsewhere in the file must not break every command.
    const table: AliasRow[] = [
      { alias: "https://public.test", server: "http://gateway.test/todou" },
      { alias: "https://other.test", server: "http://a.test/x" },
      { alias: "https://other.test", server: "http://b.test/x" },
    ];
    expect(rewriteServer("https://public.test/x", table).server).toBe(
      "http://gateway.test/todou",
    );
  });
});

describe("coveringBase", () => {
  const bases = [API, "https://public.test"];

  it("returns the covering base itself", () => {
    // The base, not its remainder: this is what an error message names and
    // what `localizeIssueUrl` then takes the remainder of, so the two can
    // never disagree about which base claimed the URL.
    expect(coveringBase("https://public.test/projects/p/issues/1", bases)).toBe(
      "https://public.test",
    );
    expect(coveringBase(`${API}/projects/p/issues/1`, bases)).toBe(API);
  });

  it("returns null when nothing covers", () => {
    expect(coveringBase("https://elsewhere.test/x", bases)).toBeNull();
    expect(coveringBase("not a url", bases)).toBeNull();
  });

  it("returns the longest covering base, normalized", () => {
    expect(
      coveringBase("https://public.test/s/projects/p/issues/1", [
        "https://public.test",
        "https://public.test/s/",
      ]),
    ).toBe("https://public.test/s");
  });
});

describe("localizeIssueUrl", () => {
  const bases = [API, "https://public.test"];

  it("localizes a URL at an alias, fragment and query kept", () => {
    expect(
      localizeIssueUrl(
        "https://public.test/projects/p/issues/159#comment-3721",
        bases,
      ),
    ).toBe("/projects/p/issues/159#comment-3721");
    expect(
      localizeIssueUrl(
        "https://public.test/projects/p/issues/159?a=1#comment-3721",
        bases,
      ),
    ).toBe("/projects/p/issues/159?a=1#comment-3721");
  });

  it("localizes a URL at the active base, mount prefix and all", () => {
    expect(localizeIssueUrl(`${API}/projects/p/issues/159`, bases)).toBe(
      "/projects/p/issues/159",
    );
  });

  it("returns null for an origin no base covers", () => {
    expect(
      localizeIssueUrl("https://elsewhere.test/projects/p/issues/1", bases),
    ).toBeNull();
  });

  it("returns the empty string for the base root itself", () => {
    // The caller branches on this: covered, but naming no issue.
    expect(localizeIssueUrl("https://public.test", bases)).toBe("");
    expect(localizeIssueUrl("https://public.test/", bases)).toBe("");
    expect(localizeIssueUrl(API, bases)).toBe("");
  });

  it("returns null when no base is configured", () => {
    expect(localizeIssueUrl("https://public.test/x", [])).toBeNull();
  });

  it("lets the longest base win", () => {
    expect(
      localizeIssueUrl("https://public.test/s/projects/p/issues/1", [
        "https://public.test",
        "https://public.test/s",
      ]),
    ).toBe("/projects/p/issues/1");
  });
});
