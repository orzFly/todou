import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inlineScriptHashes } from "../src/middleware/security-headers.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const THEME_GUARD = "document.documentElement.classList.add('dark');";
const INDEX_HTML =
  "<!doctype html><title>todou</title>" +
  `<script>${THEME_GUARD}</script>` +
  '<script type="module" crossorigin src="/assets/app-abc123.js"></script>' +
  '<div id="root"></div>';

const sha256 = (body: string) =>
  `'sha256-${createHash("sha256").update(body).digest("base64")}'`;

function fakeDist(): string {
  const dir = testTmpDir("todou-dist-");
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  return dir;
}

/** What a hidden cross-site iframe sends for the page it frames. */
const framed = {
  "sec-fetch-dest": "iframe",
  "sec-fetch-site": "cross-site",
};

function expectUnframeable(res: Response) {
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("inlineScriptHashes", () => {
  it("hashes inline scripts and skips ones loaded by src", () => {
    expect(inlineScriptHashes(INDEX_HTML)).toEqual([sha256(THEME_GUARD)]);
  });
});

describe("security headers (T-633)", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("shared", { staticDir: fakeDist() });
    cookie = await t.login();
  });
  afterAll(() => t.cleanup());

  it("refuses to let another site frame the authorization page", async () => {
    const res = await t.app.request("/cli-auth?code=ABCD-EFGH", {
      headers: framed,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expectUnframeable(res);
  });

  it("lets the shell's own inline scripts and bundle run, and nothing else", async () => {
    const csp = (await t.app.request("/")).headers.get(
      "content-security-policy",
    );
    expect(csp).toContain(
      `script-src 'self' 'wasm-unsafe-eval' ${sha256(THEME_GUARD)}`,
    );
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("covers assets, API answers and error answers alike", async () => {
    for (const [path, status, headers] of [
      ["/assets/app-abc123.js", 200, {}],
      ["/api/auth/mode", 200, {}],
      ["/api/me", 401, {}],
      ["/api/no-such-route", 404, { cookie }],
    ] as const) {
      const res = await t.app.request(path, { headers });
      expect(res.status, path).toBe(status);
      expectUnframeable(res);
    }
    const refused = await t.app.request("/api/auth/cli/requests/1/deny", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(refused.status).toBe(403);
    expectUnframeable(refused);
  });

  it("keeps the attachment view's sandbox, framable by todou's own pages only", async () => {
    const jsonHeaders = { "content-type": "application/json", cookie };
    await t.app.request("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug: "frames", name: "Frames" }),
    });
    await t.app.request("/api/projects/frames/issues", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "with a page" }),
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["<b>page</b>"], "page.html", { type: "text/html" }),
    );
    form.set("issue_number", "1");
    const uploaded = await t.app.request("/api/projects/frames/attachments", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const { url } = await json(uploaded);

    const view = await t.app.request(url.replace("/download/", "/view/"), {
      headers: { cookie },
    });
    expect(view.status).toBe(200);
    expect(view.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; frame-ancestors 'self'",
    );
    expect(view.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    const download = await t.app.request(url, { headers: { cookie } });
    expectUnframeable(download);
  });
});
