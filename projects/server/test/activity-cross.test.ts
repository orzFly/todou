import { decodeMultiCursor, encodeMultiCursor } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Cross-project merge order rides on wall-clock µs; keep seeded events
 *  >1ms apart so their relative order is never a coin flip. */
const settle = () => new Promise((r) => setTimeout(r, 5));

// "dedicated" gives every project its own database — the placement the
// per-project cursor design exists for; "shared" checks the same semantics
// hold when projects happen to share one.
describe.each(["shared", "dedicated"] as const)(
  "cross-project activity T-93 (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let bob: Awaited<ReturnType<typeof addUserWithToken>>;
    const suffix = placement.replaceAll(/[^a-z]/g, "");
    const pa = `xa-${suffix}`;
    const pb = `xb-${suffix}`;
    const pc = `xc-${suffix}`;
    const pd = `xd-${suffix}`;
    let issueA = 0;
    let issueB = 0;
    let issueC = 0;

    // Sequential `it` blocks share these (each block builds on the last).
    let env1 = "";
    let envDefault = "";

    const admin = () => ({ "content-type": "application/json", cookie });
    const asBob = () => ({
      "content-type": "application/json",
      ...bob.headers,
    });

    const createProject = async (slug: string) => {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    };
    const addMember = async (slug: string, userId: number) => {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    };
    const createIssue = async (slug: string, title: string) => {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).number as number;
    };
    const comment = async (
      slug: string,
      number: number,
      body: string,
      who: Record<string, string> = admin(),
    ) => {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...who },
          body: JSON.stringify({ body }),
        },
      );
      expect(res.status).toBe(201);
      await settle();
    };
    const cross = async (
      params: Record<string, string>,
      who: Record<string, string> = asBob(),
    ) =>
      t.app.request(`/api/activity?${new URLSearchParams(params)}`, {
        headers: who,
      });
    const plainCursorOf = async (slug: string): Promise<string> => {
      const res = await t.app.request(
        `/api/projects/${slug}/activity?last=1&limit=1`,
        { headers: asBob() },
      );
      expect(res.status).toBe(200);
      return (await json(res)).next_cursor as string;
    };
    type XItem = {
      type: string;
      id: number;
      project: string;
      created_at: string;
      body?: string;
      author?: { id: number };
      actor?: { id: number };
    };
    // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
    const itemsOf = (body: any): XItem[] => body.items as XItem[];

    /** Compact view for order/dedup assertions. */
    const keyOf = (item: {
      type: string;
      id: number;
      project: string;
    }): string => `${item.project}/${item.type}/${item.id}`;

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      bob = await addUserWithToken(t.ctx, `bob-x-${suffix}`);
      for (const slug of [pa, pb, pc]) {
        await createProject(slug);
      }
      await addMember(pa, bob.user.id);
      await addMember(pb, bob.user.id);
      issueA = await createIssue(pa, "alpha");
      await settle();
      issueB = await createIssue(pb, "beta");
      await settle();
      issueC = await createIssue(pc, "gamma");
      await settle();
    });

    afterAll(async () => {
      await t.cleanup();
    });

    it("merges projects in time order, tags items, mints an envelope", async () => {
      await comment(pa, issueA, "A1");
      await comment(pb, issueB, "B1");
      await comment(pa, issueA, "A2", asBob());

      const res = await cross({ projects: `${pa},${pb}` });
      expect(res.status).toBe(200);
      const body = await json(res);
      const projects = new Set(itemsOf(body).map((i) => i.project));
      expect(projects).toEqual(new Set([pa, pb]));
      const stamps = itemsOf(body).map((i) => i.created_at);
      expect([...stamps].sort()).toEqual(stamps);
      const comments = itemsOf(body)
        .filter((i) => i.type === "comment")
        .map((i) => i.body);
      expect(comments).toEqual(["A1", "B1", "A2"]);
      expect(body.items.length).toBe(5); // 2 opened events + 3 comments
      expect(body.next_cursor.startsWith("2:")).toBe(true);
      const positions = await decodeMultiCursor(body.next_cursor);
      expect(Object.keys(positions ?? {})).toEqual([pa, pb].sort());
      env1 = body.next_cursor;
    });

    it("resumes each project from its own position", async () => {
      await comment(pb, issueB, "B2");
      await comment(pa, issueA, "A3");

      const res = await cross({ projects: `${pa},${pb}`, after: env1 });
      const body = await json(res);
      expect(itemsOf(body).map((i) => [i.project, i.body])).toEqual([
        [pb, "B2"],
        [pa, "A3"],
      ]);

      const quiet = await cross({
        projects: `${pa},${pb}`,
        after: body.next_cursor,
      });
      const quietBody = await json(quiet);
      expect(quietBody.items).toEqual([]);
      expect(quietBody.next_cursor).toBeNull();
    });

    it("accepts a plain single-project cursor as the common start", async () => {
      const plain = await plainCursorOf(pa); // position of A3
      await settle();
      await comment(pb, issueB, "B3");
      await comment(pa, issueA, "A4");

      const res = await cross({ projects: `${pa},${pb}`, after: plain });
      const body = await json(res);
      expect(itemsOf(body).map((i) => [i.project, i.body])).toEqual([
        [pb, "B3"],
        [pa, "A4"],
      ]);
    });

    it("starts envelope-absent projects at the envelope's newest position", async () => {
      const posA4 = await plainCursorOf(pa);
      const partial = await encodeMultiCursor({ [pa]: posA4 });
      await settle();
      await comment(pb, issueB, "B4");

      // B4 happened after the envelope's newest position, so adding pb to
      // the watch set must deliver it — and identically on a repeat: the
      // starting position is a pure function of the envelope, never "now".
      for (let round = 0; round < 2; round++) {
        const res = await cross({ projects: `${pa},${pb}`, after: partial });
        const body = await json(res);
        expect(itemsOf(body).map((i) => [i.project, i.body])).toEqual([
          [pb, "B4"],
        ]);
      }
    });

    it("bootstraps a now-envelope via last=1, null for empty projects", async () => {
      await createProject(pd);
      await addMember(pd, bob.user.id);

      const res = await cross({ projects: `${pa},${pb},${pd}`, last: "1" });
      const body = await json(res);
      expect(body.items).toEqual([]);
      const positions = await decodeMultiCursor(body.next_cursor);
      expect(positions?.[pa]).toBeTruthy();
      expect(positions?.[pb]).toBeTruthy();
      expect(positions?.[pd]).toBeNull();

      await comment(pa, issueA, "A5");
      const next = await cross({
        projects: `${pa},${pb},${pd}`,
        after: body.next_cursor,
      });
      const nextBody = await json(next);
      expect(itemsOf(nextBody).map((i) => [i.project, i.body])).toEqual([
        [pa, "A5"],
      ]);
    });

    it("defaults to every readable project, re-enumerated per request", async () => {
      const res = await cross({});
      const body = await json(res);
      const seen = new Set(itemsOf(body).map((i) => i.project));
      expect(seen.has(pa)).toBe(true);
      expect(seen.has(pb)).toBe(true);
      expect(seen.has(pc)).toBe(false);
      envDefault = body.next_cursor;

      // Membership granted mid-watch: the next request picks pc up without
      // a new cursor, starting it at the envelope's newest position.
      await addMember(pc, bob.user.id);
      await comment(pc, issueC, "C1");
      const next = await cross({ after: envDefault });
      const nextBody = await json(next);
      expect(itemsOf(nextBody).map((i) => [i.project, i.body])).toEqual([
        [pc, "C1"],
      ]);
    });

    it("rejects explicit lists naming projects the caller cannot read", async () => {
      const carol = await addUserWithToken(t.ctx, `carol-x-${suffix}`);
      const perProject = await t.app.request(`/api/projects/${pa}/activity`, {
        headers: carol.headers,
      });
      expect(perProject.status).toBeGreaterThanOrEqual(400);
      const res = await cross({ projects: `${pa},${pb}` }, carol.headers);
      expect(res.status).toBe(perProject.status);
    });

    it("applies types and exclude_actor filters per project", async () => {
      const onlyComments = await json(
        await cross({ projects: `${pa},${pb}`, types: "comment" }),
      );
      expect(itemsOf(onlyComments).length).toBeGreaterThan(0);
      for (const item of itemsOf(onlyComments)) {
        expect(item.type).toBe("comment");
      }

      const excluded = await json(
        await cross({
          projects: `${pa},${pb}`,
          exclude_actor: String(bob.user.id),
        }),
      );
      expect(itemsOf(excluded).length).toBeGreaterThan(0);
      for (const item of itemsOf(excluded)) {
        expect((item.author ?? item.actor)?.id).not.toBe(bob.user.id);
      }
    });

    it("paginates the merge with has_more and exact envelope resume", async () => {
      const full = await json(await cross({ projects: `${pa},${pb}` }));
      expect(itemsOf(full).length).toBeGreaterThan(4);

      const drained: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page++) {
        const body = await json(
          await cross({
            projects: `${pa},${pb}`,
            limit: "2",
            ...(after === undefined ? {} : { after }),
          }),
        );
        if (page === 0) {
          expect(itemsOf(body).length).toBe(2);
          expect(body.has_more).toBe(true);
        }
        if (itemsOf(body).length === 0) break;
        drained.push(...itemsOf(body).map(keyOf));
        after = body.next_cursor;
        if (body.has_more === false) break;
      }
      expect(drained).toEqual(itemsOf(full).map(keyOf));
    });

    it("rejects malformed and foreign-version cursors loudly", async () => {
      for (const bad of ["2:AAAA", "3:abcd", "!!!"]) {
        const res = await cross({ projects: pa, after: bad });
        expect(res.status).toBe(422);
      }
      const empty = await cross({ projects: " , " });
      expect(empty.status).toBe(422);

      // The reverse direction stays loud too: envelopes never pass as
      // per-project cursors.
      const perProject = await t.app.request(
        `/api/projects/${pa}/activity?after=${encodeURIComponent(env1)}`,
        { headers: asBob() },
      );
      expect(perProject.status).toBe(422);
    });

    it("wraps even a single-project set in an envelope", async () => {
      const body = await json(await cross({ projects: pa }));
      expect(body.next_cursor.startsWith("2:")).toBe(true);
      const positions = await decodeMultiCursor(body.next_cursor);
      expect(Object.keys(positions ?? {})).toEqual([pa]);
    });
  },
);
