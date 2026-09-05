import { describe, expect, it } from "vitest";
import {
  CLIPBOARD_DEFAULT,
  pastedFilename,
  renameIfClipboardDefault,
} from "../src/lib/pasted-filename.ts";

const file = (name: string) => new File(["bytes"], name, { type: "image/png" });

describe("pastedFilename", () => {
  it("spells the local wall clock, zero-padded", () => {
    // Constructed from local parts, so the assertion holds in any timezone.
    const at = new Date(2026, 8, 5, 21, 45, 30);
    expect(pastedFilename(at, ".png", "a3f9")).toBe(
      "image-20260905-214530-a3f9.png",
    );
  });

  it("pads single-digit months, days and times", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(pastedFilename(at, ".jpeg", "00ff")).toBe(
      "image-20260102-030405-00ff.jpeg",
    );
  });
});

describe("CLIPBOARD_DEFAULT", () => {
  it.each(["image.png", "Image.PNG", "image.jpg", "image.jpeg", "image.avif"])(
    "matches %s",
    (name) => {
      expect(CLIPBOARD_DEFAULT.test(name)).toBe(true);
    },
  );

  it.each(["photo.png", "image.png.txt", "my-image.png", "image.txt", "image"])(
    "leaves %s alone",
    (name) => {
      expect(CLIPBOARD_DEFAULT.test(name)).toBe(false);
    },
  );
});

describe("renameIfClipboardDefault", () => {
  it("renames the browser default and keeps the extension and type", () => {
    const renamed = renameIfClipboardDefault(file("image.png"));
    expect(renamed.name).toMatch(/^image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
    expect(renamed.type).toBe("image/png");
    expect(renamed.size).toBe(5);
  });

  it("keeps the case-variant extension it was given", () => {
    expect(renameIfClipboardDefault(file("Image.JPEG")).name).toMatch(
      /^image-\d{8}-\d{6}-[0-9a-f]{4}\.JPEG$/,
    );
  });

  it("returns a name someone chose unchanged, object identity included", () => {
    const chosen = file("report.pdf");
    expect(renameIfClipboardDefault(chosen)).toBe(chosen);
  });

  it("gives two pastes in the same second different names", () => {
    const names = new Set(
      Array.from(
        { length: 32 },
        () => renameIfClipboardDefault(file("image.png")).name,
      ),
    );
    expect(names.size).toBeGreaterThan(1);
  });
});
