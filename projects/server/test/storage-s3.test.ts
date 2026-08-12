import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, ConfigError, loadConfig } from "../src/config.ts";
import { NotFoundError, UpstreamError } from "../src/errors.ts";
import { S3Storage } from "../src/storage/s3.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";

function s3Config(
  endpoint: string,
  extra: Record<string, string> = {},
): Config {
  const entries: Record<string, string> = {
    endpoint: `'${endpoint}'`,
    bucket: "'test-bucket'",
    access_key_id: "'test-ak'",
    secret_access_key: "'test-sk'",
    retries: "2",
    request_timeout_ms: "2000",
    ...extra,
  };
  return loadConfig({
    tomlSource: [
      "[storage]",
      'backend = "s3"',
      "[storage.s3]",
      ...Object.entries(entries).map(([k, v]) => `${k} = ${v}`),
    ].join("\n"),
    env: {},
  });
}

function makeStorage(
  endpoint: string,
  extra: Record<string, string> = {},
): S3Storage {
  const config = s3Config(endpoint, extra);
  if (!config.s3Credentials) throw new Error("credentials not resolved");
  return new S3Storage(config.storage.s3, config.s3Credentials);
}

describe("S3Storage against fake S3", () => {
  let fake: FakeS3;
  let storage: S3Storage;

  beforeAll(async () => {
    fake = await startFakeS3();
    storage = makeStorage(fake.url);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("round-trips put → head → getStream → delete", async () => {
    const data = new TextEncoder().encode("hello blob");
    await storage.put("aa/bb/roundtrip", data);
    expect(fake.objects.get("aa/bb/roundtrip")?.toString()).toBe("hello blob");

    expect(await storage.head("aa/bb/roundtrip")).toEqual({ size: 10 });

    const { stream, size } = await storage.getStream("aa/bb/roundtrip");
    expect(size).toBe(10);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("hello blob");

    await storage.delete("aa/bb/roundtrip");
    expect(await storage.head("aa/bb/roundtrip")).toBeNull();
  });

  it("maps a missing object to NotFoundError on get", async () => {
    await expect(storage.getStream("aa/bb/ghost")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("treats deleting the absent as success", async () => {
    await expect(storage.delete("aa/bb/ghost")).resolves.toBeUndefined();
  });

  it("presigns download URLs carrying disposition and type", async () => {
    await storage.put("aa/bb/pretty", new TextEncoder().encode("body"));
    const url = await storage.urlFor("aa/bb/pretty", {
      filename: 'na"me.txt',
      contentType: "text/plain",
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(parsed.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="na_me.txt"',
    );

    // The fake verifies the signature for real, so a plain unauthenticated
    // fetch proves the presign is valid end to end.
    const res = await fetch(url as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="na_me.txt"',
    );
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("body");
  });

  it("enforces the signed content-length on presigned PUTs", async () => {
    const { url } = await storage.presignPut("aa/bb/sized", 9);
    const wrong = await fetch(url, { method: "PUT", body: "far too many bytes" });
    expect(wrong.status).toBe(403);
    expect(fake.objects.has("aa/bb/sized")).toBe(false);

    const right = await fetch(url, { method: "PUT", body: "nine byte" });
    expect(right.status).toBe(200);
    expect(fake.objects.get("aa/bb/sized")?.toString()).toBe("nine byte");
  });

  it("pins the client checksum when provided", async () => {
    const body = "checksummed content";
    const sha256 = createHash("sha256").update(body).digest("base64");
    const { url, headers } = await storage.presignPut(
      "aa/bb/checked",
      body.length,
      sha256,
    );
    expect(headers["x-amz-checksum-sha256"]).toBe(sha256);

    const tampered = await fetch(url, {
      method: "PUT",
      headers,
      body: "checksummed CONTENT",
    });
    expect(tampered.status).toBe(400);

    const ok = await fetch(url, { method: "PUT", headers, body });
    expect(ok.status).toBe(200);
  });

  it("retries transient 5xx and succeeds", async () => {
    await storage.put("aa/bb/retry", new TextEncoder().encode("x"));
    const before = fake.requests.length;
    fake.failNext(2, 500);
    const { size } = await storage.getStream("aa/bb/retry");
    expect(size).toBe(1);
    expect(fake.requests.length - before).toBe(3);
  });

  it("gives up after configured retries with UpstreamError", async () => {
    fake.failNext(3, 500);
    await expect(storage.head("aa/bb/retry")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it("does not retry non-429 4xx", async () => {
    const before = fake.requests.length;
    fake.failNext(1, 403);
    await expect(storage.head("aa/bb/retry")).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(fake.requests.length - before).toBe(1);
  });

  it("passes checkBucket against a live bucket", async () => {
    await expect(storage.checkBucket()).resolves.toBeUndefined();
  });
});

describe("S3Storage key prefix and public endpoint", () => {
  let fake: FakeS3;

  beforeAll(async () => {
    fake = await startFakeS3();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("prefixes object keys without touching stored keys", async () => {
    const storage = makeStorage(fake.url, { key_prefix: "'todou/prod'" });
    await storage.put("aa/bb/k", new TextEncoder().encode("v"));
    expect(fake.objects.has("todou/prod/aa/bb/k")).toBe(true);
    expect(await storage.head("aa/bb/k")).toEqual({ size: 1 });
  });

  it("signs presigned URLs against the public endpoint", async () => {
    const storage = makeStorage(fake.url, {
      public_endpoint: "'https://files.example.com'",
    });
    await storage.put("aa/bb/pub", new TextEncoder().encode("v"));
    const url = await storage.urlFor("aa/bb/pub");
    expect(url).toMatch(/^https:\/\/files\.example\.com\//);
  });
});

describe("S3Storage upstream failures", () => {
  it("times out a stalled upstream and reports UpstreamError", async () => {
    const stalled = createServer(() => {
      // Never respond; the client's AbortSignal has to cut the cord.
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
    const { port } = stalled.address() as AddressInfo;
    const storage = makeStorage(`http://127.0.0.1:${port}`, {
      request_timeout_ms: "200",
      retries: "0",
    });
    await expect(storage.head("aa/bb/never")).rejects.toBeInstanceOf(
      UpstreamError,
    );
    stalled.close();
  });

  it("fails checkBucket with ConfigError when unreachable", async () => {
    const storage = makeStorage("http://127.0.0.1:1", {
      request_timeout_ms: "300",
      retries: "0",
    });
    await expect(storage.checkBucket()).rejects.toBeInstanceOf(ConfigError);
  });
});
