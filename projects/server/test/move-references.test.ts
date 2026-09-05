import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comments,
  issueEvents,
  issues,
  revisions,
  specVersionFiles,
  specVersions,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * A move no longer touches a single byte of text or a single reference event
 * (T-266). It could stop, because a reference is stored as a link onto
 * `(project id, number)` and both halves outlive every move: the id never
 * changes, and the number is answered by the address book.
 *
 * These are the scenarios T-231 and T-247 locked down while the move DID
 * rewrite things. The scenarios still matter; the answer they lock is the
 * opposite one, so they are stated here rather than deleted.
 */
describe.each(PLACEMENTS)("move and references (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  const A = `mvr-a-${placement}`;
  const B = `mvr-b-${placement}`;
  const C = `mvr-c-${placement}`;
  const id: Record<string, number> = {};

  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", cookie }
        : { cookie },
    });

  const dbOf = async (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: id[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  const createIssue = async (slug: string, title: string, body = "") => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number; body: string };
  };

  const addComment = async (slug: string, number: number, body: string) => {
    const res = await req(`/projects/${slug}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; body: string };
  };

  const move = async (from: string, number: number, to: string) => {
    const res = await req(`/projects/${from}/issues/${number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
    expect(res.status).toBe(200);
    return (await json(res)) as { moved_to: { slug: string; number: number } };
  };

  const landed = async (slug: string, number: number) => {
    const db = await dbOf(slug);
    const [row] = await db
      .select({
        id: issues.id,
        body: issues.body,
        bodyEditedAt: issues.bodyEditedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, id[slug] as number),
          eq(issues.number, number),
        ),
      );
    if (row === undefined) throw new Error("landed issue missing");
    return { db, ...row };
  };

  const timelineOf = async (slug: string, number: number) =>
    (
      await json(
        await req(`/projects/${slug}/issues/${number}/timeline?limit=100`),
      )
    ).items as Array<{
      event_type?: string;
      payload?: Record<string, unknown>;
    }>;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    for (const slug of [A, B, C]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      id[slug] = ((await json(res)) as { id: number }).id;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("carries body, comments and specs across byte for byte", async () => {
    const target = await createIssue(A, "target in A");
    const inB = await createIssue(B, "target in B");
    const card = await createIssue(
      A,
      "travels",
      [
        `sees #${target.number} and ${B}#${inB.number}`,
        "",
        "```",
        `#${target.number} inside a fence`,
        "```",
        `inline \`#${target.number}\` too`,
      ].join("\n"),
    );
    const note = await addComment(A, card.number, `over to #${target.number}`);
    const pushed = await req(`/projects/${A}/issues/${card.number}/spec/push`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "plan.md", body: `plan for #${target.number}` }],
        message: "v1",
      }),
    });
    expect(pushed.status).toBe(200);

    const before = await landed(A, card.number);
    const [specBefore] = await before.db
      .select({ body: specVersionFiles.body })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersions.id, specVersionFiles.versionId))
      .where(eq(specVersions.issueId, before.id));

    const result = await move(A, card.number, B);
    const after = await landed(B, result.moved_to.number);

    expect(after.body).toBe(before.body);
    expect(after.bodyEditedAt).toBe(before.bodyEditedAt);

    const copied = await after.db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, after.id));
    expect(copied.map((row) => row.body)).toEqual([note.body]);

    const [specAfter] = await after.db
      .select({ body: specVersionFiles.body })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersions.id, specVersionFiles.versionId))
      .where(eq(specVersions.issueId, after.id));
    expect(specAfter?.body).toBe(specBefore?.body);

    // Nothing was rewritten, so nothing pretends the author edited anything.
    const rewrites = await after.db
      .select({ id: revisions.id })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, after.id),
        ),
      );
    expect(rewrites).toHaveLength(0);
  });

  it("leaves the events on the referenced card exactly as written", async () => {
    const target = await createIssue(A, "event target");
    const card = await createIssue(A, "points at it", `see #${target.number}`);

    const before = (await timelineOf(A, target.number)).filter(
      (item) => item.event_type === "referenced",
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.payload).toMatchObject({
      by_project_id: id[A],
      by_issue: card.number,
    });

    await move(A, card.number, B);

    const after = (await timelineOf(A, target.number)).filter((item) =>
      ["referenced", "cross_referenced"].includes(item.event_type ?? ""),
    );
    // Same row, same type, same payload: the id it names is the project the
    // reference was written in, which the move did not change.
    expect(after).toEqual(before);
  });

  it("keeps a link pointing at the card through two moves and back", async () => {
    const traveller = await createIssue(A, "the traveller");
    const pointer = await createIssue(
      A,
      "points at the traveller",
      `watch #${traveller.number}`,
    );
    const href = `/projects/${id[A]}/issues/${traveller.number}`;
    expect(pointer.body).toBe(`watch [#${traveller.number}](${href})`);

    const first = await move(A, traveller.number, B);
    const second = await move(B, first.moved_to.number, C);

    // The stored href never changed; following it lands on the card wherever
    // the address book says it is now.
    const atC = await req(href);
    expect(atC.status).toBe(301);
    expect((await json(atC)).moved_to).toEqual({
      slug: C,
      number: second.moved_to.number,
    });

    const home = await move(C, second.moved_to.number, A);
    const back = await req(href);
    // Home again on its original number, so the address answers directly.
    expect(back.status).toBe(200);
    expect((await json(back)).number).toBe(home.moved_to.number);
    expect((await landed(A, pointer.number)).body).toBe(
      `watch [#${traveller.number}](${href})`,
    );
  });

  it("resolves a bare ref written at the old address to the card meant", async () => {
    // T-261 P1: a card that has moved, edited to add a bare `#N`. The link
    // and the event have to name the same card — the one `#N` means HERE,
    // because here is where the author is typing.
    const traveller = await createIssue(A, "moves first");
    const moved = await move(A, traveller.number, B);
    const inB = await createIssue(B, "a card in B");

    const edit = await req(`/projects/${B}/issues/${moved.moved_to.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `now about #${inB.number}` }),
    });
    expect(edit.status).toBe(200);
    expect((await json(edit)).body).toBe(
      `now about [#${inB.number}](/projects/${id[B]}/issues/${inB.number})`,
    );

    const events = (await timelineOf(B, inB.number)).filter(
      (item) => item.event_type === "referenced",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      by_project_id: id[B],
      by_issue: moved.moved_to.number,
    });
  });

  it("does not drift when a moved card is edited twice", async () => {
    // T-261 P2: the second edit used to be read under an anchor the first
    // edit had locked. There is no anchor to lock any more.
    const traveller = await createIssue(A, "edited twice");
    const moved = await move(A, traveller.number, B);
    const first = await createIssue(B, "first target");
    const second = await createIssue(B, "second target");
    const at = `/projects/${B}/issues/${moved.moved_to.number}`;

    for (const target of [first, second]) {
      const res = await req(at, {
        method: "PATCH",
        body: JSON.stringify({ body: `about #${target.number}` }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).body).toBe(
        `about [#${target.number}](/projects/${id[B]}/issues/${target.number})`,
      );
    }
  });

  it("treats re-sending the token form as no edit at all", async () => {
    const target = await createIssue(A, "unchanged target");
    const card = await createIssue(
      A,
      "writes it once",
      `see #${target.number}`,
    );
    const at = `/projects/${A}/issues/${card.number}`;
    const stored = card.body;

    for (const body of [stored, `see #${target.number}`]) {
      const res = await req(at, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).body).toBe(stored);
    }

    const after = await landed(A, card.number);
    expect(after.bodyEditedAt).toBeNull();
    expect(
      await after.db
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, after.id),
          ),
        ),
    ).toHaveLength(0);
  });

  it("never lands two events for one reference, however often it is saved", async () => {
    const target = await createIssue(A, "saved at repeatedly");
    const card = await createIssue(A, "the saver", `see #${target.number}`);
    const at = `/projects/${A}/issues/${card.number}`;

    for (const body of ["see #" + target.number + " again", card.body]) {
      const res = await req(at, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(200);
    }

    const db = await dbOf(A);
    const rows = await db
      .select({ id: issueEvents.id })
      .from(issueEvents)
      .where(
        and(
          eq(issueEvents.projectId, id[A] as number),
          eq(issueEvents.type, "referenced"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    const events = (await timelineOf(A, target.number)).filter(
      (item) => item.event_type === "referenced",
    );
    expect(events).toHaveLength(1);
  });
});
