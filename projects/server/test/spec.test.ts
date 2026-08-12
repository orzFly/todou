import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const V1 = [
  { path: "design.md", body: "# Design\n\nAlpha.\n" },
  { path: "notes/phases.md", body: "# Phases\n\nOne.\n" },
];

describe.each(PLACEMENTS)("spec #23 (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `spec-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Spec" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(): Promise<{ number: number }> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "host a spec" }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function push(number: number, body: unknown): Promise<Response> {
    return t.app.request(`/api/projects/${slug}/issues/${number}/spec/push`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
  }

  it("first push creates v1 with every file added", async () => {
    const { number } = await createIssue();
    const res = await push(number, { files: V1, message: "initial" });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result).toMatchObject({
      unchanged: false,
      version: 1,
      added: ["design.md", "notes/phases.md"],
      changed: [],
      removed: [],
    });

    const info = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}/spec`, {
        headers: headers(),
      }),
    );
    expect(info.current_version).toBe(1);
    expect(info.review_status).toBe("unreviewed");
    expect(info.unresolved_comments).toBe(0);
    expect(info.files.map((f: { path: string }) => f.path)).toEqual([
      "design.md",
      "notes/phases.md",
    ]);
    expect(info.versions).toHaveLength(1);
    expect(info.versions[0]).toMatchObject({ number: 1, message: "initial" });

    // The denormalized columns feed list/board badges (#47 surface).
    const issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue).toMatchObject({
      spec_version: 1,
      spec_review_status: "unreviewed",
      spec_unresolved_comments: 0,
    });

    // The push lands in the timeline as a spec_pushed event.
    const timeline = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/timeline?types=spec_pushed`,
        { headers: headers() },
      ),
    );
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0].payload).toMatchObject({
      version: 1,
      message: "initial",
      added: ["design.md", "notes/phases.md"],
    });
  });

  it("a change becomes v2 and classifies added/changed/removed", async () => {
    const { number } = await createIssue();
    expect((await push(number, { files: V1 })).status).toBe(200);
    const res = await push(number, {
      files: [
        { path: "design.md", body: "# Design\n\nBeta.\n" },
        { path: "extra.md", body: "New.\n" },
      ],
    });
    const result = await json(res);
    expect(result).toMatchObject({
      unchanged: false,
      version: 2,
      added: ["extra.md"],
      changed: ["design.md"],
      removed: ["notes/phases.md"],
    });

    // Old snapshots stay readable; current defaults to the newest.
    const v1 = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/files?version=1`,
        { headers: headers() },
      ),
    );
    expect(v1.version).toBe(1);
    expect(v1.files.map((f: { path: string }) => f.path)).toEqual([
      "design.md",
      "notes/phases.md",
    ]);
    expect(v1.files[0].body).toContain("Alpha");

    const current = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}/spec/files`, {
        headers: headers(),
      }),
    );
    expect(current.version).toBe(2);
    expect(current.files.map((f: { path: string }) => f.path)).toEqual([
      "design.md",
      "extra.md",
    ]);
  });

  it("an identical push is a no-op that creates no version", async () => {
    const { number } = await createIssue();
    expect((await push(number, { files: V1 })).status).toBe(200);
    const res = await push(number, { files: V1 });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ unchanged: true, version: 1 });

    const info = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}/spec`, {
        headers: headers(),
      }),
    );
    expect(info.versions).toHaveLength(1);
  });

  it("if_version mismatches conflict with the current number named", async () => {
    const { number } = await createIssue();
    expect((await push(number, { files: V1 })).status).toBe(200);
    const res = await push(number, {
      files: [{ path: "design.md", body: "x" }],
      if_version: 3,
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("v1");
  });

  it("rejects traversal, dotfiles, non-markdown, and duplicates by name", async () => {
    const { number } = await createIssue();
    for (const files of [
      [{ path: "../escape.md", body: "x" }],
      [{ path: ".hidden.md", body: "x" }],
      [{ path: "notes/../up.md", body: "x" }],
      [{ path: "/abs.md", body: "x" }],
      [{ path: "script.sh", body: "x" }],
      [
        { path: "dup.md", body: "a" },
        { path: "dup.md", body: "b" },
      ],
      [],
    ]) {
      const res = await push(number, { files });
      expect(res.status).toBe(422);
    }
    // Extra fields fail loudly with the path named (#19 convention).
    const res = await push(number, { files: V1, extra: true });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("extra");
  });

  it("issues without a spec 404 on info and files", async () => {
    const { number } = await createIssue();
    for (const path of [
      `/api/projects/${slug}/issues/${number}/spec`,
      `/api/projects/${slug}/issues/${number}/spec/files`,
    ]) {
      const res = await t.app.request(path, { headers: headers() });
      expect(res.status).toBe(404);
    }
  });

  it("unknown versions 404 with the number named", async () => {
    const { number } = await createIssue();
    expect((await push(number, { files: V1 })).status).toBe(200);
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/files?version=9`,
      { headers: headers() },
    );
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toContain("v9");
  });
});
