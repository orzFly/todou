import type { CommentComponent } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments } from "../src/db/project-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

// T-142: anchors may narrow to a column range inside their lines. The
// columns are 1-based inclusive UTF-16 code units — the unit `slice` uses,
// which is why a surrogate pair counts as two.
describe("spec anchor columns (T-142)", () => {
  let t: TestApp;
  let cookie: string;
  let agentHeaders: Record<string, string>;
  let projectId: number;
  const slug = "anchor-cols";
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
      body: JSON.stringify({ slug, name: "Anchor columns" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;
    const agent = await addUserWithToken(t.ctx, "cols-agent", {
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

  // Line 3 is CJK, line 4 is spaced English, line 5 carries an astral
  // emoji — one document covering all three column-counting hazards.
  const V1 = [
    "# 设计",
    "",
    "这是一个中文段落，需要微调其中的措辞。",
    "The quick brown fox jumps over the lazy dog.",
    "表情符号 🌱 在这里。",
    "",
  ].join("\n");

  async function push(number: number, body: string): Promise<number> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ files: [{ path: "design.md", body }] }),
      },
    );
    expect(res.status).toBe(200);
    return (await json(res)).version;
  }

  async function createIssueWithSpec(body = V1): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "spec host" }),
    });
    expect(res.status).toBe(201);
    const { number } = await json(res);
    await push(number, body);
    return number;
  }

  async function review(number: number, body: unknown) {
    return t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/reviews`,
      { method: "POST", headers: headers(), body: JSON.stringify(body) },
    );
  }

  async function listComments(number: number) {
    return json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/comments`,
        { headers: headers() },
      ),
    );
  }

  function annotation(
    anchor: Record<string, unknown>,
    body = "note",
  ): Record<string, unknown> {
    return { anchor: { path: "design.md", version: 1, ...anchor }, body };
  }

  it("quotes only the anchored columns, counting UTF-16 code units", async () => {
    const number = await createIssueWithSpec();
    const res = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [
        annotation(
          { line_start: 3, line_end: 3, col_start: 10, col_end: 13 },
          "cjk",
        ),
        annotation(
          { line_start: 4, line_end: 4, col_start: 5, col_end: 9 },
          "english",
        ),
        annotation(
          { line_start: 5, line_end: 5, col_start: 6, col_end: 7 },
          "emoji",
        ),
        annotation(
          { line_start: 3, line_end: 4, col_start: 10, col_end: 9 },
          "across lines",
        ),
        annotation({ line_start: 3, line_end: 3 }, "whole line"),
      ],
    });
    expect(res.status).toBe(201);

    const { items } = await listComments(number);
    const quoteOf = (body: string) =>
      items.find((i: { body: string }) => i.body === body).anchor.quote;
    expect(quoteOf("cjk")).toBe("需要微调");
    expect(quoteOf("english")).toBe("quick");
    // The pair is one glyph but two code units: col 6–7 is the whole emoji.
    expect(quoteOf("emoji")).toBe("🌱");
    expect(quoteOf("across lines")).toBe("需要微调其中的措辞。\nThe quick");
    expect(quoteOf("whole line")).toBe(
      "这是一个中文段落，需要微调其中的措辞。",
    );

    const wholeLine = items.find(
      (i: { body: string }) => i.body === "whole line",
    );
    expect(wholeLine.anchor.col_start).toBeNull();
    expect(wholeLine.anchor.col_end).toBeNull();
  });

  it("rejects columns past the end of their line", async () => {
    const number = await createIssueWithSpec();
    const res = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [
        annotation({ line_start: 3, line_end: 3, col_start: 10, col_end: 99 }),
      ],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("exceeds the anchored");
  });

  // T-169: `len` is the last legal column, `len + 1` is not the caret at end
  // of line. Line 1 is 5 characters, line 3 is one, line 4 is 13, and lines
  // 2 and 5 are empty — every edge of the inclusive contract in one file.
  describe("the edges of a line (T-169)", () => {
    const EDGES = ["start", "", "x", "the last line", ""].join("\n");

    it("accepts a column on the last character of its line", async () => {
      const number = await createIssueWithSpec(EDGES);
      const res = await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          annotation(
            { line_start: 1, line_end: 4, col_start: 5, col_end: 13 },
            "both ends at a line end",
          ),
          annotation(
            { line_start: 3, line_end: 3, col_start: 1, col_end: 1 },
            "the whole one-character line",
          ),
        ],
      });
      expect(res.status).toBe(201);

      const { items } = await listComments(number);
      const quoteOf = (body: string) =>
        items.find((i: { body: string }) => i.body === body).anchor.quote;
      expect(quoteOf("both ends at a line end")).toBe("t\n\nx\nthe last line");
      expect(quoteOf("the whole one-character line")).toBe("x");
    });

    it("rejects a start column one past the end of its line", async () => {
      const number = await createIssueWithSpec(EDGES);
      const res = await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          annotation({ line_start: 1, line_end: 4, col_start: 6, col_end: 13 }),
        ],
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.message).toContain("exceeds the anchored");
    });

    it("rejects an end column one past the end of its line", async () => {
      const number = await createIssueWithSpec(EDGES);
      const res = await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          annotation({ line_start: 1, line_end: 4, col_start: 5, col_end: 14 }),
        ],
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.message).toContain("exceeds the anchored");
    });

    it("rejects any column on an empty line", async () => {
      const number = await createIssueWithSpec(EDGES);
      const res = await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          annotation({ line_start: 2, line_end: 2, col_start: 1, col_end: 1 }),
        ],
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.message).toContain("exceeds the anchored");
    });
  });

  it("rejects columns on a file-level anchor", async () => {
    const number = await createIssueWithSpec();
    const res = await review(number, {
      version: 1,
      verdict: "request_changes",
      comments: [annotation({ col_start: 1, col_end: 2 })],
    });
    expect(res.status).toBe(422);
  });

  it("carries columns across a remap and drops them when outdated", async () => {
    const number = await createIssueWithSpec();
    expect(
      (
        await review(number, {
          version: 1,
          verdict: "request_changes",
          comments: [
            annotation(
              { line_start: 3, line_end: 3, col_start: 10, col_end: 13 },
              "survivor",
            ),
            annotation(
              { line_start: 4, line_end: 4, col_start: 5, col_end: 9 },
              "casualty",
            ),
          ],
        })
      ).status,
    ).toBe(201);

    // A paragraph inserted above shifts both anchors down two lines; the
    // English line is also rewritten, which outdates the anchor on it.
    await push(
      number,
      [
        "# 设计",
        "",
        "前言。",
        "",
        "这是一个中文段落，需要微调其中的措辞。",
        "The quick brown cat jumps over the lazy dog.",
        "表情符号 🌱 在这里。",
        "",
      ].join("\n"),
    );

    const { items } = await listComments(number);
    const survivor = items.find((i: { body: string }) => i.body === "survivor");
    expect(survivor.outdated).toBe(false);
    expect(survivor.current_line_start).toBe(5);
    expect(survivor.current_line_end).toBe(5);
    // Remap succeeded, so the line reads the same and the stored columns
    // still cut it correctly — there is no current_col_* to maintain.
    expect(survivor.anchor.col_start).toBe(10);
    expect(survivor.anchor.col_end).toBe(13);

    const casualty = items.find((i: { body: string }) => i.body === "casualty");
    expect(casualty.outdated).toBe(true);
    expect(casualty.current_line_start).toBeNull();
  });

  it("reads an anchor stored before columns existed", async () => {
    const number = await createIssueWithSpec();
    const submitted = await json(
      await review(number, {
        version: 1,
        verdict: "request_changes",
        comments: [
          annotation({
            line_start: 3,
            line_end: 3,
            col_start: 10,
            col_end: 13,
          }),
        ],
      }),
    );
    const commentId = submitted.comment_ids[0];

    // Rewrite the JSONB into the shape rows had before T-142: no column
    // keys whatsoever. drizzle casts this column rather than parsing it,
    // so nothing normalizes it on the way out but the service itself.
    const db = await t.ctx.router.forProject({
      id: projectId,
      slug,
      database_url: null,
    });
    const legacy = {
      type: "spec_comment",
      anchor: {
        path: "design.md",
        version: 1,
        line_start: 3,
        line_end: 3,
        quote: "这是一个中文段落，需要微调其中的措辞。",
      },
    } as unknown as CommentComponent;
    await db
      .update(comments)
      .set({ component: legacy })
      .where(
        and(eq(comments.projectId, projectId), eq(comments.id, commentId)),
      );

    const before = await listComments(number);
    const item = before.items.find(
      (i: { comment_id: number }) => i.comment_id === commentId,
    );
    expect(item.anchor.col_start).toBeNull();
    expect(item.anchor.col_end).toBeNull();
    expect(item.outdated).toBe(false);

    // And it still remaps: legacy anchors keep the pre-T-142 behaviour.
    await push(
      number,
      [
        "# 设计",
        "",
        "前言。",
        "",
        "这是一个中文段落，需要微调其中的措辞。",
        "The quick brown fox jumps over the lazy dog.",
        "表情符号 🌱 在这里。",
        "",
      ].join("\n"),
    );
    const after = await listComments(number);
    const remapped = after.items.find(
      (i: { comment_id: number }) => i.comment_id === commentId,
    );
    expect(remapped.outdated).toBe(false);
    expect(remapped.current_line_start).toBe(5);
    expect(remapped.anchor.col_start).toBeNull();
  });
});
