import type * as util from "node:util";
import { type Cases, equal } from "./assert.ts";

export const cases: Cases<typeof util> = {
  "styleText nests like Node": async (mod) => {
    const style = (format: Parameters<typeof mod.styleText>[0], text: string) =>
      mod.styleText(format, text, { validateStream: false });
    equal(style("bold", "x"), "\u001b[1mx\u001b[22m", "bold");
    equal(
      style(["bold", "red"], "x"),
      "\u001b[1m\u001b[31mx\u001b[39m\u001b[22m",
      "two",
    );
    equal(
      style("dim", "a\u001b[22mb"),
      "\u001b[2ma\u001b[22m\u001b[2mb\u001b[22m",
      "22 kept",
    );
    equal(
      style("red", "a\u001b[39mb"),
      "\u001b[31ma\u001b[31mb\u001b[39m",
      "39 replaced",
    );
    equal(
      style("red", "a\u001b[39m"),
      "\u001b[31ma\u001b[39m\u001b[39m",
      "close at end",
    );
    equal(style("cyan", ""), "\u001b[36m\u001b[39m", "empty");
  },

  "isDeepStrictEqual on parsed TOML shapes": async (mod) => {
    equal(
      mod.isDeepStrictEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] }),
      true,
      "equal",
    );
    equal(
      mod.isDeepStrictEqual({ a: 1 }, { a: 1, b: undefined }),
      false,
      "extra key",
    );
    equal(mod.isDeepStrictEqual([1, 2], [2, 1]), false, "order");
    equal(mod.isDeepStrictEqual({ a: 1 }, { a: "1" }), false, "type");
    equal(mod.isDeepStrictEqual(new Date(5), new Date(5)), true, "dates");
    equal(mod.isDeepStrictEqual(Number.NaN, Number.NaN), true, "NaN");
  },
};
