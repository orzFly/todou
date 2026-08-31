import { describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.ts";
import {
  commandTable,
  guardUnknownCommand,
  normalizeToken,
  osaDistance,
  suggestVerbs,
} from "../src/suggest.ts";

const table = commandTable(commands);

function guard(argv: string[]): string[] | null {
  return guardUnknownCommand(argv, table);
}

describe("osaDistance", () => {
  it("counts single-character slips as one edit", () => {
    expect(osaDistance("statu", "status")).toBe(1);
    expect(osaDistance("isue", "issue")).toBe(1);
    expect(osaDistance("vew", "view")).toBe(1);
  });

  it("counts an adjacent transposition as one edit, not two", () => {
    expect(osaDistance("puhs", "push")).toBe(1);
    expect(osaDistance("lsit", "list")).toBe(1);
  });

  it("keeps a semantic miss far from every real verb", () => {
    // Why `issue update` had to become an alias: no threshold that admits
    // this would still reject unrelated words.
    expect(osaDistance("update", "edit")).toBe(4);
    expect(osaDistance("查看", "view")).toBe(4);
  });

  it("counts truncations by how much was left off", () => {
    expect(osaDistance("ls", "list")).toBe(2);
    expect(osaDistance("del", "delete")).toBe(3);
  });

  it("counts an astral character once, not as its two UTF-16 units", () => {
    // "𠮷".length is 2; Array.from("𠮷").length is 1. Counting units would
    // report 2 here and put every CJK token past its own threshold.
    expect(osaDistance("𠮷", "吉")).toBe(1);
    expect(osaDistance("𠮷野", "吉野")).toBe(1);
    expect(osaDistance("𠮷", "")).toBe(1);
  });

  it("is zero once a full-width spelling is normalized", () => {
    expect(osaDistance(normalizeToken("ｌｉｓｔ"), "list")).toBe(0);
    expect(osaDistance(normalizeToken("LIST"), "list")).toBe(0);
  });
});

describe("suggestVerbs", () => {
  it("admits a distance at the threshold and refuses one past it", () => {
    // "list" is 4 points, so the threshold is 2.
    expect(osaDistance("ls", "list")).toBe(2);
    expect(suggestVerbs("ls", ["list"])).toEqual(["list"]);
    expect(osaDistance("lxyz", "list")).toBe(3);
    expect(suggestVerbs("lxyz", ["list"])).toEqual([]);
  });

  it("admits a truncation the threshold alone would reject", () => {
    expect(osaDistance("del", "delete")).toBeGreaterThan(2);
    expect(suggestVerbs("del", ["delete"])).toEqual(["delete"]);
  });

  it("ignores a single-character prefix", () => {
    expect(suggestVerbs("d", ["delete", "edit"])).toEqual([]);
  });

  it("puts prefixes first, shortest first, then the nearest", () => {
    expect(suggestVerbs("st", ["status", "state", "list"])).toEqual([
      "state",
      "status",
      "list",
    ]);
  });

  it("orders the rest by distance", () => {
    expect(suggestVerbs("lit", ["edit", "list"])).toEqual(["list", "edit"]);
  });

  it("keeps registration order among equals, and stops at three", () => {
    expect(suggestVerbs("lst", ["list", "last", "lost", "lust"])).toEqual([
      "list",
      "last",
      "lost",
    ]);
  });
});

describe("commandTable", () => {
  it("reads the aliases off the registered paths", () => {
    expect(table.get("issue")?.verbs).toEqual([
      "list",
      "create",
      "view",
      "show",
      "events",
      "watch",
      "edit",
      "update",
      "status",
      "move",
      "close",
      "delete",
      "restore",
      "search",
      "comment",
    ]);
  });

  it("marks the first words that run on their own", () => {
    expect(table.get("attach")).toEqual({
      bare: true,
      verbs: ["add", "list", "download"],
    });
    expect(table.get("search")?.bare).toBe(true);
    expect(table.get("issue")?.bare).toBe(false);
  });
});

describe("guardUnknownCommand", () => {
  it("names the one verb a typo was near", () => {
    expect(guard(["issue", "statu"])).toEqual([
      "error: unknown command 'issue statu'",
      "did you mean 'todou issue status'?",
    ]);
    expect(guard(["issue", "vew"])).toEqual([
      "error: unknown command 'issue vew'",
      "did you mean 'todou issue view'?",
    ]);
  });

  it("lists them when a typo is near more than one", () => {
    expect(guard(["issue", "lit"])).toEqual([
      "error: unknown command 'issue lit'",
      "did you mean one of:",
      "  todou issue list",
      "  todou issue edit",
    ]);
  });

  it("resolves a full-width verb to the real one", () => {
    expect(guard(["issue", "ｌｉｓｔ"])).toEqual([
      "error: unknown command 'issue ｌｉｓｔ'",
      "did you mean 'todou issue list'?",
    ]);
  });

  it("falls back to the verb list when nothing is near", () => {
    expect(guard(["issue", "查看"])).toEqual([
      "error: unknown command 'issue 查看'",
      `subcommands of 'issue': ${table.get("issue")?.verbs.join(", ")}`,
    ]);
  });

  it("asks for a subcommand when only the group was named", () => {
    const expected = [
      "error: 'issue' needs a subcommand",
      `subcommands of 'issue': ${table.get("issue")?.verbs.join(", ")}`,
      "run 'todou issue <subcommand> --help' for details",
    ];
    expect(guard(["issue"])).toEqual(expected);
    expect(guard(["issue", "--json"])).toEqual(expected);
  });

  it("corrects a misspelled first word", () => {
    expect(guard(["isue", "list"])).toEqual([
      "error: unknown command 'isue'",
      "did you mean 'todou issue'?",
    ]);
  });

  it("spells out every group when a shared verb was typed alone", () => {
    expect(guard(["list"])).toEqual([
      "error: unknown command 'list'",
      "did you mean one of:",
      "  todou project list",
      "  todou issue list",
      "  todou comment list",
      "  todou question list",
      "  todou spec list",
      "  todou label list",
      "  todou status list",
      "  todou attach list",
    ]);
  });

  it("falls back to the command list for a word nothing resembles", () => {
    expect(guard(["frobnicate"])).toEqual([
      "error: unknown command 'frobnicate'",
      `commands: ${[...table.keys()].join(", ")}`,
      "run 'todou --help' for details",
    ]);
  });

  it("stays out of the way of anything that could still run", () => {
    // A bare-path group's second token may be a filename, a leading flag
    // form is not the guard's to route, and -h belongs to the help builtin.
    expect(guard([])).toBeNull();
    expect(guard(["attach", "lst", "3"])).toBeNull();
    expect(guard(["-h"])).toBeNull();
    expect(guard(["--json", "issue", "lisst"])).toBeNull();
    expect(guard(["issue", "statu", "--help"])).toBeNull();
    expect(guard(["search", "foo"])).toBeNull();
  });

  it("passes every real command through, aliases included", () => {
    expect(guard(["issue", "edit", "3"])).toBeNull();
    expect(guard(["issue", "update", "3"])).toBeNull();
    expect(guard(["issue", "status", "3", "Next"])).toBeNull();
    expect(guard(["issue", "move", "3", "Next"])).toBeNull();
    expect(guard(["comment", "list", "3"])).toBeNull();
    expect(guard(["issue", "search", "term"])).toBeNull();
  });
});
