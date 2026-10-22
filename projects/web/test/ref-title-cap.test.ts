import { describe, expect, it } from "vitest";
import { cutTitle } from "../src/lib/ref-title-cap.ts";

// One pixel per UTF-16 unit is enough to see where the cut lands.
const measure = (text: string) => text.length;

describe("cutTitle (T-541)", () => {
  it("leaves a title that fits whole", () => {
    expect(cutTitle("short", measure, 5, 1)).toBeNull();
  });

  it("keeps the longest head that fits with its ellipsis", () => {
    const cut = cutTitle("abcdefghij", measure, 6, 1);
    expect(cut).toEqual({ head: "abcde", rest: "fghij" });
  });

  it("does not end the head on a space", () => {
    const cut = cutTitle("abc defghij", measure, 5, 1);
    expect(cut).toEqual({ head: "abc", rest: " defghij" });
  });

  it("never splits a grapheme cluster", () => {
    // A family emoji is one cluster of eight UTF-16 units.
    const family = "👨‍👩‍👧";
    const cut = cutTitle(`ab${family}cdef`, measure, 6, 1);
    expect(cut?.head).toBe("ab");
    expect(cut?.rest).toBe(`${family}cdef`);
  });

  it("reassembles the title from head and rest", () => {
    const title = "自定义主题编辑器：每一侧的基础主题";
    const cut = cutTitle(title, measure, 8, 1);
    expect(cut && cut.head + cut.rest).toBe(title);
  });
});
