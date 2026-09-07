import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.ts";

describe("GET /api/version", () => {
  it("reports the version publicly, without a session", async () => {
    const t = await makeTestApp();
    try {
      const res = await t.app.request("/api/version");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: string };
      expect(body.version).toBeTypeOf("string");
      expect(body.version.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it("carries the configured public origin", async () => {
    const t = await makeTestApp("shared", {
      extraToml: '[http]\npublic_origin = "https://todou.example"',
    });
    try {
      const res = await t.app.request("/api/version");
      const body = (await res.json()) as { public_origin?: string };
      expect(body.public_origin).toBe("https://todou.example");
    } finally {
      await t.cleanup();
    }
  });

  it("omits the field entirely when no public origin is configured", async () => {
    const t = await makeTestApp();
    try {
      const res = await t.app.request("/api/version");
      // Absent, not null: a client distinguishes "this deployment has none"
      // from "this server predates the field" by the key being missing.
      expect(Object.hasOwn((await res.json()) as object, "public_origin")).toBe(
        false,
      );
    } finally {
      await t.cleanup();
    }
  });
});
