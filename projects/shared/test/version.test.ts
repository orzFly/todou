import { describe, expect, it, vi } from "vitest";
import { createVersionResolver, resolveVersion } from "../src/version.ts";

describe("createVersionResolver", () => {
  it("short-circuits on an injected build version without running git", () => {
    const exec = vi.fn(() => "v9.9.9-1-gdeadbee");
    const resolve = createVersionResolver({ buildVersion: "v1.2.3", exec });
    expect(resolve()).toBe("v1.2.3");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to the exec output, trimmed", () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: () => "v0.1.0-49-g79b2ac8\n",
    });
    expect(resolve()).toBe("v0.1.0-49-g79b2ac8");
  });

  it("returns unknown when the exec fails", () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: () => {
        throw new Error("git: not found");
      },
    });
    expect(resolve()).toBe("unknown");
  });

  it("returns unknown when the exec output is empty", () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: () => "",
    });
    expect(resolve()).toBe("unknown");
  });

  it("memoizes: repeated calls run the exec once", () => {
    const exec = vi.fn(() => "v0.1.0-49-g79b2ac8");
    const resolve = createVersionResolver({ buildVersion: null, exec });
    expect(resolve()).toBe(resolve());
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("resolveVersion", () => {
  it("produces a non-empty string in this checkout", () => {
    // In the repo, git describe should win; anywhere else the unknown
    // fallback still satisfies the contract.
    expect(resolveVersion()).toMatch(/^(v?\d|[0-9a-f]{7,}|unknown)/);
  });
});
