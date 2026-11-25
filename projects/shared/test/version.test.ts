import { describe, expect, it, vi } from "vitest";
import { createVersionResolver, resolveVersion } from "../src/version.ts";

describe("createVersionResolver", () => {
  it("short-circuits on an injected build version without running git", async () => {
    const exec = vi.fn(async () => "v9.9.9-1-gdeadbee");
    const resolve = createVersionResolver({ buildVersion: "v1.2.3", exec });
    expect(await resolve()).toBe("v1.2.3");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to the exec output, trimmed", async () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: async () => "v0.1.0-49-g79b2ac8\n",
    });
    expect(await resolve()).toBe("v0.1.0-49-g79b2ac8");
  });

  it("returns unknown when the exec fails", async () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: async () => {
        throw new Error("git: not found");
      },
    });
    expect(await resolve()).toBe("unknown");
  });

  it("returns unknown when the exec output is empty", async () => {
    const resolve = createVersionResolver({
      buildVersion: null,
      exec: async () => "",
    });
    expect(await resolve()).toBe("unknown");
  });

  it("memoizes: repeated calls run the exec once", async () => {
    const exec = vi.fn(async () => "v0.1.0-49-g79b2ac8");
    const resolve = createVersionResolver({ buildVersion: null, exec });
    expect(await resolve()).toBe(await resolve());
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe("resolveVersion", () => {
  it("produces a non-empty string in this checkout", async () => {
    // In the repo, git describe should win; anywhere else the unknown
    // fallback still satisfies the contract.
    expect(await resolveVersion()).toMatch(/^(v?\d|[0-9a-f]{7,}|unknown)/);
  });
});
