import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeFilename } from "../src/services/attachments.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("sanitizeFilename", () => {
  it("strips path separators, control chars, and traversal", () => {
    expect(sanitizeFilename("../..\\evil\nname.txt")).not.toMatch(
      /[/\\\n.]{2}/,
    );
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("normal-name.png")).toBe("normal-name.png");
  });
});

describe("attachments (fs backend)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "attach";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("dedicated", { maxUploadMb: 0.001 });
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Attach" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "with files" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  function upload(
    name: string,
    content: string,
    extra?: Record<string, string>,
  ) {
    const form = new FormData();
    form.set("file", new File([content], name, { type: "text/plain" }));
    form.set("issue_number", "1");
    return t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: extra ?? { cookie },
      body: form,
    });
  }

  it("uploads and downloads a file round-trip", async () => {
    const res = await upload("notes.txt", "potato bytes");
    expect(res.status).toBe(201);
    const attachment = await json(res);
    expect(attachment.filename).toBe("notes.txt");
    expect(attachment.url).toMatch(
      new RegExp(`/projects/${slug}/attachments/\\d+/download/notes\\.txt$`),
    );

    const download = await t.app.request(attachment.url, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("potato bytes");
    expect(download.headers.get("content-type")).toContain("text/plain");
    expect(download.headers.get("content-disposition")).toContain("notes.txt");
  });

  it("downloads via the bare URL and via any cosmetic name", async () => {
    const res = await upload("real-name.txt", "same bytes");
    const attachment = await json(res);
    const bare = attachment.url.replace(/\/download\/.*$/, "/download");

    for (const url of [bare, `${bare}/anything_else.bin`]) {
      const download = await t.app.request(url, { headers: { cookie } });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("same bytes");
      // Save-as name comes from the stored filename, not the URL segment.
      expect(download.headers.get("content-disposition")).toContain(
        "real-name.txt",
      );
    }
  });

  it("serves the view route inline with a CSP sandbox (T-58)", async () => {
    const res = await upload("demo.html", "<script>alert(1)</script>");
    const attachment = await json(res);
    const viewUrl = attachment.url.replace("/download/", "/view/");

    for (const url of [viewUrl, viewUrl.replace(/\/view\/.*$/, "/view")]) {
      const view = await t.app.request(url, { headers: { cookie } });
      expect(view.status).toBe(200);
      expect(await view.text()).toBe("<script>alert(1)</script>");
      expect(view.headers.get("content-disposition")).toContain("inline");
      expect(view.headers.get("content-disposition")).toContain("demo.html");
      // The document must never run with the API's origin: opaque origin
      // even when the URL is opened as a top-level tab.
      expect(view.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(view.headers.get("x-content-type-options")).toBe("nosniff");
    }

    // The download twin stays a plain attachment with no sandbox headers.
    const download = await t.app.request(attachment.url, {
      headers: { cookie },
    });
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-security-policy")).toBeNull();
  });

  it("requires membership on the view route like download", async () => {
    const res = await upload("secret.html", "<p>hi</p>");
    const attachment = await json(res);
    const viewUrl = attachment.url.replace("/download/", "/view/");
    const outsider = await addUserWithToken(t.ctx, "outsider-58");
    const denied = await t.app.request(viewUrl, {
      headers: outsider.headers,
    });
    expect(denied.status).toBe(404);
  });

  it("adds an attachment_added timeline event", async () => {
    await upload("evidence.txt", "x");
    const timeline = await json(
      await t.app.request(`/api/projects/${slug}/issues/1/timeline?limit=50`, {
        headers: { cookie },
      }),
    );
    expect(
      timeline.items.some(
        (i: { type: string; event_type?: string }) =>
          i.type === "event" && i.event_type === "attachment_added",
      ),
    ).toBe(true);
  });

  it("lists an issue's attachments", async () => {
    const res = await upload("listed.txt", "hello");
    expect(res.status).toBe(201);
    const listRes = await t.app.request(
      `/api/projects/${slug}/attachments?issue_number=1`,
      { headers: { cookie } },
    );
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(Array.isArray(list)).toBe(true);
    const listed = list.find(
      (a: { filename: string }) => a.filename === "listed.txt",
    );
    expect(listed).toBeDefined();
    expect(listed.url).toContain(`/projects/${slug}/attachments/`);
    expect(listed.uploader.login).toBeDefined();

    const missing = await t.app.request(
      `/api/projects/${slug}/attachments?issue_number=999`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
  });

  it("rejects uploads above the configured limit", async () => {
    // Limit is 0.001 MB ≈ 1048 bytes.
    const res = await upload("big.txt", "x".repeat(5000));
    expect(res.status).toBe(422);
  });

  it("sanitizes hostile filenames in storage and headers", async () => {
    const res = await upload('..\\weird\n"name".txt', "content");
    expect(res.status).toBe(201);
    const attachment = await json(res);
    expect(attachment.filename).not.toContain("..");
    expect(attachment.filename).not.toContain("\n");
  });

  it("blocks non-members from downloading", async () => {
    const res = await upload("secret.txt", "top secret");
    const attachment = await json(res);
    const mallory = await addUserWithToken(t.ctx, "mallory");
    const download = await t.app.request(attachment.url, {
      headers: mallory.headers,
    });
    expect(download.status).toBe(404);
  });

  it("blocks readers from uploading", async () => {
    const reader = await addUserWithToken(t.ctx, "attach-reader");
    await t.app.request(`/api/projects/${slug}/members/${reader.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "reader" }),
    });
    const res = await upload("nope.txt", "x", reader.headers);
    expect(res.status).toBe(403);
  });
});

describe("direct uploads (fs backend)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "attach-fs-direct";

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "FS Direct" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "no direct here" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("advertises unavailability with the dedicated 409 code", async () => {
    const res = await t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          issue_number: 1,
          filename: "f.txt",
          content_type: "text/plain",
          size: 10,
        }),
      },
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("direct_upload_unavailable");

    const complete = await t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads/1/complete`,
      { method: "POST", headers: { cookie } },
    );
    expect(complete.status).toBe(409);
    expect((await json(complete)).error.code).toBe("direct_upload_unavailable");
  });

  // The size gate answers before the backend gate: a 409 would send the
  // client into the multipart fallback with a file no path will accept.
  it("rejects an oversize declaration instead of advertising fallback", async () => {
    const res = await t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          issue_number: 1,
          filename: "huge.bin",
          content_type: "application/octet-stream",
          size: 21 * 1024 * 1024,
        }),
      },
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("validation_failed");
  });
});

