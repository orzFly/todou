import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachments } from "../src/db/project-schema.ts";
import { sanitizeFilename } from "../src/services/attachment-names.ts";
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
    content: string | Uint8Array<ArrayBuffer>,
    extra?: Record<string, string>,
    type = "text/plain",
  ) {
    const form = new FormData();
    form.set("file", new File([content], name, { type }));
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
    const res = await upload(
      "demo.html",
      "<script>alert(1)</script>",
      undefined,
      "text/html",
    );
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
      expect(view.headers.get("content-type")).toBe("text/html");
      expect(view.headers.get("x-content-type-options")).toBe("nosniff");
    }

    // The download twin stays a plain attachment with no sandbox headers,
    // and answers text/plain: a `script` destination ignores
    // content-disposition, so an HTML file must not come back as one here.
    const download = await t.app.request(attachment.url, {
      headers: { cookie },
    });
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-security-policy")).toBeNull();
    expect(download.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  });

  // The card's headline requirement: /download must never serve a script or
  // stylesheet header, whichever type the uploader declared.
  it.each([
    ["main.js", "text/javascript"],
    ["main.js", "application/javascript"],
    ["theme.css", "text/css"],
  ])("never serves %s (%s) as script or style", async (name, type) => {
    const attachment = await json(
      await upload(name, "body{}", undefined, type),
    );
    const urls = [
      attachment.url,
      attachment.url.replace("/download/", "/view/"),
    ];
    for (const url of urls) {
      const res = await t.app.request(url, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  // The "图片不坏" regression guard: nosniff gates only script and style
  // destinations, so an image still renders from the bytes.
  it("keeps a png an image on both routes, byte for byte", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0x00,
    ]);
    const attachment = await json(
      await upload("shot.png", bytes, undefined, "image/png"),
    );

    for (const url of [
      attachment.url,
      attachment.url.replace("/download/", "/view/"),
    ]) {
      const res = await t.app.request(url, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    }
  });

  it("leaves a pre-T-27 octet-stream row as octet-stream", async () => {
    const attachment = await json(
      await upload("old.bin", "bytes", undefined, "application/octet-stream"),
    );
    const res = await t.app.request(attachment.url, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("binds every blob response to this origin (CORP)", async () => {
    const attachment = await json(await upload("corp.txt", "x"));
    for (const url of [
      attachment.url,
      attachment.url.replace("/download/", "/view/"),
    ]) {
      const res = await t.app.request(url, { headers: { cookie } });
      expect(res.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
    }
  });

  // The download twin of this guard already exists; /view had no such test,
  // so nothing would have caught a regression that started trusting the URL
  // segment. Firefox takes the save-as name from content-disposition, so a
  // link written with a misleading segment must not choose what lands on disk.
  it("names the stored file on /view despite a lying URL segment", async () => {
    const attachment = await json(await upload("honest.txt", "text"));
    const view = await t.app.request(
      `${attachment.url.replace(/\/download\/.*$/, "/view")}/not-the-real-name.bin`,
      { headers: { cookie } },
    );
    expect(view.status).toBe(200);
    expect(view.headers.get("content-disposition")).toBe(
      'inline; filename="honest.txt"',
    );
  });

  // Every one of these used to 500: a code point above 0xFF cannot go into a
  // header value, and the TypeError fell through to the generic handler.
  it.each([
    [
      "e2e-验收留证.txt",
      "e2e-____.txt",
      "e2e-%E9%AA%8C%E6%94%B6%E7%95%99%E8%AF%81.txt",
    ],
    [
      "検証レポート.txt",
      "______.txt",
      "%E6%A4%9C%E8%A8%BC%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.txt",
    ],
    [
      "검수 증빙.txt",
      "__ __.txt",
      "%EA%B2%80%EC%88%98%20%EC%A6%9D%EB%B9%99.txt",
    ],
  ])("downloads a non-ASCII name: %s (T-147)", async (name, ascii, encoded) => {
    const res = await upload(name, "unicode bytes");
    expect(res.status).toBe(201);
    const attachment = await json(res);
    // Storage keeps the name as given; only the header gets encoded.
    expect(attachment.filename).toBe(name);

    const download = await t.app.request(attachment.url, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("unicode bytes");
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    );

    const view = await t.app.request(
      attachment.url.replace("/download/", "/view/"),
      { headers: { cookie } },
    );
    expect(view.status).toBe(200);
    expect(view.headers.get("content-disposition")).toBe(
      `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    );
    expect(view.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts",
    );
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

describe("filenames are unique within one card (T-269)", () => {
  let t: TestApp;
  let cookie: string;
  let projectId: number;
  const slug = "attach-unique";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    projectId = (
      await json(
        await t.app.request("/api/projects", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug, name: "Unique" }),
        }),
      )
    ).id;
    for (const title of ["first card", "second card"]) {
      await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title }),
      });
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const put = async (issueNumber: number, name: string) => {
    const form = new FormData();
    form.set("file", new File(["bytes"], name, { type: "text/plain" }));
    form.set("issue_number", String(issueNumber));
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  it("appends the new attachment's own id to a taken name", async () => {
    const first = await put(1, "foo.png");
    expect(first.filename).toBe("foo.png");
    const second = await put(1, "foo.png");
    expect(second.filename).toBe(`foo-${second.id}.png`);
    const third = await put(1, "foo.png");
    expect(third.filename).toBe(`foo-${third.id}.png`);
    expect(third.url).toContain(`/download/foo-${third.id}.png`);
  });

  it("hands the list back by upload time, whatever order the rows sit in (T-369)", async () => {
    // Three collisions (each rewritten by an `update` right after its insert)
    // and one clean name, then the newest row is backdated behind all of them.
    //
    // The backdating is what gives this case teeth. Nothing in the product
    // moves a `created_at` — so on a list this small every storage engine we
    // run on happens to return the rows in insertion order anyway, and an
    // assertion that only says "ascending" holds with the `orderBy` deleted.
    // A row whose time disagrees with its position is the one arrangement
    // where the ordering key has to be read for the answer to come out right.
    const files = [
      await put(1, "ord.png"),
      await put(1, "ord.png"),
      await put(1, "ord.png"),
      await put(1, "zzz.png"),
    ];
    const newest = files[3] as { id: number };
    const db = await t.ctx.router.forProject({
      id: projectId,
      slug,
      database_url: "",
    });
    await db
      .update(attachments)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(attachments.id, newest.id));

    const list: { id: number; created_at: string }[] = await json(
      await t.app.request(`/api/projects/${slug}/attachments?issue_number=1`, {
        headers: { cookie },
      }),
    );
    expect(list[0]?.id).toBe(newest.id);
    const times = list.map((one) => Date.parse(one.created_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const rest = list.slice(1).map((one) => one.id);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
    expect(rest).toContain(files[0]?.id);
  });

  it("folds case when deciding, and keeps it when storing", async () => {
    const clashing = await put(1, "FOO.PNG");
    expect(clashing.filename).toBe(`FOO-${clashing.id}.PNG`);
  });

  it("walks past an id-suffixed name someone really uploaded", async () => {
    const first = await put(1, "bar.png");
    // The next two inserts take the next two ids, so a file named after the
    // one after that is waiting when the third upload asks for it.
    const decoy = await put(1, `bar-${first.id + 2}.png`);
    expect(decoy.id).toBe(first.id + 1);
    expect(decoy.filename).toBe(`bar-${first.id + 2}.png`);

    const third = await put(1, "bar.png");
    expect(third.id).toBe(first.id + 2);
    expect(third.filename).toBe(`bar-${first.id + 2}-2.png`);
  });

  it("puts the suffix at the end of a name with no extension", async () => {
    const first = await put(1, "README");
    expect(first.filename).toBe("README");
    const second = await put(1, "README");
    expect(second.filename).toBe(`README-${second.id}`);
  });

  it("scopes uniqueness to the card, not the project", async () => {
    const elsewhere = await put(2, "foo.png");
    expect(elsewhere.filename).toBe("foo.png");
  });

  it("does not know what image.png means", async () => {
    // The clipboard default is renamed in the browser, at paste time; the
    // server sees an ordinary name and treats it as one.
    const first = await put(2, "image.png");
    expect(first.filename).toBe("image.png");
    const second = await put(2, "image.png");
    expect(second.filename).toBe(`image-${second.id}.png`);
  });

  it("encodes the final name into the url segment", async () => {
    const parens = await put(2, "shot (1).png");
    expect(parens.filename).toBe("shot (1).png");
    expect(parens.url).toContain("/download/shot%20%281%29.png");

    const clashing = await put(2, "shot (1).png");
    expect(clashing.filename).toBe(`shot (1)-${clashing.id}.png`);
    expect(clashing.url).toContain(
      `/download/shot%20%281%29-${clashing.id}.png`,
    );
  });

  it("lists every name on the card exactly once", async () => {
    const list = await json(
      await t.app.request(`/api/projects/${slug}/attachments?issue_number=1`, {
        headers: { cookie },
      }),
    );
    const folded = list.map((one: { filename: string }) =>
      one.filename.toLowerCase(),
    );
    expect(folded.length).toBeGreaterThan(1);
    expect(new Set(folded).size).toBe(folded.length);
  });

  it("records the stored name on the timeline event, not the asked-for one", async () => {
    const clashing = await put(1, "foo.png");
    const timeline = await json(
      await t.app.request(`/api/projects/${slug}/issues/1/timeline?limit=100`, {
        headers: { cookie },
      }),
    );
    const entry = timeline.items.find(
      (one: {
        event_type?: string;
        payload?: { attachment?: { id: number; filename: string } };
      }) =>
        one.event_type === "attachment_added" &&
        one.payload?.attachment?.id === clashing.id,
    );
    expect(entry?.payload?.attachment?.filename).toBe(clashing.filename);
  });

  it("puts the suffix before a compound extension", async () => {
    const first = await put(2, "rn178-bench.tar.gz");
    expect(first.filename).toBe("rn178-bench.tar.gz");
    const second = await put(2, "rn178-bench.tar.gz");
    expect(second.filename).toBe(`rn178-bench-${second.id}.tar.gz`);
    expect(second.url).toContain(`/download/rn178-bench-${second.id}.tar.gz`);
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

  function multipartUpload(
    name: string,
    content: string | Uint8Array<ArrayBuffer>,
    type = "text/plain",
  ) {
    const form = new FormData();
    form.set("file", new File([content], name, { type }));
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
      expect(res.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      const location = res.headers.get("location") as string;
      const parsed = new URL(location);
      expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
      expect(parsed.searchParams.get("response-content-disposition")).toContain(
        "redirected.txt",
      );
      expect(parsed.searchParams.get("response-content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      // The fake verifies SigV4 for real — a 200 proves the redirect target.
      const followed = await fetch(location);
      expect(followed.status).toBe(200);
      expect(await followed.text()).toBe("presigned bytes");
    }
  });

  // The presign is the only place the type policy can be enforced on this
  // backend — S3 replays response-content-* and nothing else, so a script
  // type here would come back from the store as one.
  it("presigns a js attachment as text/plain, and the store replays it", async () => {
    const attachment = await json(
      await multipartUpload("evil.js", "alert(1)", "text/javascript"),
    );
    const res = await t.app.request(attachment.url, { headers: { cookie } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") as string;
    expect(new URL(location).searchParams.get("response-content-type")).toBe(
      "text/plain; charset=utf-8",
    );

    const followed = await fetch(location);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await followed.text()).toBe("alert(1)");
  });

  it("presigns a png as an image and serves its bytes", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const attachment = await json(
      await multipartUpload("shot.png", bytes, "image/png"),
    );
    const res = await t.app.request(attachment.url, { headers: { cookie } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") as string;
    expect(new URL(location).searchParams.get("response-content-type")).toBe(
      "image/png",
    );

    const followed = await fetch(location);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await followed.arrayBuffer())).toEqual(bytes);
  });

  // The direct-upload ticket is the one path that can store a hostile type:
  // DirectUploadRequest.content_type is an unvalidated z.string(), while the
  // multipart route's File normalises an illegal type to "". Today this row
  // 500s on the fs backend and puts a raw CRLF into a presign parameter here.
  it("normalises a CRLF content_type declared on the ticket", async () => {
    const body = "hostile type";
    const ticket = await json(
      await requestDirect({
        filename: "hostile.txt",
        content_type: "text/plain\r\nX-Evil: 1",
        size: body.length,
      }),
    );
    const put = await fetch(ticket.url, { method: "PUT", body });
    expect(put.status).toBe(200);

    const attachment = await json(await complete(ticket.upload_id));
    const res = await t.app.request(attachment.url, { headers: { cookie } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") as string;
    expect(new URL(location).searchParams.get("response-content-type")).toBe(
      "application/octet-stream",
    );

    const followed = await fetch(location);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await followed.text()).toBe(body);
  });

  // The store decodes this parameter and replays it as the response header,
  // so a raw UTF-8 name here would land in a header on the far side (T-147).
  it("presigns a non-ASCII name as RFC 6266 parameters (T-147)", async () => {
    const attachment = await json(
      await multipartUpload("e2e-验收留证.txt", "presigned unicode"),
    );
    const res = await t.app.request(attachment.url, { headers: { cookie } });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") as string;
    const expected =
      'attachment; filename="e2e-____.txt"; ' +
      "filename*=UTF-8''e2e-%E9%AA%8C%E6%94%B6%E7%95%99%E8%AF%81.txt";
    expect(
      new URL(location).searchParams.get("response-content-disposition"),
    ).toBe(expected);

    const followed = await fetch(location);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-disposition")).toBe(expected);
    expect(await followed.text()).toBe("presigned unicode");
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

  // The ticket's filename is a declaration; the name is settled at complete,
  // by the same rule the multipart path uses (T-269).
  it("renames a clashing name on the direct path too", async () => {
    const first = await json(await multipartUpload("shared.txt", "first"));
    expect(first.filename).toBe("shared.txt");

    const body = "second";
    const ticket = await json(
      await requestDirect({
        filename: "shared.txt",
        content_type: "text/plain",
        size: body.length,
      }),
    );
    const put = await fetch(ticket.url, { method: "PUT", body });
    expect(put.status).toBe(200);

    const attachment = await json(await complete(ticket.upload_id));
    expect(attachment.filename).toBe(`shared-${attachment.id}.txt`);
    expect(attachment.url).toContain(`/download/shared-${attachment.id}.txt`);

    // A replayed complete converges on the row, name included.
    const replay = await json(await complete(ticket.upload_id));
    expect(replay.filename).toBe(attachment.filename);
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
