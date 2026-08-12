import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitizeFilename } from "../src/services/attachments.ts";
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

  it("serves the view route inline with a CSP sandbox (#58)", async () => {
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
