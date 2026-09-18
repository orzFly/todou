import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

type Who = Record<string, string>;
type Issue = { id: number; number: number; body: string };
type Comment = { id: number; body: string };
type TimelineEvent = {
  event_type?: string;
  payload?: Record<string, unknown>;
};

const A = "ref-valid-a";
const B = "ref-valid-b";
const C = "ref-valid-c";

describe("attached comment reference validity", () => {
  let t: TestApp;
  let owner: Who;
  let writer: Who;
  const projectId: Record<string, number> = {};

  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...who,
        ...init?.headers,
      },
    });

  const createIssue = async (
    slug: string,
    title: string,
    body = "",
    who: Who = writer,
  ): Promise<Issue> => {
    const res = await req(`/projects/${slug}/issues`, who, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return json<Issue>(res);
  };

  const addComment = async (
    slug: string,
    number: number,
    body: string,
    who: Who = writer,
  ): Promise<Comment> => {
    const res = await req(`/projects/${slug}/issues/${number}/comments`, who, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return json<Comment>(res);
  };

  const referenced = async (
    slug: string,
    number: number,
  ): Promise<TimelineEvent[]> => {
    const res = await req(
      `/projects/${slug}/issues/${number}/timeline?types=referenced&limit=100`,
      writer,
    );
    expect(res.status).toBe(200);
    return (await json<{ items: TimelineEvent[] }>(res)).items;
  };

  const canonical = (slug: string, number: number, commentId: number) =>
    `/projects/${projectId[slug]}/issues/${number}#comment-${commentId}`;

  beforeAll(async () => {
    t = await makeTestApp();
    owner = { cookie: await t.login() };
    const ordinary = await addUserWithToken(t.ctx, "ref-valid-writer");
    writer = ordinary.headers;

    for (const slug of [A, B, C]) {
      const created = await req("/projects", owner, {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
      projectId[slug] = (await json<{ id: number }>(created)).id;

      const member = await req(
        `/projects/${slug}/members/${ordinary.user.id}`,
        owner,
        {
          method: "PUT",
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("stores only a real parent/comment relation and references its parent once", async () => {
    const target = await createIssue(A, "legal comment target");
    const comment = await addComment(A, target.number, "the exact comment");
    const attached = `#${target.number}#comment-${comment.id}`;
    const explicit = `/projects/${A}/issues/${target.number}#comment-${comment.id}`;

    const source = await createIssue(
      A,
      "repeated legal anchors",
      `first ${attached}, again ${attached}, bare #comment-${comment.id}, and ` +
        `[chosen words](${explicit})`,
    );
    const href = canonical(A, target.number, comment.id);

    expect(source.body).toBe(
      `first [${attached}](${href}), again [${attached}](${href}), ` +
        `bare [#comment-${comment.id}](${href}), and ` +
        `[chosen words](${href})`,
    );
    const events = await referenced(A, target.number);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      by_project_id: projectId[A],
      by_issue: source.number,
    });
  });

  it("leaves a missing attached comment exactly authored and records no reference", async () => {
    const target = await createIssue(A, "missing comment parent");
    const authored =
      `missing #${target.number}#comment-999999999 and ` +
      `[keep these words](/projects/${A}/issues/${target.number}#comment-999999999)`;

    const source = await createIssue(A, "missing attached comment", authored);

    expect(source.body).toBe(authored);
    expect(await referenced(A, target.number)).toEqual([]);
  });

  it("leaves a comment attached to the wrong parent exactly authored", async () => {
    const target = await createIssue(A, "wrong parent target");
    const actualParent = await createIssue(A, "actual comment parent");
    const comment = await addComment(
      A,
      actualParent.number,
      "belongs elsewhere",
    );
    const authored =
      `wrong #${target.number}#comment-${comment.id} and ` +
      `[wrong parent](/projects/${A}/issues/${target.number}#comment-${comment.id})`;

    const source = await createIssue(A, "wrong attached parent", authored);

    expect(source.body).toBe(authored);
    expect(await referenced(A, target.number)).toEqual([]);
    expect(await referenced(A, actualParent.number)).toEqual([]);
  });

  it("keeps hidden and resolved comments referenceable", async () => {
    const hiddenParent = await createIssue(A, "hidden comment parent");
    const hidden = await addComment(
      A,
      hiddenParent.number,
      "settled discussion",
    );
    const hide = await req(
      `/projects/${A}/issues/${hiddenParent.number}/comments/hide`,
      writer,
      {
        method: "POST",
        body: JSON.stringify({ hidden: true, comment_ids: [hidden.id] }),
      },
    );
    expect(hide.status).toBe(200);

    const resolvedParent = await createIssue(A, "resolved comment parent");
    const push = await req(
      `/projects/${A}/issues/${resolvedParent.number}/spec/push`,
      owner,
      {
        method: "POST",
        body: JSON.stringify({
          files: [{ path: "design.md", body: "line one\nline two\n" }],
        }),
      },
    );
    expect(push.status).toBe(200);
    const review = await req(
      `/projects/${A}/issues/${resolvedParent.number}/spec/reviews`,
      writer,
      {
        method: "POST",
        body: JSON.stringify({
          version: 1,
          verdict: "request_changes",
          comments: [
            {
              anchor: {
                path: "design.md",
                version: 1,
                line_start: 1,
                line_end: 1,
              },
              body: "explain this line",
            },
          ],
        }),
      },
    );
    expect(review.status).toBe(201);
    const [resolvedId] = (await json<{ comment_ids: number[] }>(review))
      .comment_ids;
    if (resolvedId === undefined) throw new Error("review returned no comment");
    const resolve = await req(
      `/projects/${A}/issues/${resolvedParent.number}/spec/comments/resolve`,
      writer,
      {
        method: "POST",
        body: JSON.stringify({ comment_ids: [resolvedId] }),
      },
    );
    expect(resolve.status).toBe(200);

    const hiddenRef = `#${hiddenParent.number}#comment-${hidden.id}`;
    const resolvedRef = `#${resolvedParent.number}#comment-${resolvedId}`;
    const source = await createIssue(
      A,
      "settled comment references",
      `${hiddenRef} and ${resolvedRef}`,
    );

    expect(source.body).toBe(
      `[${hiddenRef}](${canonical(A, hiddenParent.number, hidden.id)}) and ` +
        `[${resolvedRef}](${canonical(A, resolvedParent.number, resolvedId)})`,
    );
    expect(await referenced(A, hiddenParent.number)).toHaveLength(1);
    expect(await referenced(A, resolvedParent.number)).toHaveLength(1);
  });

  it("translates a moved card's comment alias before checking the relation", async () => {
    const original = await createIssue(A, "comment moves with this card");
    const comment = await addComment(A, original.number, "carried comment");
    const moved = await req(
      `/projects/${A}/issues/${original.number}/move`,
      owner,
      {
        method: "POST",
        body: JSON.stringify({ to_project: B }),
      },
    );
    expect(moved.status).toBe(200);
    const movedNumber = (await json<{ moved_to: { number: number } }>(moved))
      .moved_to.number;

    const alias = await req(`/projects/${A}/comments/${comment.id}`, writer);
    expect(alias.status).toBe(301);
    const movedCommentId = (
      await json<{ moved_to: { comment_id: number } }>(alias)
    ).moved_to.comment_id;
    const authored = `${A}#${original.number}#comment-${comment.id}`;

    const source = await createIssue(
      A,
      "points through the old address",
      authored,
    );

    expect(source.body).toBe(
      `[${authored}](${canonical(B, movedNumber, movedCommentId)})`,
    );
    const events = await referenced(B, movedNumber);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      by_project_id: projectId[A],
      by_issue: source.number,
    });

    // A second moved comment has an alias into the same final project, but
    // it belongs to a different final card. An alias alone is not enough.
    const elsewhere = await createIssue(A, "other moved comment parent");
    const otherComment = await addComment(
      A,
      elsewhere.number,
      "different moved card",
    );
    const otherMove = await req(
      `/projects/${A}/issues/${elsewhere.number}/move`,
      owner,
      {
        method: "POST",
        body: JSON.stringify({ to_project: B }),
      },
    );
    expect(otherMove.status).toBe(200);
    const otherNumber = (
      await json<{ moved_to: { number: number } }>(otherMove)
    ).moved_to.number;
    const wrong = `${A}#${original.number}#comment-${otherComment.id}`;
    const invalid = await createIssue(A, "wrong moved alias", wrong);
    expect(invalid.body).toBe(wrong);
    expect(await referenced(B, movedNumber)).toHaveLength(1);
    expect(await referenced(B, otherNumber)).toEqual([]);
  });

  it("gates a moved comment by destination access, not the old project's membership", async () => {
    const original = await createIssue(A, "permission matrix target");
    const comment = await addComment(
      A,
      original.number,
      "permissioned comment",
    );
    const moved = await req(
      `/projects/${A}/issues/${original.number}/move`,
      owner,
      {
        method: "POST",
        body: JSON.stringify({ to_project: B }),
      },
    );
    expect(moved.status).toBe(200);
    const movedNumber = (await json<{ moved_to: { number: number } }>(moved))
      .moved_to.number;
    const alias = await req(`/projects/${A}/comments/${comment.id}`, writer);
    expect(alias.status).toBe(301);
    const movedCommentId = (
      await json<{ moved_to: { comment_id: number } }>(alias)
    ).moved_to.comment_id;
    const authored = `${A}#${original.number}#comment-${comment.id}`;

    for (const [label, access, resolves] of [
      ["source-only", [A, C], false],
      ["destination-only", [B, C], true],
      ["both", [A, B, C], true],
    ] as const) {
      const account = await addUserWithToken(t.ctx, `ref-valid-${label}`);
      for (const slug of access) {
        const member = await req(
          `/projects/${slug}/members/${account.user.id}`,
          owner,
          {
            method: "PUT",
            body: JSON.stringify({ role: "writer" }),
          },
        );
        expect(member.status).toBe(204);
      }

      const source = await createIssue(
        C,
        `reference from ${label}`,
        authored,
        account.headers,
      );
      expect(source.body).toBe(
        resolves
          ? `[${authored}](${canonical(B, movedNumber, movedCommentId)})`
          : authored,
      );
      const events = await referenced(B, movedNumber);
      expect(events).toHaveLength(resolves ? (label === "both" ? 2 : 1) : 0);
      if (resolves) {
        expect(
          events.find((event) => event.payload?.by_issue === source.number)
            ?.payload,
        ).toMatchObject({
          by_project_id: projectId[C],
          by_issue: source.number,
        });
      }
    }
  });
});
