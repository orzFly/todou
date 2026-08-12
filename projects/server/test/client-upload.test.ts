import { TodouClient } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

/**
 * Exercises the shared client's upload orchestration (direct-first,
 * multipart fallback, per-client memory) against the real route stack.
 * Lives in the server package because that's where the app + fake S3 are;
 * the client under test is exactly what web and CLI ship.
 */

type Wired = { client: TodouClient; apiCalls: string[] };

function wireClient(t: TestApp, cookie: string, fake?: FakeS3): Wired {
  const apiCalls: string[] = [];
  const client = new TodouClient({
    baseUrl: "http://todou.test",
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (fake && url.startsWith(fake.url)) return fetch(input as never, init);
      apiCalls.push(new URL(url).pathname);
      return t.app.request(url.replace("http://todou.test", ""), {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), cookie },
      });
    },
  });
  return { client, apiCalls };
}

async function seedProject(t: TestApp, cookie: string, slug: string) {
  const headers = { "content-type": "application/json", cookie };
  await t.app.request("/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug, name: slug }),
  });
  await t.app.request(`/api/projects/${slug}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "uploads" }),
  });
}

describe("TodouClient.uploadAttachment (s3 backend)", () => {
  let fake: FakeS3;
  let t: TestApp;
  let cookie: string;
  const slug = "client-s3";

  beforeAll(async () => {
    fake = await startFakeS3();
    t = await makeTestApp("shared", { s3: { endpoint: fake.url } });
    cookie = await t.login();
    await seedProject(t, cookie, slug);
  });

  afterAll(async () => {
    await t.cleanup();
    await fake.close();
  });

  it("uploads directly to the store, never touching multipart", async () => {
    const { client, apiCalls } = wireClient(t, cookie, fake);
    const attachment = await client.uploadAttachment(
      slug,
      1,
      new File(["straight to s3"], "direct.txt", { type: "text/plain" }),
    );
    expect(attachment.filename).toBe("direct.txt");
    expect(
      [...fake.objects.values()].some((b) => b.toString() === "straight to s3"),
    ).toBe(true);
    expect(
      apiCalls.some((p) => p.endsWith("/attachments/direct-uploads")),
    ).toBe(true);
    expect(apiCalls.filter((p) => p.endsWith("/attachments")).length).toBe(0);
  });

  it("falls back to multipart when the store PUT fails, without giving up on direct", async () => {
    const { client, apiCalls } = wireClient(t, cookie, fake);
    fake.failNext(3, 500);
    const attachment = await client.uploadAttachment(
      slug,
      1,
      new File(["flaky store"], "flaky.txt", { type: "text/plain" }),
    );
    expect(attachment.filename).toBe("flaky.txt");
    // This attempt used multipart…
    expect(apiCalls.some((p) => p.endsWith("/attachments"))).toBe(true);
    // …but the next upload tries direct again (failure wasn't remembered).
    const before = apiCalls.length;
    await client.uploadAttachment(
      slug,
      1,
      new File(["recovered"], "again.txt", { type: "text/plain" }),
    );
    const later = apiCalls.slice(before);
    expect(later.some((p) => p.endsWith("/attachments/direct-uploads"))).toBe(
      true,
    );
    expect(later.filter((p) => p.endsWith("/attachments")).length).toBe(0);
  });

  it("surfaces real validation errors instead of falling back", async () => {
    const { client } = wireClient(t, cookie, fake);
    await expect(
      client.uploadAttachment(
        slug,
        999,
        new File(["x"], "no-issue.txt", { type: "text/plain" }),
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("TodouClient.uploadAttachment (fs backend)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "client-fs";

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    await seedProject(t, cookie, slug);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("falls back on the 409 code and remembers per client", async () => {
    const { client, apiCalls } = wireClient(t, cookie);
    const first = await client.uploadAttachment(
      slug,
      1,
      new File(["fs one"], "one.txt", { type: "text/plain" }),
    );
    expect(first.filename).toBe("one.txt");
    const second = await client.uploadAttachment(
      slug,
      1,
      new File(["fs two"], "two.txt", { type: "text/plain" }),
    );
    expect(second.filename).toBe("two.txt");
    // One probe, then straight to multipart forever after.
    expect(
      apiCalls.filter((p) => p.endsWith("/attachments/direct-uploads")).length,
    ).toBe(1);
    expect(apiCalls.filter((p) => p.endsWith("/attachments")).length).toBe(2);
  });

  it("treats an old server's bare 404 as unavailability", async () => {
    const apiCalls: string[] = [];
    const client = new TodouClient({
      baseUrl: "http://todou.test",
      fetch: (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const path = new URL(url).pathname;
        apiCalls.push(path);
        // An older server has no direct-uploads route: plain-text 404.
        if (path.endsWith("/direct-uploads")) {
          return Promise.resolve(new Response("404 Not Found", { status: 404 }));
        }
        return t.app.request(url.replace("http://todou.test", ""), {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), cookie },
        });
      },
    });
    const uploaded = await client.uploadAttachment(
      slug,
      1,
      new File(["legacy"], "legacy.txt", { type: "text/plain" }),
    );
    expect(uploaded.filename).toBe("legacy.txt");
    await client.uploadAttachment(
      slug,
      1,
      new File(["legacy2"], "legacy2.txt", { type: "text/plain" }),
    );
    expect(apiCalls.filter((p) => p.endsWith("/direct-uploads")).length).toBe(
      1,
    );
  });
});
