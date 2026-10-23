import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Entry = {
  project_id: number;
  number: number;
  comment_id: number | null;
  more: number;
  created_at: string;
};

const HOME = "refs-home";
const AWAY = "refs-away";
const SECRET = "refs-secret";

describe("issue references T-553", () => {
  let t: TestApp;
  let admin: Who;
  /** Writer in HOME and AWAY; no role in SECRET. */
  let bob: Who;
  const projectId: Record<string, number> = {};

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...who }
        : who,
    });

  const createIssue = async (slug: string, body = "") => {
    const res = await req(`/projects/${slug}/issues`, admin, {
      method: "POST",
      body: JSON.stringify({ title: "card", body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const setBody = async (slug: string, number: number, body: string) => {
    const res = await req(`/projects/${slug}/issues/${number}`, admin, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
  };

  const comment = async (slug: string, number: number, body: string) => {
    const res = await req(
      `/projects/${slug}/issues/${number}/comments`,
      admin,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  const move = async (from: string, number: number, to: string) => {
    const res = await req(`/projects/${from}/issues/${number}/move`, admin, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
    expect(res.status).toBe(200);
    return (await json(res)).moved_to.number as number;
  };

  const refs = async (
    slug: string,
    number: number,
    who: Who = admin,
  ): Promise<{ linked_from: Entry[]; links_to: Entry[] }> => {
    const res = await req(`/projects/${slug}/issues/${number}/references`, who);
    expect(res.status).toBe(200);
    return json(res);
  };

  const at = (slug: string, number: number) => ({
    project_id: projectId[slug] as number,
    number,
  });

  const link = (slug: string, number: number) =>
    `[#${number}](/projects/${projectId[slug]}/issues/${number})`;

  const dbOf = (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: projectId[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  beforeAll(async () => {
    t = await makeTestApp();
    admin = { cookie: await t.login() };
    for (const slug of [HOME, AWAY, SECRET]) {
      const res = await req("/projects", admin, {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      projectId[slug] = (await json(res)).id;
    }
    const added = await addUserWithToken(t.ctx, "refs-bob");
    bob = added.headers;
    for (const slug of [HOME, AWAY]) {
      const res = await req(
        `/projects/${slug}/members/${added.user.id}`,
        admin,
        {
          method: "PUT",
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("lists each card once per direction, first place first", async () => {
    const b = await createIssue(HOME);
    const a = await createIssue(HOME, `see #${b}`);
    await comment(HOME, a, `again #${b}`);
    await comment(HOME, a, `and #${b}, #${b}`);
    const c = await createIssue(HOME);
    const fromC = await comment(HOME, c, `about #${a}`);

    const ofA = await refs(HOME, a);
    expect(ofA.links_to).toEqual([
      expect.objectContaining({ ...at(HOME, b), comment_id: null, more: 3 }),
    ]);
    expect(ofA.linked_from).toEqual([
      expect.objectContaining({ ...at(HOME, c), comment_id: fromC, more: 0 }),
    ]);

    const ofB = await refs(HOME, b);
    expect(ofB.links_to).toEqual([]);
    expect(ofB.linked_from).toEqual([
      expect.objectContaining({ ...at(HOME, a), comment_id: null }),
    ]);
  });

  it("hides a source project the reader cannot read", async () => {
    const target = await createIssue(HOME);
    await createIssue(SECRET, `${HOME}#${target}`);
    const visible = await createIssue(AWAY, `${HOME}#${target}`);

    expect((await refs(HOME, target)).linked_from).toHaveLength(2);
    expect((await refs(HOME, target, bob)).linked_from).toEqual([
      expect.objectContaining(at(AWAY, visible)),
    ]);
  });

  it("never lists the card itself, under any address it has had", async () => {
    const self = await createIssue(HOME);
    const other = await createIssue(HOME);
    await setBody(HOME, self, `${link(HOME, self)} and #${other}`);
    expect((await refs(HOME, self)).links_to).toEqual([
      expect.objectContaining(at(HOME, other)),
    ]);

    const now = await move(HOME, self, AWAY);
    await comment(AWAY, now, `${link(AWAY, now)} itself again`);
    expect((await refs(AWAY, now)).links_to).toEqual([
      expect.objectContaining(at(HOME, other)),
    ]);
  });

  it("names a moved target at its current address, old and new as one", async () => {
    const target = await createIssue(HOME);
    const source = await createIssue(HOME, `see #${target}`);
    const now = await move(HOME, target, AWAY);
    await comment(HOME, source, `now ${link(AWAY, now)}`);

    expect((await refs(HOME, source)).links_to).toEqual([
      expect.objectContaining({ ...at(AWAY, now), comment_id: null, more: 1 }),
    ]);
    expect((await refs(AWAY, now)).linked_from).toEqual([
      expect.objectContaining(at(HOME, source)),
    ]);
  });

  it("reads hidden comments and skips spec files", async () => {
    const target = await createIssue(HOME);
    const specced = await createIssue(HOME);
    const pushed = await req(
      `/projects/${HOME}/issues/${specced}/spec/push`,
      admin,
      {
        method: "POST",
        body: JSON.stringify({
          files: [{ path: "plan.md", body: `see ${link(HOME, target)}\n` }],
        }),
      },
    );
    expect(pushed.status).toBe(200);
    expect((await refs(HOME, specced)).links_to).toEqual([]);

    const source = await createIssue(HOME);
    const hiddenId = await comment(HOME, source, `#${target}`);
    const hidden = await req(
      `/projects/${HOME}/issues/${source}/comments/hide`,
      admin,
      {
        method: "POST",
        body: JSON.stringify({ hidden: true, comment_ids: [hiddenId] }),
      },
    );
    expect(hidden.status).toBe(200);
    expect((await refs(HOME, source)).links_to).toEqual([
      expect.objectContaining({ ...at(HOME, target), comment_id: hiddenId }),
    ]);
  });

  it("places legacy payloads naming a slug, or no project at all", async () => {
    const target = await createIssue(HOME);
    const bySlug = await createIssue(AWAY);
    const local = await createIssue(HOME);
    const db = await dbOf(HOME);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, projectId[HOME] as number),
          eq(issues.number, target),
        ),
      );
    const issueId = rows[0]?.id as number;
    const actorId = (await json(await req("/me", admin))).id as number;
    await db.insert(issueEvents).values([
      {
        projectId: projectId[HOME] as number,
        issueId,
        actorId,
        type: "cross_referenced",
        payload: { by_project: AWAY, by_issue: bySlug },
      },
      {
        projectId: projectId[HOME] as number,
        issueId,
        actorId,
        type: "referenced",
        payload: { by_issue: local },
      },
    ]);

    const found = (await refs(HOME, target)).linked_from;
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining(at(AWAY, bySlug)),
        expect.objectContaining(at(HOME, local)),
      ]),
    );
  });

  it("answers an old address like the timeline does, and 404s a missing card", async () => {
    const card = await createIssue(HOME);
    await move(HOME, card, AWAY);
    const timeline = await req(
      `/projects/${HOME}/issues/${card}/timeline`,
      admin,
    );
    const references = await req(
      `/projects/${HOME}/issues/${card}/references`,
      admin,
    );
    expect(references.status).toBe(timeline.status);
    expect((await json(references)).moved_to).toEqual(
      (await json(timeline)).moved_to,
    );

    const missing = await req(
      `/projects/${HOME}/issues/99999/references`,
      admin,
    );
    expect(missing.status).toBe(404);
  });
});
