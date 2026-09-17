import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Merge order rides on wall-clock µs; keep seeded writes >1ms apart so the
 *  relative order of two cards is never a coin flip. */
const settle = () => new Promise((r) => setTimeout(r, 5));

// "dedicated" gives every project its own database — the placement the
// per-project cursor exists for; "shared" proves the same semantics hold
// when projects happen to share one.
describe.each(["shared", "dedicated"] as const)(
  "user cards and projects T-374 (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    /** The subject: whose cards and projects the page is about. */
    let subject: Awaited<ReturnType<typeof addUserWithToken>>;
    /** The viewer: reads the page, and can see less than the subject. */
    let viewer: Awaited<ReturnType<typeof addUserWithToken>>;
    const suffix = placement.replaceAll(/[^a-z]/g, "");
    const pa = `ua-${suffix}`;
    const pb = `ub-${suffix}`;

    const admin = () => ({ "content-type": "application/json", cookie });
    const asSubject = () => ({
      "content-type": "application/json",
      ...subject.headers,
    });

    const createProject = async (slug: string) => {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    };
    const addMember = async (slug: string, userId: number, role = "writer") => {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role }),
        },
      );
      expect([200, 204]).toContain(res.status);
    };
    const removeMember = async (slug: string, userId: number) => {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        { method: "DELETE", headers: admin() },
      );
      expect([200, 204]).toContain(res.status);
    };
    /** Opened by the subject unless `who` says otherwise. */
    const createIssue = async (
      slug: string,
      title: string,
      body: Record<string, unknown> = {},
      who: Record<string, string> = asSubject(),
    ) => {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: who,
        body: JSON.stringify({ title, ...body }),
      });
      expect(res.status).toBe(201);
      await settle();
      return (await json(res)).number as number;
    };
    const statusesOf = async (slug: string) => {
      const res = await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: admin(),
      });
      expect(res.status).toBe(200);
      return (await json(res)) as {
        id: number;
        name: string;
        category: string;
      }[];
    };
    const setStatus = async (
      slug: string,
      number: number,
      statusId: number,
    ) => {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}`,
        {
          method: "PATCH",
          headers: admin(),
          body: JSON.stringify({ status_id: statusId }),
        },
      );
      expect(res.status).toBe(200);
      await settle();
    };

    /** The endpoint under test, read as the viewer by default. */
    const list = async (
      params: Record<string, string> = {},
      who: Record<string, string> = viewer.headers,
      ref: string = subject.user.login,
    ) =>
      t.app.request(`/api/users/${ref}/issues?${new URLSearchParams(params)}`, {
        headers: who,
      });
    const listProjects = async (
      who: Record<string, string> = viewer.headers,
      ref: string = subject.user.login,
    ) => t.app.request(`/api/users/${ref}/projects`, { headers: who });

    type Row = { number: number; project: { slug: string } };
    /** Compact view for membership/order assertions. */
    const keysOf = (body: { items: Row[] }): string[] =>
      body.items.map((i) => `${i.project.slug}/${i.number}`);

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      subject = await addUserWithToken(t.ctx, `subj-${suffix}`);
      viewer = await addUserWithToken(t.ctx, `view-${suffix}`);
      for (const slug of [pa, pb]) {
        await createProject(slug);
        await addMember(slug, subject.user.id);
      }
      // The viewer starts out able to read only A — the visibility case
      // below needs a project the subject is in and the viewer is not.
      await addMember(pa, viewer.user.id);
    });

    afterAll(async () => {
      await t.cleanup();
    });

    describe("visibility is the viewer's, not the subject's", () => {
      let inA = 0;
      let inB = 0;

      beforeAll(async () => {
        inA = await createIssue(pa, "subject card in A");
        inB = await createIssue(pb, "subject card in B");
      });

      it("hides cards from a project only the subject can read", async () => {
        const body = await json(await list());
        expect(keysOf(body)).toContain(`${pa}/${inA}`);
        expect(keysOf(body)).not.toContain(`${pb}/${inB}`);
      });

      it("lists only the projects the viewer shares", async () => {
        const body = await json(await listProjects());
        expect(
          body.items.map((i: { project: { slug: string } }) => i.project.slug),
        ).toEqual([pa]);
      });

      // Asserting absence alone would pass against an endpoint that returns
      // nothing at all: granting the viewer B has to make B's card appear.
      it("shows B's cards once the viewer is given B", async () => {
        await addMember(pb, viewer.user.id);
        try {
          const body = await json(await list());
          expect(keysOf(body)).toContain(`${pb}/${inB}`);
          const projects = await json(await listProjects());
          expect(
            projects.items
              .map((i: { project: { slug: string } }) => i.project.slug)
              .sort(),
          ).toEqual([pa, pb]);
        } finally {
          await removeMember(pb, viewer.user.id);
        }
      });

      it("404s for a subject the viewer shares no project with", async () => {
        const stranger = await addUserWithToken(t.ctx, `strange-${suffix}`);
        const res = await list({}, viewer.headers, stranger.user.login);
        expect(res.status).toBe(404);
        const projects = await listProjects(
          viewer.headers,
          stranger.user.login,
        );
        expect(projects.status).toBe(404);
      });
    });

    describe("the card list", () => {
      it("counts limit across the whole page, not per project", async () => {
        // Both projects readable for this block; the subject holds cards in
        // each, so a per-project limit would deliver twice the rows.
        await addMember(pb, viewer.user.id);
        try {
          const body = await json(await list({ limit: "1" }));
          expect(body.items.length).toBe(1);
          expect(body.has_more).toBe(true);
        } finally {
          await removeMember(pb, viewer.user.id);
        }
      });

      it("pages over every card exactly once", async () => {
        await addMember(pb, viewer.user.id);
        try {
          const seeded: string[] = [];
          for (const slug of [pa, pb]) {
            for (let i = 0; i < 3; i++) {
              seeded.push(
                `${slug}/${await createIssue(slug, `page ${slug} ${i}`)}`,
              );
            }
          }
          const collected: string[] = [];
          let after: string | undefined;
          // Bounded so a cursor that never advances fails as a wrong count
          // rather than hanging the suite.
          for (let page = 0; page < 20; page++) {
            const body = await json(
              await list(
                after === undefined ? { limit: "2" } : { limit: "2", after },
              ),
            );
            collected.push(...keysOf(body));
            if (!body.has_more) break;
            expect(body.next_cursor).not.toBeNull();
            after = body.next_cursor;
          }
          for (const key of seeded) {
            expect(collected.filter((k) => k === key).length).toBe(1);
          }
          expect(new Set(collected).size).toBe(collected.length);
        } finally {
          await removeMember(pb, viewer.user.id);
        }
      });

      it("splits two rows sharing an updated_at to the microsecond", async () => {
        await addMember(pb, viewer.user.id);
        try {
          const collide = `collide-${Date.now()}`;
          const na = await createIssue(pa, collide);
          const nb = await createIssue(pb, collide);
          // A natural collision would never fire; writing the timestamp is
          // what makes the tie-break reachable at all.
          const stamp = new Date("2030-01-01T00:00:00.000123Z");
          for (const [slug, number] of [
            [pa, na],
            [pb, nb],
          ] as const) {
            const project = await getProjectByRef(t.ctx, slug);
            const db = await t.ctx.router.forProject(routeInfoOf(project));
            await db
              .update(issues)
              .set({ updatedAt: stamp })
              .where(eq(issues.number, number));
          }

          const first = await json(await list({ limit: "1" }));
          expect(first.items.length).toBe(1);
          expect(first.has_more).toBe(true);
          const second = await json(
            await list({ limit: "1", after: first.next_cursor }),
          );
          const pair = [...keysOf(first), ...keysOf(second)];
          expect(pair.sort()).toEqual([`${pa}/${na}`, `${pb}/${nb}`].sort());
        } finally {
          await removeMember(pb, viewer.user.id);
        }
      });

      // Two rows in ONE project sharing a timestamp is the case that pins
      // the cursor's boundary predicate. A cross-project tie does not: each
      // project resumes from its own position, so the second row arrives on
      // the next page even from a cursor that only ever looks strictly
      // older. Within one project, that cursor would skip it outright.
      it("splits two rows of one project sharing an updated_at", async () => {
        const collide = `same-project-collide-${Date.now()}`;
        const first = await createIssue(pa, `${collide} one`);
        const second = await createIssue(pa, `${collide} two`);
        const stamp = new Date("2031-01-01T00:00:00.000456Z");
        const project = await getProjectByRef(t.ctx, pa);
        const db = await t.ctx.router.forProject(routeInfoOf(project));
        for (const number of [first, second]) {
          await db
            .update(issues)
            .set({ updatedAt: stamp })
            .where(eq(issues.number, number));
        }

        const collected: string[] = [];
        let after: string | undefined;
        for (let page = 0; page < 30; page++) {
          const body = await json(
            await list(
              after === undefined ? { limit: "1" } : { limit: "1", after },
            ),
          );
          collected.push(...keysOf(body));
          if (!body.has_more) break;
          after = body.next_cursor;
        }
        for (const number of [first, second]) {
          expect(collected.filter((k) => k === `${pa}/${number}`).length).toBe(
            1,
          );
        }
      });

      it("filters by how the subject is involved", async () => {
        // Opened by the subject AND assigned to them: `any` must not show it
        // twice, which is what the left join is there to guarantee.
        const both = await createIssue(pa, "opened and assigned", {
          assignee_ids: [subject.user.id],
        });
        const assignedOnly = await createIssue(
          pa,
          "assigned only",
          { assignee_ids: [subject.user.id] },
          admin(),
        );

        const any = keysOf(
          await json(await list({ role: "any", limit: "100" })),
        );
        expect(any.filter((k) => k === `${pa}/${both}`).length).toBe(1);
        expect(any).toContain(`${pa}/${assignedOnly}`);

        const author = keysOf(
          await json(await list({ role: "author", limit: "100" })),
        );
        expect(author).toContain(`${pa}/${both}`);
        expect(author).not.toContain(`${pa}/${assignedOnly}`);

        const assignee = keysOf(
          await json(await list({ role: "assignee", limit: "100" })),
        );
        expect(assignee).toContain(`${pa}/${both}`);
        expect(assignee).toContain(`${pa}/${assignedOnly}`);
      });

      it("filters by state, and never shows a deleted card", async () => {
        const open = await createIssue(pa, "state open");
        const closed = await createIssue(pa, "state closed");
        const done = (await statusesOf(pa)).find(
          (s) => s.category === "closed",
        );
        if (!done) throw new Error("no closed status seeded");
        await setStatus(pa, closed, done.id);

        const openPage = keysOf(await json(await list({ limit: "100" })));
        expect(openPage).toContain(`${pa}/${open}`);
        expect(openPage).not.toContain(`${pa}/${closed}`);

        const closedPage = keysOf(
          await json(await list({ state: "closed", limit: "100" })),
        );
        expect(closedPage).toContain(`${pa}/${closed}`);
        expect(closedPage).not.toContain(`${pa}/${open}`);

        const all = keysOf(
          await json(await list({ state: "all", limit: "100" })),
        );
        expect(all).toContain(`${pa}/${open}`);
        expect(all).toContain(`${pa}/${closed}`);

        const trashed = await createIssue(pa, "into the trash");
        const del = await t.app.request(
          `/api/projects/${pa}/issues/${trashed}`,
          { method: "DELETE", headers: admin() },
        );
        expect(del.status).toBe(204);
        for (const state of ["open", "closed", "all"]) {
          const body = await json(await list({ state, limit: "100" }));
          expect(keysOf(body)).not.toContain(`${pa}/${trashed}`);
        }
      });

      it("carries the project on every row", async () => {
        const body = await json(await list({ limit: "1" }));
        const row = body.items[0];
        expect(row.project.slug).toBe(pa);
        expect(typeof row.project.id).toBe("number");
        expect(row.project.name).toBe(pa);
        // A list row, not the full card: the body never rides along.
        expect("body" in row).toBe(false);
      });

      it("refuses a malformed cursor with 422, not 500", async () => {
        const res = await list({ after: "2:not-an-envelope" });
        expect(res.status).toBe(422);
      });

      it("refuses a plain single-project cursor", async () => {
        // Unlike /activity, no plain cursor is a meaningful common start
        // here, so one is a client error rather than a broadcast.
        const res = await list({ after: "4:abc.1" });
        expect(res.status).toBe(422);
      });
    });

    describe("the projects list", () => {
      it("reports the role and join date the member list reports", async () => {
        const body = await json(await listProjects());
        const row = body.items.find(
          (i: { project: { slug: string } }) => i.project.slug === pa,
        );
        expect(row).toBeDefined();

        const members = await json(
          await t.app.request(`/api/projects/${pa}/members`, {
            headers: admin(),
          }),
        );
        const member = members.find(
          (m: { user: { id: number } }) => m.user.id === subject.user.id,
        );
        expect(row.role).toBe(member.role);
        expect(row.created_at).toBe(member.created_at);
      });

      it("lists membership rows only, so an instance admin holds none", async () => {
        const boss = await addUserWithToken(t.ctx, `boss-${suffix}`, {
          instanceAdmin: true,
        });
        // Read as the admin themself, so nothing is hidden by the viewer's
        // own scope: an empty list here is the membership rule, not access.
        const body = await json(
          await listProjects(boss.headers, boss.user.login),
        );
        expect(body.items).toEqual([]);
      });
    });

    it("publishes both paths in the OpenAPI document", async () => {
      const doc = await json(
        await t.app.request("/api/openapi.json", { headers: admin() }),
      );
      expect(Object.keys(doc.paths)).toContain("/api/users/{ref}/issues");
      expect(Object.keys(doc.paths)).toContain("/api/users/{ref}/projects");
    });
  },
);
