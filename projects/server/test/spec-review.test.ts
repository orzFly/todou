import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remapLineRange } from "../src/services/spec.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("remapLineRange", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps identical bodies as-is", () => {
    expect(remapLineRange(TEN, TEN, 2, 3)).toEqual({
      outdated: false,
      start: 2,
      end: 3,
    });
  });

  it("shifts ranges below an insertion", () => {
    const withHeader = `header a\nheader b\n${TEN}`;
    expect(remapLineRange(TEN, withHeader, 4, 5)).toEqual({
      outdated: false,
      start: 6,
      end: 7,
    });
  });

  it("keeps ranges above a change untouched", () => {
    const tailEdit = TEN.replace("line 9", "line nine");
    expect(remapLineRange(TEN, tailEdit, 2, 3)).toEqual({
      outdated: false,
      start: 2,
      end: 3,
    });
  });

  it("outdates ranges overlapping an edit", () => {
    const midEdit = TEN.replace("line 3", "line three");
    expect(remapLineRange(TEN, midEdit, 2, 4).outdated).toBe(true);
  });

  it("outdates ranges split by an insertion inside them", () => {
    const lines = TEN.split("\n");
    lines.splice(2, 0, "inserted");
    expect(remapLineRange(TEN, lines.join("\n"), 2, 4).outdated).toBe(true);
  });

  it("outdates ranges whose lines were deleted", () => {
    const lines = TEN.split("\n");
    lines.splice(1, 2);
    expect(remapLineRange(TEN, lines.join("\n"), 2, 3).outdated).toBe(true);
  });
});

