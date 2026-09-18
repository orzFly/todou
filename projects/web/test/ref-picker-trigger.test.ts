import type { PrefixDirectory } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  parsesAsRef,
  pickerTriggerAt,
  type RefTriggerContext,
} from "../src/lib/ref-completion.ts";

const directory: PrefixDirectory = {
  entries: [
    {
      prefix: "M",
      slug: "mirror",
      from: "2020-01-01T00:00:00.000Z",
      to: null,
    },
  ],
  contested: [],
};

const context: RefTriggerContext = {
  slug: "todou",
  prefix: "T",
  readableSlugs: ["todou", "mirror"],
  directory,
  autolinks: [],
};

const origin = "https://todou.example";

describe("pickerTriggerAt", () => {
  it.each([
    [
      "",
      {
        kind: "cards",
        slug: "todou",
        query: "",
        anchor: "T-",
        fromShape: false,
      },
    ],
    [
      "37",
      {
        kind: "cards",
        slug: "todou",
        query: "37",
        anchor: "T-",
        fromShape: true,
      },
    ],
    [
      "#37",
      {
        kind: "cards",
        slug: "todou",
        query: "37",
        anchor: "T-",
        fromShape: true,
      },
    ],
    [
      "T-3",
      {
        kind: "cards",
        slug: "todou",
        query: "3",
        anchor: "T-",
        fromShape: true,
      },
    ],
    [
      "mirror/3",
      {
        kind: "cards",
        slug: "mirror",
        query: "3",
        anchor: "mirror/",
        fromShape: true,
      },
    ],
    [
      "mirror#3",
      {
        kind: "cards",
        slug: "mirror",
        query: "3",
        anchor: "mirror#",
        fromShape: true,
      },
    ],
    [
      "mirror/侧栏",
      {
        kind: "cards",
        slug: "mirror",
        query: "侧栏",
        anchor: "mirror/",
        fromShape: true,
      },
    ],
    [
      "侧栏",
      {
        kind: "cards",
        slug: "todou",
        query: "侧栏",
        anchor: "T-",
        fromShape: false,
      },
    ],
    [
      "mir",
      {
        kind: "cards",
        slug: "todou",
        query: "mir",
        anchor: "T-",
        fromShape: false,
      },
    ],
    ["/projects/7/issues/12", { kind: "raw" }],
    ["https://todou.example/projects/7/issues/12", { kind: "raw" }],
    ["unknown/3", { kind: "raw" }],
  ] as const)("classifies %j", (value, expected) => {
    expect(pickerTriggerAt(value, context, origin)).toEqual(expected);
  });

  it("accepts exactly the ref shapes the server resolver accepts", () => {
    expect(parsesAsRef("37", origin)).toBe(true);
    expect(parsesAsRef("#37", origin)).toBe(true);
    expect(parsesAsRef("T-37", origin)).toBe(true);
    expect(parsesAsRef("mirror#37", origin)).toBe(true);
    expect(parsesAsRef("/projects/7/issues/12", origin)).toBe(true);
    expect(
      parsesAsRef("https://todou.example/projects/7/issues/12", origin),
    ).toBe(true);
    expect(
      parsesAsRef("https://elsewhere.example/projects/7/issues/12", origin),
    ).toBe(false);
    expect(parsesAsRef("侧栏", origin)).toBe(false);
  });
});
