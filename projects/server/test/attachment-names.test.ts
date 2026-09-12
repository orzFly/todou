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
    expect(splitName("foo.png")).toEqual({ stem: "foo", ext: ".png" });
    expect(splitName("archive.zip")).toEqual({ stem: "archive", ext: ".zip" });
  });

  it("splits twice when a compression suffix follows a data extension", () => {
    expect(splitName("archive.tar.gz")).toEqual({
      stem: "archive",
      ext: ".tar.gz",
    });
    expect(splitName("dump.sql.gz")).toEqual({
      stem: "dump",
      ext: ".sql.gz",
    });
  });

  it("folds case before deciding", () => {
    expect(splitName("ARCHIVE.TAR.GZ")).toEqual({
      stem: "ARCHIVE",
      ext: ".TAR.GZ",
    });
  });

  it("recognises a named compound extension", () => {
    expect(splitName("types.d.ts")).toEqual({ stem: "types", ext: ".d.ts" });
    expect(splitName("bundle.min.js")).toEqual({
      stem: "bundle",
      ext: ".min.js",
    });
  });

  it("keeps the split at the last dot when the first segment is not shaped like one", () => {
    expect(splitName("backup.2026.gz")).toEqual({
      stem: "backup.2026",
      ext: ".gz",
    });
    expect(splitName("截图.gz")).toEqual({ stem: "截图", ext: ".gz" });
  });

  it("does not read an archive format as a compression suffix", () => {
    expect(splitName("foo.bak.zip")).toEqual({ stem: "foo.bak", ext: ".zip" });
  });

  it("needs a stem in front of the pair", () => {
    expect(splitName("dump.gz")).toEqual({ stem: "dump", ext: ".gz" });
    expect(splitName(".tar.gz")).toEqual({ stem: ".tar", ext: ".gz" });
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

  it("puts the id before both segments of a compound extension", () => {
    expect(withIdSuffix("rn178-bench.tar.gz", 2018)).toBe(
      "rn178-bench-2018.tar.gz",
    );
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

  it("walks on with a compound extension still intact", () => {
    const taken = new Set(["rn178-bench.tar.gz", "rn178-bench-2018.tar.gz"]);
    expect(resolveCollision(taken, "rn178-bench.tar.gz", 2018)).toBe(
      "rn178-bench-2018-2.tar.gz",
    );
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
