import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const HOME = "far-home";
const FAR = "far-away";

type Caller = Awaited<ReturnType<typeof addUserWithToken>>;

/**
 * Whose role decides an edge (T-663): the blocked card's state is its own
 * project's, so a `blocks` edge into another project needs `issue.block`
 * there too — while the blocker end, in either direction, still only has to
 * be readable. Dedicated placement, so the two projects are two databases.
 */
describe("block edges judged at the blocked card's project", () => {
  let t: TestApp;
  let cookie: string;
  const admin = () => ({ "content-type": "application/json", cookie });
  const callers: Record<"reader" | "reporter" | "writer", Caller> = {} as never;

  async function createIssue(slug: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ title: "card" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function setRole(slug: string, userId: number, role: string) {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: admin(),
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
  }

  const post = (
    who: Caller,
    slug: string,
    number: number,
    direction: "blocked-by" | "blocks",
    ref: string,
  ) =>
    t.app.request(`/api/projects/${slug}/issues/${number}/${direction}`, {
      method: "POST",
      headers: { ...who.headers, "content-type": "application/json" },
      body: JSON.stringify({ ref }),
    });

  async function blockedBy(slug: string, number: number): Promise<string[]> {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await json(res)).blocked_by.map(
      (b: { project: string; number: number }) => `${b.project}#${b.number}`,
    );
  }

  async function timelineTypes(slug: string, number: number) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items
      .filter((i: { type: string }) => i.type === "event")
      .map((i: { event_type: string }) => i.event_type) as string[];
  }

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    for (const slug of [HOME, FAR]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
    for (const role of ["reader", "reporter", "writer"] as const) {
      const user = await addUserWithToken(t.ctx, `far-${role}`);
      await setRole(HOME, user.user.id, "writer");
      await setRole(FAR, user.user.id, role);
      callers[role] = user;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  for (const role of ["reader", "reporter"] as const) {
    it(`refuses a ${role} of the far project a blocks edge into it`, async () => {
      const own = await createIssue(HOME);
      const victim = await createIssue(FAR);

      const direct = await post(
        callers[role],
        FAR,
        victim,
        "blocked-by",
        `${HOME}#${own}`,
      );
      expect(direct.status).toBe(403);

      const via = await post(
        callers[role],
        HOME,
        own,
        "blocks",
        `${FAR}#${victim}`,
      );
      // Same answer as the far project's own route: the caller can read the
      // card, so a 404 here would hide nothing and only mislead.
      expect(via.status).toBe(403);
      expect((await json(via)).error.message).toContain(`in ${FAR}`);
      expect(await blockedBy(FAR, victim)).toEqual([]);
      expect(await timelineTypes(FAR, victim)).not.toContain("block_added");
    });
  }

  it("still lets a reader of the far project wait on a card there", async () => {
    const own = await createIssue(HOME);
    const other = await createIssue(FAR);
    const res = await post(
      callers.reader,
      HOME,
      own,
      "blocked-by",
      `${FAR}#${other}`,
    );
    expect(res.status).toBe(200);
    expect(await blockedBy(HOME, own)).toEqual([`${FAR}#${other}`]);
  });

  it("still lets a writer of both projects declare a blocks edge across", async () => {
    const own = await createIssue(HOME);
    const other = await createIssue(FAR);
    const res = await post(
      callers.writer,
      HOME,
      own,
      "blocks",
      `${FAR}#${other}`,
    );
    expect(res.status).toBe(200);
    expect(await blockedBy(FAR, other)).toEqual([`${HOME}#${own}`]);
  });

  it("still lets a reader of the far project drop the edge from the blocker's side", async () => {
    const own = await createIssue(HOME);
    const other = await createIssue(FAR);
    const added = await t.app.request(
      `/api/projects/${HOME}/issues/${own}/blocks`,
      {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ ref: `${FAR}#${other}` }),
      },
    );
    expect(added.status).toBe(200);
    const edge = (await json(added)).blocks[0].edge_id as number;

    const dropped = await t.app.request(
      `/api/projects/${HOME}/issues/${own}/blocks/${edge}`,
      { method: "DELETE", headers: callers.reader.headers },
    );
    expect(dropped.status).toBe(204);
    expect(await blockedBy(FAR, other)).toEqual([]);
  });
});