describe("spec review loop T-23", () => {
  let t: TestApp;
  let cookie: string;
  let agentHeaders: Record<string, string>;
  const slug = "spec-review";
  const headers = () => ({ "content-type": "application/json", cookie });
  const asAgent = () => ({
    "content-type": "application/json",
    ...agentHeaders,
  });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Spec review" }),
    });
    expect(res.status).toBe(201);
    const agent = await addUserWithToken(t.ctx, "spec-agent", {
      kind: "machine",
    });
    agentHeaders = agent.headers;
    const member = await t.app.request(
      `/api/projects/${slug}/members/${agent.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const DESIGN_V1 =
    "# Design\n\nAnchors point at (file, version, lines).\nResolve is one-way.\nApprovals reset on push.\n";

  async function createIssueWithSpec(): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "spec host" }),
    });
    expect(res.status).toBe(201);
    const { number } = await json(res);
    const push = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({
          files: [{ path: "design.md", body: DESIGN_V1 }],
        }),
      },
    );
    expect(push.status).toBe(200);
    return number;
  }

  async function review(
    number: number,
    body: unknown,
    who: Record<string, string> = headers(),
  ) {
    return t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/reviews`,
      { method: "POST", headers: who, body: JSON.stringify(body) },
    );
  }

  it("submits verdict + summary + inline comments atomically", async () => {
    const number = await createIssueWithSpec();
    const res = await review(number, {
      version: 1,
      verdict: "request_changes",
      body: "Two nits, otherwise fine.",
      comments: [
        {
          anchor: { path: "design.md", version: 1, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
        {
          anchor: { path: "design.md", version: 1, line_start: 5, line_end: 5 },
          body: "Say this louder in the intro.",
        },
      ],
    });
    expect(res.status).toBe(201);
    const result = await json(res);
    expect(result.verdict).toBe("request_changes");
    expect(result.comment_ids).toHaveLength(2);
    expect(result.summary_comment_id).not.toBeNull();

    // The quote is stamped server-side from the stored version.
    const comments = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
    expect(comments.current_version).toBe(1);
    expect(comments.items).toHaveLength(2);
    expect(comments.items[0].anchor.quote).toBe(
      "Anchors point at (file, version, lines).\nResolve is one-way.",
    );
    expect(comments.items[0].outdated).toBe(false);
    expect(comments.items[0].current_line_start).toBe(3);
    expect(comments.items[0].resolved).toBeNull();

    // Denormalized columns + event payload.
    const issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue.spec_review_status).toBe("changes_requested");
    expect(issue.spec_unresolved_comments).toBe(2);

    const timeline = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/timeline?types=spec_review`,
        { headers: headers() },
      ),
    );
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0].payload).toMatchObject({
      version: 1,
      verdict: "request_changes",
      annotation_count: 2,
    });
  });

  it("rejects the pusher reviewing their own version", async () => {
    const number = await createIssueWithSpec();
    const res = await review(
      number,
      { version: 1, verdict: "approve" },
      asAgent(),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toContain("pushed by this account");
  });

  it("conflicts when the spec moved under the review", async () => {
    const number = await createIssueWithSpec();
    const res = await review(number, { version: 9, verdict: "approve" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("v1");
  });

  it("validates anchors against the stored version", async () => {
    const number = await createIssueWithSpec();
    const badPath = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [
        {
          anchor: { path: "ghost.md", version: 1, line_start: 1, line_end: 1 },
          body: "?",
        },
      ],
    });
    expect(badPath.status).toBe(422);
    expect((await json(badPath)).error.message).toContain("ghost.md");

    const badLines = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [
        {
          anchor: {
            path: "design.md",
            version: 1,
            line_start: 90,
            line_end: 99,
          },
          body: "?",
        },
      ],
    });
    expect(badLines.status).toBe(422);
    expect((await json(badLines)).error.message).toContain("exceeds the file");
  });

  it("approval lands on the columns and a later push resets it", async () => {
    const number = await createIssueWithSpec();
    expect(
      (await review(number, { version: 1, verdict: "approve" })).status,
    ).toBe(201);
    let issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue.spec_review_status).toBe("approved");

    const push = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({
          files: [{ path: "design.md", body: `${DESIGN_V1}\nMore.\n` }],
        }),
      },
    );
    expect(push.status).toBe(200);
    issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue.spec_review_status).toBe("unreviewed");
    expect(issue.spec_version).toBe(2);
  });

  it("resolve is one-way, batched into one event, and feeds the counter", async () => {
    const number = await createIssueWithSpec();
    const submitted = await json(
      await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          {
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 3,
              line_end: 3,
            },
            body: "a",
          },
          {
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 4,
              line_end: 4,
            },
            body: "b",
          },
        ],
      }),
    );

    const resolve = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/comments/resolve`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ comment_ids: submitted.comment_ids }),
      },
    );
    expect(resolve.status).toBe(200);

    const issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue.spec_unresolved_comments).toBe(0);

    const events = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/timeline?types=spec_comments_resolved`,
        { headers: headers() },
      ),
    );
    expect(events.items).toHaveLength(1);
    expect(events.items[0].payload.comment_ids).toEqual(submitted.comment_ids);

    const again = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/comments/resolve`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ comment_ids: [submitted.comment_ids[0]] }),
      },
    );
    expect(again.status).toBe(409);
    expect((await json(again)).error.message).toContain("already resolved");

    const list = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
    expect(
      list.items.every((i: { resolved: unknown }) => i.resolved !== null),
    ).toBe(true);
  });

  it("outdates anchors whose lines changed and remaps the rest", async () => {
    const number = await createIssueWithSpec();
    const submitted = await json(
      await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          {
            // Line 3 will be rewritten in v2 → outdated.
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 3,
              line_end: 3,
            },
            body: "will outdate",
          },
          {
            // Line 5 survives v2 but shifts down by the two inserted lines.
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 5,
              line_end: 5,
            },
            body: "will remap",
          },
        ],
      }),
    );
    expect(submitted.comment_ids).toHaveLength(2);

    const v2 =
      "# Design\n\nintro one\nintro two\nAnchors point at (file, version, lines) — reworded.\nResolve is one-way.\nApprovals reset on push.\n";
    const push = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ files: [{ path: "design.md", body: v2 }] }),
      },
    );
    expect(push.status).toBe(200);

    const list = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
    expect(list.current_version).toBe(2);
    const byBody = new Map(
      list.items.map((i: { body: string }) => [i.body, i]),
    );
    const gone = byBody.get("will outdate") as {
      outdated: boolean;
      current_line_start: number | null;
    };
    expect(gone.outdated).toBe(true);
    expect(gone.current_line_start).toBeNull();
    const moved = byBody.get("will remap") as {
      outdated: boolean;
      current_line_start: number | null;
    };
    expect(moved.outdated).toBe(false);
    expect(moved.current_line_start).toBe(7);
  });

  it("deleting an unresolved spec comment returns its count", async () => {
    const number = await createIssueWithSpec();
    const submitted = await json(
      await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          {
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 3,
              line_end: 3,
            },
            body: "to be deleted",
          },
        ],
      }),
    );
    const del = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${submitted.comment_ids[0]}`,
      { method: "DELETE", headers: headers() },
    );
    expect(del.status).toBe(204);
    const issue = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: headers(),
      }),
    );
    expect(issue.spec_unresolved_comments).toBe(0);
  });

  it("spec comments cannot be created through a plain comment POST", async () => {
    const number = await createIssueWithSpec();
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          body: "forged",
          component: {
            type: "spec_comment",
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 1,
              line_end: 1,
              quote: "forged quote",
            },
          },
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  it("file-level comments: no lines, empty quote, outdated only when the file goes", async () => {
    const number = await createIssueWithSpec();
    const badHalf = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [
        {
          anchor: { path: "design.md", version: 1, line_start: 2 },
          body: "half an anchor",
        },
      ],
    });
    expect(badHalf.status).toBe(422);
    expect((await json(badHalf)).error.message).toContain("file-level");

    const submitted = await json(
      await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          {
            anchor: { path: "design.md", version: 1 },
            body: "whole-file remark",
          },
        ],
      }),
    );
    expect(submitted.comment_ids).toHaveLength(1);

    let list = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
    const item = list.items.find(
      (i: { body: string }) => i.body === "whole-file remark",
    );
    expect(item.anchor.line_start).toBeNull();
    expect(item.anchor.quote).toBe("");
    expect(item.outdated).toBe(false);
    expect(item.current_line_start).toBeNull();

    // Push a version WITHOUT the file: the file-level comment outdates.
    const push = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({
          files: [{ path: "other.md", body: "replacement\n" }],
        }),
      },
    );
    expect(push.status).toBe(200);
    list = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
    const after = list.items.find(
      (i: { body: string }) => i.body === "whole-file remark",
    );
    expect(after.outdated).toBe(true);
  });
});
