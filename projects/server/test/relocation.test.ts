import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  comments,
  issueEvents,
  issues,
} from "../src/db/project-schema.ts";
import { issueAddresses, movedIds } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

/**
 * The read half of moving a card between projects (T-231): what the routes
 * answer once a tombstone and an address book row exist.
 *
 * The executor is deliberately not involved — these rows are written by
 * hand. That keeps the redirect contract falsifiable on its own, and it is
 * the reason this suite could be written before there was anything able to
 * produce them.
 */
describe.each(PLACEMENTS)("relocation reads (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let admin: Who;
  /** A member of the source project only: may not follow the redirect. */
  let sourceOnly: Who;
  const A = `reloc-a-${placement}`;
  const B = `reloc-b-${placement}`;
  let idA = 0;
  let idB = 0;

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json", ...who } : who),
        ...init?.headers,
      },
    });

  const dbOf = async (projectId: number, slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: projectId,
        slug,
        databaseUrl: null,
        // Only the routing fields are read.
      } as Parameters<typeof routeInfoOf>[0]),
    );

  const createIssue = async (title: string, slug: string, body = "") => {
    const res = await req(`/projects/${slug}/issues`, admin, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  /**
   * Everything the executor would leave behind for one move, written by
   * hand: the source row becomes a tombstone, the address book points both
   * addresses at the destination, and the two timeline events pair up.
   */
  const fakeMove = async (opts: {
    from: { number: number; id: number };
    to: { number: number; id: number };
    token: string;
    idMap?: Record<string, Record<string, number>>;
  }) => {
    const dbA = await dbOf(idA, A);
    const dbB = await dbOf(idB, B);
    const movedAt = new Date();

    await dbA
      .update(issues)
      .set({ movedAt, body: "" })
      .where(eq(issues.id, opts.from.id));
    await dbA.insert(issueEvents).values({
      projectId: idA,
      issueId: opts.from.id,
      actorId: 1,
      type: "moved_out",
      createdAt: movedAt,
      payload: {
        move_token: opts.token,
        to_project_id: idB,
        to_project: B,
        to_number: opts.to.number,
      },
    });
    await dbB.insert(issueEvents).values({
      projectId: idB,
      issueId: opts.to.id,
      actorId: 1,
      type: "moved_in",
      createdAt: movedAt,
      payload: {
        move_token: opts.token,
        lineage: 1,
        from_project_id: idA,
        from_project: A,
        from_number: opts.from.number,
        ...(opts.idMap === undefined ? {} : { id_map: opts.idMap }),
      },
    });

    const system = t.ctx.router.system();
    const inserted = await system
      .insert(issueAddresses)
      .values({
        lineage: 0,
        projectId: idA,
        number: opts.from.number,
        currentProjectId: idB,
        currentNumber: opts.to.number,
      })
      .returning({ id: issueAddresses.id });
    const lineage = inserted[0]?.id as number;
    await system
      .update(issueAddresses)
      .set({ lineage })
      .where(eq(issueAddresses.id, lineage));
    await system.insert(issueAddresses).values({
      lineage,
      projectId: idB,
      number: opts.to.number,
      currentProjectId: idB,
      currentNumber: opts.to.number,
    });
  };

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    admin = { cookie };
    for (const slug of [A, B]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      const project = (await json(res)) as { id: number };
      if (slug === A) idA = project.id;
      else idB = project.id;
    }

    const user = await addUserWithToken(t.ctx, `reloc-source-${placement}`);
    sourceOnly = user.headers;
    const res = await t.app.request(
      `/api/projects/${A}/members/${user.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("a tombstoned issue", () => {
    let from = { id: 0, number: 0 };
    let to = { id: 0, number: 0 };

    beforeAll(async () => {
      from = await createIssue("moved away", A, "the original body");
      to = await createIssue("moved away", B);
      await fakeMove({ from, to, token: `tok-issue-${placement}` });
    });

    it("redirects a reader who can see the destination", async () => {
      const res = await req(`/projects/${A}/issues/${from.number}`, admin);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `/api/projects/${B}/issues/${to.number}`,
      );
      expect(await json(res)).toEqual({
        moved_to: { slug: B, number: to.number },
      });
    });

    it("redirects every GET under the issue, not just the issue itself", async () => {
      const res = await req(
        `/projects/${A}/issues/${from.number}/timeline`,
        admin,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `/api/projects/${B}/issues/${to.number}`,
      );
    });

    it("tells a reader without the destination only that it moved", async () => {
      const res = await req(`/projects/${A}/issues/${from.number}`, sourceOnly);
      expect(res.status).toBe(410);
      const body = await json(res);
      expect(body).toEqual({ moved: true, title: "moved away" });
      // The whole point of 410 over 404: it admits the card existed while
      // naming nothing about where it went.
      expect(JSON.stringify(body)).not.toContain(B);
      expect(JSON.stringify(body)).not.toContain(String(to.number));
    });

    it("refuses writes with 409 rather than redirecting them", async () => {
      const res = await req(`/projects/${A}/issues/${from.number}`, admin, {
        method: "PATCH",
        body: JSON.stringify({ title: "nope" }),
      });
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error.code).toBe("issue_moved");
      expect(body.error.details.moved_to).toEqual({
        slug: B,
        number: to.number,
      });
    });

    it("hides the 409's destination from a reader who cannot see it", async () => {
      const res = await req(
        `/projects/${A}/issues/${from.number}/comments`,
        sourceOnly,
        { method: "POST", body: JSON.stringify({ body: "hello" }) },
      );
      expect(res.status).toBe(410);
      expect(JSON.stringify(await json(res))).not.toContain(B);
    });

    it("keeps the tombstone out of lists, counts, search and the inbox", async () => {
      const list = await json(await req(`/projects/${A}/issues`, admin));
      expect(list.items.map((i: { number: number }) => i.number)).not.toContain(
        from.number,
      );

      const search = await json(
        await req(
          `/projects/${A}/search?q=${encodeURIComponent("moved away")}`,
          admin,
        ),
      );
      expect(JSON.stringify(search)).not.toContain('"the original body"');

      const inbox = await json(await req("/me/inbox", admin));
      const inboxNumbers = inbox.items.map(
        (i: { number: number; project: { slug: string } }) =>
          `${i.project.slug}/${i.number}`,
      );
      expect(inboxNumbers).not.toContain(`${A}/${from.number}`);
    });

    it("leaves moved_out audible in the source project's activity", async () => {
      const activity = await json(await req(`/projects/${A}/activity`, admin));
      const event = activity.items.find(
        (i: { event_type?: string }) => i.event_type === "moved_out",
      );
      expect(event).toBeDefined();
      expect(event.payload.to_project).toBe(B);
      expect(event.payload.to_number).toBe(to.number);
    });

    it("blanks the destination for a reader who cannot see it", async () => {
      const activity = await json(
        await req(`/projects/${A}/activity`, sourceOnly),
      );
      const event = activity.items.find(
        (i: { event_type?: string }) => i.event_type === "moved_out",
      );
      expect(event).toBeDefined();
      // The key survives so a client can tell "redacted" from "never set".
      expect(event.payload).toHaveProperty("to_project", null);
      expect(event.payload.to_project_id).toBeNull();
      expect(event.payload.to_number).toBeNull();
    });
  });

  describe("a comment that travelled with the card", () => {
    let from = { id: 0, number: 0 };
    let to = { id: 0, number: 0 };
    let oldCommentId = 0;
    let newCommentId = 0;

    beforeAll(async () => {
      from = await createIssue("carries a comment", A);
      const posted = await req(
        `/projects/${A}/issues/${from.number}/comments`,
        admin,
        { method: "POST", body: JSON.stringify({ body: "hello there" }) },
      );
      expect(posted.status).toBe(201);
      oldCommentId = (await json(posted)).id as number;

      to = await createIssue("carries a comment", B);
      const copied = await req(
        `/projects/${B}/issues/${to.number}/comments`,
        admin,
        { method: "POST", body: JSON.stringify({ body: "hello there" }) },
      );
      newCommentId = (await json(copied)).id as number;

      // The source comment goes with the card; only its alias is left.
      const dbA = await dbOf(idA, A);
      await dbA.delete(comments).where(eq(comments.id, oldCommentId));
      await fakeMove({ from, to, token: `tok-comment-${placement}` });
      await t.ctx.router.system().insert(movedIds).values({
        kind: "comment",
        projectId: idA,
        refId: oldCommentId,
        currentProjectId: idB,
        currentId: newCommentId,
      });
    });

    it("redirects a bare #comment-N to its new home, id included", async () => {
      const res = await req(`/projects/${A}/comments/${oldCommentId}`, admin);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `/api/projects/${B}/issues/${to.number}/comments/${newCommentId}`,
      );
      // The id rides along so translating a `#comment-N` anchor is one hop.
      expect(await json(res)).toEqual({
        moved_to: { slug: B, number: to.number, comment_id: newCommentId },
      });
    });

    it("410s a reader who cannot see where it went", async () => {
      const res = await req(
        `/projects/${A}/comments/${oldCommentId}`,
        sourceOnly,
      );
      expect(res.status).toBe(410);
      expect(JSON.stringify(await json(res))).not.toContain(B);
    });
  });

  describe("an attachment that travelled with the card", () => {
    let oldId = 0;
    let newId = 0;

    beforeAll(async () => {
      const from = await createIssue("carries a file", A);
      const to = await createIssue("carries a file", B);

      const upload = async (slug: string, number: number) => {
        const form = new FormData();
        form.set(
          "file",
          new File(["hello"], "note.txt", { type: "text/plain" }),
        );
        form.set("issue_number", String(number));
        const res = await t.app.request(`/api/projects/${slug}/attachments`, {
          method: "POST",
          headers: admin,
          body: form,
        });
        expect(res.status).toBe(201);
        return (await json(res)).id as number;
      };
      oldId = await upload(A, from.number);
      newId = await upload(B, to.number);

      const dbA = await dbOf(idA, A);
      await dbA.delete(attachments).where(eq(attachments.id, oldId));
      await fakeMove({ from, to, token: `tok-attach-${placement}` });
      await t.ctx.router.system().insert(movedIds).values({
        kind: "attachment",
        projectId: idA,
        refId: oldId,
        currentProjectId: idB,
        currentId: newId,
      });
    });

    it("redirects the download to the same route on the new card", async () => {
      const res = await req(
        `/projects/${A}/attachments/${oldId}/download/note.txt`,
        admin,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `/api/projects/${B}/attachments/${newId}/download/note.txt`,
      );
    });

    it("keeps the view route on the view route", async () => {
      const res = await req(`/projects/${A}/attachments/${oldId}/view`, admin);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        `/api/projects/${B}/attachments/${newId}/view`,
      );
    });

    it("410s a reader who cannot see where it went", async () => {
      const res = await req(
        `/projects/${A}/attachments/${oldId}/download`,
        sourceOnly,
      );
      expect(res.status).toBe(410);
    });
  });

  describe("a card mid-move", () => {
    let issue = { id: 0, number: 0 };

    beforeAll(async () => {
      issue = await createIssue("being copied right now", A, "still readable");
      const dbA = await dbOf(idA, A);
      await dbA
        .update(issues)
        .set({ movingSince: new Date() })
        .where(eq(issues.id, issue.id));
    });

    it("still reads, lists and searches — the freeze is not a deletion", async () => {
      const res = await req(`/projects/${A}/issues/${issue.number}`, admin);
      expect(res.status).toBe(200);

      const list = await json(await req(`/projects/${A}/issues`, admin));
      expect(list.items.map((i: { number: number }) => i.number)).toContain(
        issue.number,
      );

      const search = await json(
        await req(`/projects/${A}/search?q=still+readable`, admin),
      );
      expect(JSON.stringify(search)).toContain(String(issue.number));
    });

    it("refuses writes with issue_moving", async () => {
      const res = await req(`/projects/${A}/issues/${issue.number}`, admin, {
        method: "PATCH",
        body: JSON.stringify({ title: "nope" }),
      });
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("issue_moving");
    });

    it("takes no new references while frozen", async () => {
      const other = await createIssue("references the frozen card", A);
      await req(`/projects/${A}/issues/${other.number}`, admin, {
        method: "PATCH",
        body: JSON.stringify({ body: `see #${issue.number}` }),
      });
      const timeline = await json(
        await req(`/projects/${A}/issues/${issue.number}/timeline`, admin),
      );
      const referenced = timeline.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      );
      expect(referenced).toHaveLength(0);
    });
  });

  it("never lets id_map out of the server", async () => {
    const from = await createIssue("has an id map", A);
    const to = await createIssue("has an id map", B);
    await fakeMove({
      from,
      to,
      token: `tok-idmap-${placement}`,
      idMap: { comments: { "1462": 2001 }, attachments: { "88": 310 } },
    });

    const timeline = await json(
      await req(`/projects/${B}/issues/${to.number}/timeline`, admin),
    );
    const event = timeline.items.find(
      (i: { event_type?: string }) => i.event_type === "moved_in",
    );
    expect(event).toBeDefined();
    expect(event.payload).not.toHaveProperty("id_map");
    expect(JSON.stringify(timeline)).not.toContain("id_map");

    const activity = await json(await req(`/projects/${B}/activity`, admin));
    expect(JSON.stringify(activity)).not.toContain("id_map");
    const cross = await json(await req("/activity", admin));
    expect(JSON.stringify(cross)).not.toContain("id_map");
  });

  it("names a move's source only to readers of that source", async () => {
    const from = await createIssue("carries its history", A);
    const to = await createIssue("carries its history", B);
    await fakeMove({ from, to, token: `tok-moves-${placement}` });

    const seen = await json(
      await req(`/projects/${B}/issues/${to.number}`, admin),
    );
    expect(seen.moves).toHaveLength(1);
    expect(seen.moves[0]).toMatchObject({
      from_project_id: idA,
      from_project: A,
      from_number: from.number,
    });

    // A reader of B alone keeps the boundary and loses the attribution —
    // enough to stop parsing that stretch's `#N` under the wrong project.
    const user = await addUserWithToken(t.ctx, `reloc-dest-${placement}`);
    const res = await t.app.request(
      `/api/projects/${B}/members/${user.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(res.status).toBe(204);
    const limited = await json(
      await req(`/projects/${B}/issues/${to.number}`, user.headers),
    );
    expect(limited.moves).toHaveLength(1);
    expect(limited.moves[0].at).toBe(seen.moves[0].at);
    expect(limited.moves[0]).toMatchObject({
      from_project_id: null,
      from_project: null,
      from_number: null,
    });
  });

  it("reports the caller's own role on each project", async () => {
    const mine = await json(await req("/projects", sourceOnly));
    const source = mine.find((p: { slug: string }) => p.slug === A);
    expect(source.viewer_role).toBe("writer");
    expect(mine.find((p: { slug: string }) => p.slug === B)).toBeUndefined();

    const asAdmin = await json(await req(`/projects/${A}`, admin));
    expect(asAdmin.viewer_role).toBe("admin");
  });
});
