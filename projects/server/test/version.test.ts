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
});