describe("attachments (s3 backend)", () => {
  let fake: FakeS3;
  let t: TestApp;
  let cookie: string;
  const slug = "attach-s3";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    fake = await startFakeS3();
    t = await makeTestApp("dedicated", { s3: { endpoint: fake.url } });
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Attach S3" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "s3 files" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
    await fake.close();
  });

  function multipartUpload(name: string, content: string) {
    const form = new FormData();
    form.set("file", new File([content], name, { type: "text/plain" }));
    form.set("issue_number", "1");
    return t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
  }

  function requestDirect(body: Record<string, unknown>) {
    return t.app.request(`/api/projects/${slug}/attachments/direct-uploads`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ issue_number: 1, ...body }),
    });
  }

  function complete(uploadId: number, extra?: Record<string, string>) {
    return t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads/${uploadId}/complete`,
      { method: "POST", headers: extra ?? { cookie } },
    );
  }

  /** The object key inside the fake bucket, from a presigned URL. */
  function keyOf(ticketUrl: string): string {
    return new URL(ticketUrl).pathname.replace(`/${fake.bucket}/`, "");
  }

  it("proxies multipart uploads into the bucket", async () => {
    const res = await multipartUpload("proxied.txt", "via server");
    expect(res.status).toBe(201);
    const attachment = await json(res);
    const stored = [...fake.objects.values()].some(
      (b) => b.toString() === "via server",
    );
    expect(stored).toBe(true);
    expect(attachment.url).toContain("/download/");
  });

  it("302s downloads to a presigned URL that actually works", async () => {
    const attachment = await json(
      await multipartUpload("redirected.txt", "presigned bytes"),
    );
    for (const url of [
      attachment.url,
      attachment.url.replace(/\/download\/.*$/, "/download"),
    ]) {
      const res = await t.app.request(url, { headers: { cookie } });
      expect(res.status).toBe(302);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const location = res.headers.get("location") as string;
      const parsed = new URL(location);
      expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
      expect(parsed.searchParams.get("response-content-disposition")).toContain(
        "redirected.txt",
      );
      expect(parsed.searchParams.get("response-content-type")).toBe(
        "text/plain",
      );
      // The fake verifies SigV4 for real — a 200 proves the redirect target.
      const followed = await fetch(location);
      expect(followed.status).toBe(200);
      expect(await followed.text()).toBe("presigned bytes");
    }
  });

  it("keeps the view route server-streamed with the CSP sandbox", async () => {
    const attachment = await json(
      await multipartUpload("page.html", "<b>inline</b>"),
    );
    const view = await t.app.request(
      attachment.url.replace("/download/", "/view/"),
      { headers: { cookie } },
    );
    expect(view.status).toBe(200);
    expect(await view.text()).toBe("<b>inline</b>");
    expect(view.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts",
    );
  });

  it("completes the direct-upload handshake end to end", async () => {
    const body = "direct upload payload";
    const res = await requestDirect({
      filename: "direct.txt",
      content_type: "text/plain",
      size: body.length,
    });
    expect(res.status).toBe(201);
    const ticket = await json(res);
    expect(ticket.upload_id).toBeGreaterThan(0);
    expect(ticket.expires_at).toBeTruthy();

    const put = await fetch(ticket.url, { method: "PUT", body });
    expect(put.status).toBe(200);

    const done = await complete(ticket.upload_id);
    expect(done.status).toBe(201);
    const attachment = await json(done);
    expect(attachment.filename).toBe("direct.txt");
    expect(attachment.size).toBe(body.length);
    expect(attachment.url).toContain("/download/direct.txt");

    const list = await json(
      await t.app.request(`/api/projects/${slug}/attachments?issue_number=1`, {
        headers: { cookie },
      }),
    );
    expect(
      list.some((a: { filename: string }) => a.filename === "direct.txt"),
    ).toBe(true);

    const timeline = await json(
      await t.app.request(`/api/projects/${slug}/issues/1/timeline?limit=50`, {
        headers: { cookie },
      }),
    );
    expect(
      timeline.items.some(
        (i: { type: string; event_type?: string }) =>
          i.type === "event" && i.event_type === "attachment_added",
      ),
    ).toBe(true);
  });

  it("pins a client-supplied sha256 into the upload", async () => {
    const body = "hash pinned body";
    const digest = createHash("sha256").update(body).digest("base64");
    const ticket = await json(
      await requestDirect({
        filename: "pinned.txt",
        content_type: "text/plain",
        size: body.length,
        sha256: digest,
      }),
    );
    expect(ticket.headers["x-amz-checksum-sha256"]).toBe(digest);

    const tampered = await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body: "hash PINNED body",
    });
    expect(tampered.status).toBe(400);

    const ok = await fetch(ticket.url, {
      method: "PUT",
      headers: ticket.headers,
      body,
    });
    expect(ok.status).toBe(200);
    expect((await complete(ticket.upload_id)).status).toBe(201);
  });

  it("rejects completion when the object never arrived", async () => {
    const ticket = await json(
      await requestDirect({
        filename: "ghost.txt",
        content_type: "text/plain",
        size: 5,
      }),
    );
    const res = await complete(ticket.upload_id);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error.code).toBe("direct_upload_incomplete");
    expect(body.error.details.reason).toBe("missing");
  });

  it("rejects completion on size mismatch", async () => {
    const ticket = await json(
      await requestDirect({
        filename: "shrunk.txt",
        content_type: "text/plain",
        size: 100,
      }),
    );
    // Simulate an out-of-band write the signature layer would normally stop.
    fake.objects.set(keyOf(ticket.url), Buffer.from("tiny"));
    const res = await complete(ticket.upload_id);
    expect(res.status).toBe(409);
    expect((await json(res)).error.details.reason).toBe("size_mismatch");
  });

  it("replays completion idempotently", async () => {
    const body = "replayed";
    const ticket = await json(
      await requestDirect({
        filename: "replay.txt",
        content_type: "text/plain",
        size: body.length,
      }),
    );
    await fetch(ticket.url, { method: "PUT", body });
    const first = await json(await complete(ticket.upload_id));
    const again = await complete(ticket.upload_id);
    expect(again.status).toBe(201);
    expect((await json(again)).id).toBe(first.id);
  });

  it("only the requesting uploader may complete", async () => {
    const other = await addUserWithToken(t.ctx, "other-writer");
    await t.app.request(`/api/projects/${slug}/members/${other.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });
    const body = "not yours";
    const ticket = await json(
      await requestDirect({
        filename: "mine.txt",
        content_type: "text/plain",
        size: body.length,
      }),
    );
    await fetch(ticket.url, { method: "PUT", body });
    const res = await complete(ticket.upload_id, other.headers);
    expect(res.status).toBe(403);
  });

  it("404s an unknown upload id", async () => {
    expect((await complete(999_999)).status).toBe(404);
  });

  it("enforces the size cap at request time", async () => {
    const res = await requestDirect({
      filename: "huge.bin",
      content_type: "application/octet-stream",
      size: 21 * 1024 * 1024,
    });
    expect(res.status).toBe(422);
  });
});
