import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { makeTestApp, type TestApp, testConfig } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const buffer = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("response compression", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "zip";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Zip" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "compressed issue" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // The OpenAPI document is the app's biggest unauthenticated JSON response,
  // well past the size threshold.
  const BIG = "/api/openapi.json";

  it("gzips a large JSON response and round-trips the bytes", async () => {
    const identity = await t.app.request(BIG);
    const identityBody = await buffer(identity);
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toBe("Accept-Encoding");

    const res = await t.app.request(BIG, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-length")).toBeNull();
    const compressed = await buffer(res);
    expect(compressed.byteLength).toBeLessThan(identityBody.byteLength / 2);
    expect(gunzipSync(compressed).equals(identityBody)).toBe(true);
  });

  it("prefers brotli when the client accepts both", async () => {
    const identityBody = await buffer(await t.app.request(BIG));
    const res = await t.app.request(BIG, {
      headers: { "accept-encoding": "gzip, deflate, br, zstd" },
    });
    expect(res.headers.get("content-encoding")).toBe("br");
    const compressed = await buffer(res);
    expect(compressed.byteLength).toBeLessThan(identityBody.byteLength / 2);
    expect(brotliDecompressSync(compressed).equals(identityBody)).toBe(true);
  });

  it("honours q-values over server preference", async () => {
    const res = await t.app.request(BIG, {
      headers: { "accept-encoding": "br;q=0.5, gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("serves identity when the client accepts none of ours", async () => {
    for (const accept of ["identity", "zstd", "gzip;q=0, br;q=0"]) {
      const res = await t.app.request(BIG, {
        headers: { "accept-encoding": accept },
      });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect((await json(res)).info.title).toBe("todou");
    }
  });

  it("skips responses below the size threshold", async () => {
    const res = await t.app.request("/api/me", {
      headers: { cookie, "accept-encoding": "gzip, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    // The peek consumed and reassembled the body; it must still parse.
    expect((await json(res)).login).toBeDefined();
  });

  it("never touches the SSE stream and keeps it real-time", async () => {
    const controller = new AbortController();
    const res = await t.app.request(`/api/projects/${slug}/events`, {
      headers: { cookie, "accept-encoding": "gzip, br" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let bufferText = "";
    const readUntil = async (needle: string) => {
      while (!bufferText.includes(needle)) {
        const next = reader.read();
        const timeout = new Promise<never>((_, reject) => {
          // An encoder or peek buffering the stream would park this read
          // forever; a bounded wait turns that regression into a failure.
          setTimeout(() => reject(new Error(`timed out on ${needle}`)), 2000);
        });
        const { value, done } = await Promise.race([next, timeout]);
        if (done) throw new Error("stream ended early");
        bufferText += decoder.decode(value, { stream: true });
      }
    };

    await readUntil("event: hello");
    const posted = await t.app.request(
      `/api/projects/${slug}/issues/1/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "compression must not delay me" }),
      },
    );
    expect(posted.status).toBe(201);
    await readUntil("event: change");

    controller.abort();
  });

  it("skips attachment bodies in already-compressed formats", async () => {
    const form = new FormData();
    // Valid-enough PNG bytes: only the content type matters to the filter.
    form.set(
      "file",
      new File([Buffer.alloc(4096, 7)], "pic.png", { type: "image/png" }),
    );
    form.set("issue_number", "1");
    const uploaded = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);

    const res = await t.app.request((await json(uploaded)).url, {
      headers: { cookie, "accept-encoding": "gzip, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBe("4096");
  });

  it("compresses large text attachments (declared Content-Length path)", async () => {
    const text = "attachment line that repeats itself\n".repeat(200);
    const form = new FormData();
    form.set("file", new File([text], "big.txt", { type: "text/plain" }));
    form.set("issue_number", "1");
    const uploaded = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);

    const res = await t.app.request((await json(uploaded)).url, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await buffer(res)).toString()).toBe(text);
  });
});

describe("response compression: config switch", () => {
  it("http.compression = false disables it entirely", async () => {
    const config = testConfig();
    config.http.compression = false;
    const ctx = await bootstrap(config);
    const app = createApp(ctx);
    try {
      const res = await app.request("/api/openapi.json", {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("vary")).toBeNull();
    } finally {
      await ctx.router.close();
    }
  });
});
