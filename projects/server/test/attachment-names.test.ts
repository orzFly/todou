import { describe, expect, it } from "vitest";
import {
  nameKey,
  resolveCollision,
  sanitizeFilename,
  splitName,
  withIdSuffix,
} from "../src/services/attachment-names.ts";

const composed = "café.png".normalize("NFC");
const decomposed = composed.normalize("NFD");

describe("sanitizeFilename", () => {
  it("leaves CJK and accented names alone, in NFC", () => {
    expect(sanitizeFilename("截图-最终版.png")).toBe("截图-最终版.png");
    expect(decomposed).not.toBe(composed);
    expect(sanitizeFilename(decomposed)).toBe(composed);
  });
});

describe("splitName", () => {
  it("splits at the last dot", () => {
    expect(splitName("archive.tar.gz")).toEqual({
      stem: "archive.tar",
      ext: ".gz",
    });
    expect(splitName("foo.png")).toEqual({ stem: "foo", ext: ".png" });
  });

  it("treats a leading dot as part of the stem", () => {
    expect(splitName(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });

  it("gives an extensionless name an empty ext", () => {
    expect(splitName("README")).toEqual({ stem: "README", ext: "" });
  });
});

describe("nameKey", () => {
  it("folds case", () => {
    expect(nameKey("Foo.PNG")).toBe(nameKey("foo.png"));
  });

  it("folds composed and decomposed spellings together", () => {
    expect(nameKey(decomposed)).toBe(nameKey(composed));
  });
});

describe("withIdSuffix", () => {
  it("puts the id before the extension, or at the end without one", () => {
    expect(withIdSuffix("foo.png", 813)).toBe("foo-813.png");
    expect(withIdSuffix("README", 815)).toBe("README-815");
    expect(withIdSuffix(".gitignore", 19)).toBe(".gitignore-19");
  });
});

describe("resolveCollision", () => {
  it("appends the id", () => {
    expect(resolveCollision(new Set(["foo.png"]), "foo.png", 13)).toBe(
      "foo-13.png",
    );
  });

  it("walks on when the id-suffixed name is itself taken", () => {
    const taken = new Set(["foo.png", "foo-13.png"]);
    expect(resolveCollision(taken, "foo.png", 13)).toBe("foo-13-2.png");
  });

  it("keeps walking past a taken -2", () => {
    const taken = new Set(["foo.png", "foo-13.png", "foo-13-2.png"]);
    expect(resolveCollision(taken, "foo.png", 13)).toBe("foo-13-3.png");
  });

  it("measures the taken set with the same fold as the index", () => {
    expect(resolveCollision(new Set(["foo-13.png"]), "FOO.PNG", 13)).toBe(
      "FOO-13-2.PNG",
    );
  });
});
