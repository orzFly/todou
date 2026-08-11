import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

const INDEX_HTML = '<!doctype html><title>todou</title><div id="root"></div>';
const ASSET_JS = "console.log('todou')";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Stands in for `pnpm --filter @todou/web build` output. */
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "todou-dist-"));
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc123.js"), ASSET_JS);
  return dir;
}

describe("web app serving", () => {
  describe("without static_dir", () => {
    let harness: TestApp;

    beforeAll(async () => {
      harness = await makeTestApp();
    });
    afterAll(() => harness.cleanup());

    it("serves nothing at the root", async () => {
      const res = await harness.app.request("/");
      expect(res.status).toBe(404);
    });

    it("still serves the API", async () => {
      const res = await harness.app.request("/api/openapi.json");
      expect(res.status).toBe(200);
    });
  });

  describe("with static_dir", () => {
    let harness: TestApp;

    beforeAll(async () => {
      harness = await makeTestApp("shared", { staticDir: fakeDist() });
    });
    afterAll(() => harness.cleanup());

    it("serves index.html at the root, revalidated", async () => {
      const res = await harness.app.request("/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(INDEX_HTML);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    });

    it("serves hashed assets immutably", async () => {
      const res = await harness.app.request("/assets/app-abc123.js");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ASSET_JS);
      expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    });

    // Otherwise a stale asset reference would be answered with the shell and
    // cached as immutable HTML under a .js URL.
    it("404s a missing asset instead of serving the shell", async () => {
      const res = await harness.app.request("/assets/gone-999.js");
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).not.toBe(IMMUTABLE);
      expect(await res.text()).not.toBe(INDEX_HTML);
    });

    it("returns the shell for client-routed deep links", async () => {
      for (const path of ["/settings/tokens", "/p/demo/issues/1"]) {
        const res = await harness.app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toBe(INDEX_HTML);
      }
    });

    it("answers HEAD for a deep link", async () => {
      const res = await harness.app.request("/settings/tokens", {
        method: "HEAD",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    });

    // The whole point of the /api guard: a miss under /api must stay a
    // machine-readable error instead of silently becoming the SPA shell.
    it("never serves the shell for API paths", async () => {
      const cookie = await harness.login();
      for (const path of ["/api", "/api/nope", "/api/projects/nope/issues"]) {
        const res = await harness.app.request(path, { headers: { cookie } });
        expect(res.status).not.toBe(200);
        expect(res.headers.get("content-type") ?? "").not.toContain(
          "text/html",
        );
      }
    });

    it("keeps unauthenticated API calls a JSON 401", async () => {
      const res = await harness.app.request("/api/me");
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({
        error: { code: "unauthorized" },
      });
    });

    it("still serves the API document", async () => {
      const res = await harness.app.request("/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { info: { title: string } };
      expect(doc.info.title).toBe("todou");
    });
  });
});
