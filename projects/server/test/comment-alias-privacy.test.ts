import { randomUUID } from "node:crypto";
import {
  AnswersSubmitInput,
  CommentCreateInput,
  CommentUpdateInput,
  Issue,
  MoveIssueResult,
  Project,
  RevisionPage,
  TimelineComment,
  TimelinePage,
} from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments } from "../src/db/project-schema.ts";
import { issueAddresses, movedIds } from "../src/db/system-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type PlacementMode,
  type TestApp,
} from "./helpers.ts";

type Who = Record<string, string>;
type Card = {
  slug: string;
  number: number;
  issueId: number;
  commentId: number;
  before: string;
  after: string;
};

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const MISSING = 999_999;
const METHODS = ["GET", "HEAD"] as const;
const TAILS = ["", "/revisions"] as const;
const JSON_HEADERS = [
  ["content-type", "application/json"],
  ["vary", "Accept-Encoding"],
];
const PROJECT_404 =
  '{"error":{"code":"not_found","message":"project not found"}}';
const ISSUE_404 = '{"error":{"code":"not_found","message":"issue not found"}}';
const COMMENT_404 =
  '{"error":{"code":"not_found","message":"comment not found"}}';
const QUESTION = {
  type: "questions" as const,
  questions: [
    {
      key: "choice",
      question: "Which option?",
      options: [{ label: "First" }, { label: "Second" }],
    },
  ],
};

const observe = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  headers: [...response.headers.entries()],
  redirected: response.redirected,
});
const expected = (status: number, body: string, method = "GET") => ({
  status,
  body: method === "HEAD" ? "" : body,
  // Compression bypasses HEAD, so only GET gains Vary: Accept-Encoding.
  headers:
    method === "HEAD" ? [["content-type", "application/json"]] : JSON_HEADERS,
  redirected: false,
});
const issuePath = (slug: string, number: number) =>
  `/api/projects/${slug}/issues/${number}`;
const commentPath = (card: Pick<Card, "slug" | "number" | "commentId">) =>
  `${issuePath(card.slug, card.number)}/comments/${card.commentId}`;
const barePath = (card: Pick<Card, "slug" | "commentId">) =>
  `/api/projects/${card.slug}/comments/${card.commentId}`;

