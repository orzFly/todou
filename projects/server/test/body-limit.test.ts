import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const MB = 1024 * 1024;

/**
 * A chunked body that records how much the server actually pulled. The
 * counter is the regression evidence for T-70: the harm was unbounded
 * buffering, so the assertion has to be about bytes read, not the status
 * code — a 413 sent only after the whole body arrived would still OOM.
 */
function countingBody(total: number) {
  const chunk = new Uint8Array(64 * 1024);
  const counter = { produced: 0 };
  const stream = new ReadableStream({
    pull(controller) {
      if (counter.produced >= total) {
        controller.close();
        return;
      }
      counter.produced += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return { stream, counter };
}

describe("request body limits", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "limits";
  const headers = () => ({ "content-type": "application/json", cookie });

  // Upload limit 8 MB sits above the 4 MB JSON default so the tests can
  // tell which limit governed a route by where the cutoff lands.
  beforeAll(async () => {
    t = await makeTestApp("shared", { maxUploadMb: 8 });
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Limits" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "big bodies" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const uploadUrl = `/api/projects/${slug}/attachments`;

  it("cuts a chunked upload off at the limit instead of buffering it", async () => {
    const { stream, counter } = countingBody(64 * MB);
    const res = await t.app.request(uploadUrl, {
      method: "POST",
      headers: { cookie, "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.message).toContain("8 MB");
    // Reading past 8 MB proves the upload limit governed (not the smaller
    // JSON one); stopping far short of 64 MB proves the truncation.
    expect(counter.produced).toBeGreaterThan(8 * MB);
    expect(counter.produced).toBeLessThan(10 * MB);
  });

  it("rejects on the declared content-length before reading any body", async () => {
    const { stream, counter } = countingBody(64 * MB);
    const res = await t.app.request(uploadUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(64 * MB),
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    // One chunk is the stream machinery priming its queue (highWaterMark 1
    // pulls once at construction); the server itself read nothing.
    expect(counter.produced).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps uploads above the JSON limit working", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(5 * MB)], "big.bin", {
        type: "application/octet-stream",
      }),
    );
    form.set("issue_number", "1");
    const res = await t.app.request(uploadUrl, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    expect((await json(res)).size).toBe(5 * MB);
  });

  it("holds JSON routes to the smaller JSON limit", async () => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "x".repeat(5 * MB) }),
    });
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.message).toContain("4 MB");
  });

  it("caps avatars at the avatar limit, not the upload limit", async () => {
    const { stream, counter } = countingBody(32 * MB);
    const res = await t.app.request("/api/me/avatar", {
      method: "POST",
      headers: { cookie, "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("payload_too_large");
    // Truncation lands just past the 2 MB avatar cap — well below both the
    // 8 MB upload limit and the 32 MB body.
    expect(counter.produced).toBeGreaterThan(2 * MB);
    expect(counter.produced).toBeLessThan(4 * MB);
  });

  it("applies the JSON limit to unauthenticated routes", async () => {
    const { stream, counter } = countingBody(64 * MB);
    const res = await t.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(counter.produced).toBeLessThan(6 * MB);
  });
});
