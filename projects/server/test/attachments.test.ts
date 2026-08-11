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
    expect(attachment.url).toContain(`/projects/${slug}/attachments/`);

    const download = await t.app.request(attachment.url, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("potato bytes");
    expect(download.headers.get("content-type")).toContain("text/plain");
    expect(download.headers.get("content-disposition")).toContain("notes.txt");
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