function privacySuite(placement: PlacementMode, systemUrl?: string) {
  let t: TestApp;
  let admin: Who;
  let reader: Who;
  let source: Who;
  let neither: Who;
  // PostgreSQL persists across runs, including users and old issue addresses.
  const run = randomUUID().slice(0, 8);
  const A = `cap-a-${run}`;
  const B = `cap-b-${run}`;
  const C = `cap-c-${run}`;
  const D = `cap-d-${run}`;
  const absent = `cap-absent-${run}`;
  const projects = new Map<string, Project>();
  let old: Card;
  let destination: Card;
  let active: Card;
  let privateOld: Card;
  let sameTargetOld: Card;
  let sameTarget: Card;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(path, {
      ...init,
      redirect: "manual",
      headers: {
        ...who,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
    });
  const write = (path: string, method: string, body?: unknown) =>
    req(path, admin, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = (slug: string) => {
    const found = projects.get(slug);
    if (!found) throw new Error(`unseeded project: ${slug}`);
    return found;
  };

  const assertContent = async (card: Card, who: Who) => {
    const comment = await req(commentPath(card), who);
    expect(comment.status).toBe(200);
    expect(TimelineComment.parse(await comment.json())).toMatchObject({
      id: card.commentId,
      body: card.after,
      component: { type: "questions" },
    });
    const revisions = await req(`${commentPath(card)}/revisions`, who);
    expect(revisions.status).toBe(200);
    expect(RevisionPage.parse(await revisions.json()).items).toEqual([
      expect.objectContaining({
        body_before: card.before,
        body_after: card.after,
      }),
    ]);
  };

  const seed = async (slug: string, title: string): Promise<Card> => {
    const created = await write(`/api/projects/${slug}/issues`, "POST", {
      title,
    });
    expect(created.status).toBe(201);
    const issue = Issue.parse(await created.json());
    const before = `${title}: before`;
    const after = `${title}: after`;
    const commented = await write(
      `${issuePath(slug, issue.number)}/comments`,
      "POST",
      CommentCreateInput.parse({ body: before, component: QUESTION }),
    );
    expect(commented.status).toBe(201);
    const comment = TimelineComment.parse(await commented.json());
    const card = {
      slug,
      number: issue.number,
      issueId: issue.id,
      commentId: comment.id,
      before,
      after,
    };
    const edited = await write(commentPath(card), "PATCH", { body: after });
    expect(edited.status).toBe(200);
    await assertContent(card, admin);
    return card;
  };

  const move = async (card: Card, slug: string): Promise<Card> => {
    const moved = await write(
      `${issuePath(card.slug, card.number)}/move`,
      "POST",
      {
        to_project: slug,
      },
    );
    expect(moved.status).toBe(200);
    const result = MoveIssueResult.parse(await moved.json());
    expect(result.moved_to.slug).toBe(slug);
    if (!result.issue)
      throw new Error("move did not return its destination issue");
    expect(result.moved_to.number).toBe(result.issue.number);
    const timeline = await req(
      `${issuePath(slug, result.issue.number)}/timeline`,
      admin,
    );
    expect(timeline.status).toBe(200);
    const matches = TimelinePage.parse(await timeline.json()).items.filter(
      (item) => item.type === "comment" && item.body === card.after,
    );
    expect(matches).toHaveLength(1);
    const arrived = TimelineComment.parse(matches[0]);
    const next = {
      ...card,
      slug,
      number: result.issue.number,
      issueId: result.issue.id,
      commentId: arrived.id,
    };
    await assertContent(next, admin);
    const tombstone = await req(issuePath(card.slug, card.number), admin);
    expect(tombstone.status).toBe(301);
    expect(await tombstone.json()).toEqual({
      moved_to: { slug, number: next.number },
    });
    const alias = await req(commentPath(card), admin);
    expect(alias.status).toBe(301);
    expect(await alias.json()).toEqual({
      moved_to: { slug, number: next.number, comment_id: next.commentId },
    });
    return next;
  };

  const assertRedirect = async (
    from: string,
    to: Card,
    who: Who,
    tail = "",
  ) => {
    for (const method of METHODS) {
      const response = await req(`${from}${tail}`, who, { method });
      expect(response.status, `${method} ${from}${tail}`).toBe(301);
      expect(response.redirected).toBe(false);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const url = new URL(location as string, `http://localhost${from}${tail}`);
      expect(`${url.pathname}${url.search}`).toBe(`${commentPath(to)}${tail}`);
      expect(await response.text()).toBe(
        method === "HEAD"
          ? ""
          : JSON.stringify({
              moved_to: {
                slug: to.slug,
                number: to.number,
                comment_id: to.commentId,
              },
            }),
      );
      const followed = await req(url.pathname + url.search, who, { method });
      const direct = await req(`${commentPath(to)}${tail}`, who, { method });
      const seen = await observe(followed);
      expect(seen.status).toBe(200);
      expect(seen).toEqual(await observe(direct));
      if (method === "HEAD") expect(seen.body).toBe("");
    }
    await assertContent(to, who);
  };

  const assertPrivateReads = async (paths: string[]) => {
    for (const method of METHODS) {
      for (const tail of TAILS) {
        const baseline = await observe(
          await req(`${commentPath({ ...old, slug: absent })}${tail}`, reader, {
            method,
          }),
        );
        expect(baseline).toEqual(expected(404, PROJECT_404, method));
        for (const path of paths) {
          const seen = await observe(
            await req(`${path}${tail}`, reader, { method }),
          );
          expect(seen, `${method} ${path}${tail}`).toEqual(baseline);
        }
      }
    }
  };

  beforeAll(async () => {
    t = await makeTestApp(placement, systemUrl ? { systemUrl } : undefined);
    admin = { cookie: await t.login() };
    for (const slug of [A, B, C, D]) {
      const created = await write("/api/projects", "POST", {
        slug,
        name: slug,
      });
      expect(created.status).toBe(201);
      projects.set(slug, Project.parse(await created.json()));
    }
    for (const [name, slug] of [
      ["reader", B],
      ["source", A],
      ["neither", null],
    ] as const) {
      const user = await addUserWithToken(t.ctx, `cap-${name}-${run}`);
      expect(user.user.isInstanceAdmin).toBe(false);
      if (name === "reader") reader = user.headers;
      if (name === "source") source = user.headers;
      if (name === "neither") neither = user.headers;
      if (slug !== null) {
        const member = await write(
          `/api/projects/${slug}/members/${user.user.id}`,
          "PUT",
          {
            role: "reader",
          },
        );
        expect(member.status).toBe(204);
      }
    }
    old = await seed(A, "visible lineage");
    active = await seed(A, "stays private in A");
    privateOld = await seed(A, "unrelated private lineage");
    sameTargetOld = await seed(A, "different lineage in B");
    destination = await move(old, B);
    await move(privateOld, C);
    sameTarget = await move(sameTargetOld, B);
    expect(sameTarget.number).not.toBe(destination.number);
    expect(sameTarget.commentId).not.toBe(destination.commentId);
    for (const slug of [A, B]) {
      expect(await observe(await req(issuePath(slug, MISSING), admin))).toEqual(
        expected(404, ISSUE_404),
      );
    }
    expect(await observe(await req(`/api/projects/${absent}`, admin))).toEqual(
      expected(404, PROJECT_404),
    );
  });

  afterAll(async () => t?.cleanup());

  it("binds an old comment to its exact issue lineage, with indistinguishable private GET/HEAD responses", async () => {
    // Removing the binding turns the private tombstones into 301s to B.
    // Checking only projectId still lets the second A→B lineage through.
    // One ordinary reader and one old id: only the parent changes.
    await assertPrivateReads(
      [privateOld.number, sameTargetOld.number, active.number, MISSING].map(
        (number) => commentPath({ ...old, number }),
      ),
    );
    for (const tail of TAILS) {
      expect(
        await observe(
          await req(
            `${commentPath({ ...old, number: sameTargetOld.number })}${tail}`,
            source,
          ),
        ),
      ).toEqual(expected(404, COMMENT_404));
    }
  });

  it("preserves destination-only 301, source-only 410, neither 404 and bare aliases", async () => {
    for (const tail of TAILS) {
      await assertRedirect(commentPath(old), destination, reader, tail);
      for (const method of METHODS) {
        expect(
          await observe(
            await req(`${commentPath(old)}${tail}`, source, { method }),
          ),
        ).toEqual(expected(410, '{"moved":true}', method));
        expect(
          await observe(
            await req(`${commentPath(old)}${tail}`, neither, { method }),
          ),
        ).toEqual(expected(404, PROJECT_404, method));
      }
    }
    await assertRedirect(barePath(old), destination, reader);
  });

  it("keeps valid comment and component writes scoped to the same B-only reader", async () => {
    const patch = CommentUpdateInput.parse({ body: "valid replacement" });
    const plain = CommentCreateInput.parse({ body: "valid new comment" });
    const component = CommentCreateInput.parse({
      body: "valid question",
      component: QUESTION,
    });
    const answers = AnswersSubmitInput.parse({
      answers: [{ key: "choice", selected: [0] }],
    });
    const writes = [
      {
        method: "PATCH",
        suffix: `/comments/${old.commentId}`,
        body: patch,
        capability: "comment.modify",
        role: "reporter",
      },
      {
        method: "DELETE",
        suffix: `/comments/${old.commentId}`,
        capability: "comment.modify",
        role: "reporter",
      },
      {
        method: "POST",
        suffix: "/comments",
        body: plain,
        capability: "comment.create",
        role: "reporter",
      },
      {
        method: "POST",
        suffix: "/comments",
        body: component,
        capability: "comment.create",
        role: "reporter",
      },
      {
        method: "POST",
        suffix: `/comments/${old.commentId}/answers`,
        body: answers,
        capability: "question.answer",
        role: "writer",
      },
    ];
    for (const action of writes) {
      const init = {
        method: action.method,
        ...(action.body ? { body: JSON.stringify(action.body) } : {}),
      };
      const baseline = await observe(
        await req(
          `${issuePath(absent, old.number)}${action.suffix}`,
          reader,
          init,
        ),
      );
      expect(baseline).toEqual(expected(404, PROJECT_404));
      for (const number of [
        old.number,
        privateOld.number,
        sameTargetOld.number,
        active.number,
        MISSING,
      ]) {
        const path = `${issuePath(A, number)}${action.suffix}`;
        expect(
          await observe(await req(path, reader, init)),
          `${action.method} ${path}`,
        ).toEqual(baseline);
      }
      const suffix = action.suffix.replace(
        String(old.commentId),
        String(destination.commentId),
      );
      expect(
        await observe(
          await req(
            `${issuePath(B, destination.number)}${suffix}`,
            reader,
            init,
          ),
        ),
      ).toEqual(
        expected(
          403,
          JSON.stringify({
            error: {
              code: "forbidden",
              message: `requires ${action.role} role (${action.capability})`,
            },
          }),
        ),
      );
    }
    await assertContent(destination, reader);
  });

  it("retains useful issue and comment diagnostics for project members", async () => {
    for (const method of METHODS) {
      for (const tail of TAILS) {
        for (const [number, body] of [
          [MISSING, ISSUE_404],
          [destination.number, COMMENT_404],
        ] as const) {
          const path = `${commentPath({ slug: B, number, commentId: MISSING })}${tail}`;
          expect(await observe(await req(path, reader, { method }))).toEqual(
            expected(404, body, method),
          );
        }
      }
    }
  });

  it("fails closed when a real alias has lost its parent address", async () => {
    const system = t.ctx.router.system();
    const predicate = and(
      eq(issueAddresses.projectId, project(A).id),
      eq(issueAddresses.number, old.number),
    );
    const rows = await system.select().from(issueAddresses).where(predicate);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("missing seeded address");
    expect(row).toMatchObject({
      currentProjectId: project(B).id,
      currentNumber: destination.number,
    });
    const { id: _id, ...saved } = row;
    try {
      expect(
        await system.delete(issueAddresses).where(predicate).returning(),
      ).toHaveLength(1);
      await assertPrivateReads([commentPath(old)]);
      // Bare locate has no issue parent to bind, so its valid alias survives.
      await assertRedirect(barePath(old), destination, reader);
    } finally {
      expect(
        await system.insert(issueAddresses).values(saved).returning(),
      ).toHaveLength(1);
    }
    await assertRedirect(commentPath(old), destination, reader, "/revisions");
  });

  if (placement !== "dedicated") {
    it("rejects aliased comments and parents owned by another co-located project", async () => {
      const route = (slug: string) => ({
        id: project(slug).id,
        slug,
        database_url: null,
      });
      expect(t.ctx.router.resolveProjectUrl(route(B))).toBe(
        t.ctx.router.resolveProjectUrl(route(D)),
      );
      const foreign = await seed(D, "co-located private comment");
      // Equal numbers make the parent-number check pass if either ownership
      // predicate is removed. Different project IDs must still reject it.
      expect(foreign.number).toBe(destination.number);
      const db = await t.ctx.router.forProject(route(B));
      const system = t.ctx.router.system();
      const aliasWhere = and(
        eq(movedIds.kind, "comment"),
        eq(movedIds.projectId, project(A).id),
        eq(movedIds.refId, old.commentId),
      );
      const aliases = await system.select().from(movedIds).where(aliasWhere);
      expect(aliases).toHaveLength(1);
      expect(aliases[0]).toMatchObject({
        currentProjectId: project(B).id,
        currentId: destination.commentId,
      });
      const commentWhere = eq(comments.id, foreign.commentId);
      const rows = await db.select().from(comments).where(commentWhere);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        projectId: project(D).id,
        issueId: foreign.issueId,
      });
      try {
        expect(
          await system
            .update(movedIds)
            .set({ currentId: foreign.commentId })
            .where(aliasWhere)
            .returning(),
        ).toHaveLength(1);
        for (const ownership of [
          { projectId: project(D).id, issueId: foreign.issueId },
          { projectId: project(D).id, issueId: destination.issueId },
          { projectId: project(B).id, issueId: foreign.issueId },
        ]) {
          expect(
            await db
              .update(comments)
              .set(ownership)
              .where(commentWhere)
              .returning(),
          ).toHaveLength(1);
          await assertPrivateReads([commentPath(old)]);
          for (const method of METHODS) {
            expect(
              await observe(await req(barePath(old), reader, { method })),
            ).toEqual(expected(404, PROJECT_404, method));
          }
        }
      } finally {
        await db
          .update(comments)
          .set({ projectId: project(D).id, issueId: foreign.issueId })
          .where(commentWhere);
        await system
          .update(movedIds)
          .set({ currentId: destination.commentId })
          .where(aliasWhere);
      }
      await assertContent(foreign, admin);
      await assertRedirect(commentPath(old), destination, reader, "/revisions");
    });
  }

  it("preserves destination trash visibility after a legal alias redirect", async () => {
    const start = await seed(A, "trashed after moving");
    const inB = await move(start, B);
    expect((await write(issuePath(B, inB.number), "DELETE")).status).toBe(204);
    const trashed = await req(issuePath(B, inB.number), admin);
    expect(trashed.status).toBe(200);
    expect(Issue.parse(await trashed.json()).deleted_at).not.toBeNull();
    for (const tail of TAILS) {
      for (const method of METHODS) {
        const response = await req(`${commentPath(start)}${tail}`, reader, {
          method,
        });
        expect(response.status).toBe(301);
        expect(response.redirected).toBe(false);
        const location = response.headers.get("location");
        expect(location).not.toBeNull();
        const url = new URL(
          location as string,
          `http://localhost${commentPath(start)}${tail}`,
        );
        expect(url.pathname).toBe(`${commentPath(inB)}${tail}`);
        const followed = await observe(
          await req(url.pathname, reader, { method }),
        );
        expect(followed).toEqual(expected(404, ISSUE_404, method));
        expect(followed).toEqual(
          await observe(
            await req(`${commentPath(inB)}${tail}`, reader, { method }),
          ),
        );
      }
      await assertRedirect(commentPath(start), inB, admin, tail);
    }
  });

  it("preserves multi-hop and return aliases while rejecting wrong active parents on both miss paths", async () => {
    const start = await seed(A, "round trip");
    const inB = await move(start, B);
    for (const tail of TAILS)
      await assertRedirect(commentPath(start), inB, reader, tail);
    const inC = await move(inB, C);
    for (const tail of TAILS) {
      await assertRedirect(commentPath(start), inC, admin, tail);
      for (const method of METHODS) {
        // The SAME B-only reader is now source-only at B and neither at A.
        expect(
          await observe(
            await req(`${commentPath(inB)}${tail}`, reader, { method }),
          ),
        ).toEqual(expected(410, '{"moved":true}', method));
        expect(
          await observe(
            await req(`${commentPath(start)}${tail}`, reader, { method }),
          ),
        ).toEqual(expected(404, PROJECT_404, method));
      }
    }
    await assertRedirect(barePath(start), inC, admin);
    const back = await move(inC, A);
    expect(back.number).toBe(start.number);
    expect(back.commentId).not.toBe(start.commentId);
    expect((await req(issuePath(A, active.number), source)).status).toBe(200);
    for (const tail of TAILS) {
      for (const from of [start, inB, inC])
        await assertRedirect(commentPath(from), back, source, tail);
      for (const method of METHODS) {
        const wrongParent = `${commentPath({ ...start, number: active.number })}${tail}`;
        expect(
          await observe(await req(wrongParent, source, { method })),
        ).toEqual(expected(404, COMMENT_404, method));
        expect(
          await observe(await req(wrongParent, reader, { method })),
        ).toEqual(expected(404, PROJECT_404, method));
      }
    }
    for (const from of [start, inB, inC])
      await assertRedirect(barePath(from), back, source);
  });
}

describe.each(PLACEMENTS)(
  "comment alias privacy (%s placement)",
  (placement) => {
    privacySuite(placement);
  },
);
describe.skipIf(!PG_URL)(
  "comment alias privacy (real PostgreSQL shared placement)",
  () => {
    privacySuite("shared", PG_URL);
  },
);
