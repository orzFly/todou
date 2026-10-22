import { describe, expect, it } from "vitest";
import { mimeTypeFor } from "../src/commands/attach.ts";

describe("mimeTypeFor", () => {
  it("labels patches so the web draws them as diffs (T-528)", () => {
    expect(mimeTypeFor("fix.patch")).toBe("text/x-patch");
    expect(mimeTypeFor("out/FIX.DIFF")).toBe("text/x-diff");
  });

  it("leaves unknown extensions generic", () => {
    expect(mimeTypeFor("blob.bin")).toBe("application/octet-stream");
  });
});
