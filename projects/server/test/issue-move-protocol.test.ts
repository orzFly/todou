import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { issueEvents, issues } from "../src/db/project-schema.ts";
import { issueAddresses, issueMoves } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { sweepMoves } from "../src/services/move/execute.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Step = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The cross-database protocol, interrupted on purpose.
 *
 * With no transaction spanning the two databases, "it recovers" is not
 * something the happy path can demonstrate — every one of these tests kills
 * the move between two steps and asserts that `sweepMoves` reaches the same
 * end state the uninterrupted move would have.
 */
describe.each(["dedicated", "dedicated-bucketed"] as const)(
  "cross-database move protocol (%s placement)",
  (placement) => {
    const A = `pmv-a-${placement}`;
    const B = `pmv-b-${placement}`;

    /** A fresh app per test: the injected failure is per-run, not per-suite. */
    const setup = async (failAt?: Step) => {
      const t = await makeTestApp(placement, undefined, {
        afterMoveStep: async (step) => {
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        },
      });
      const cookie = await t.login();
      const admin: Who = { cookie };
      const ids: Record<string, number> = {};
      for (const slug of [A, B]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        ids[slug] = ((await json(res)) as { id: number }).id;
      }
      return { t, admin, cookie, ids };
    };

    let open: TestApp | null = null;
    const app = async (failAt?: Step) => {
      const made = await setup(failAt);
      open = made.t;
      return made;
    };

    afterEach(async () => {
      await open?.cleanup();
      open = null;
    });

    const req = (t: TestApp, path: string, who: Who, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: {
          ...(init?.body
            ? { "content-type": "application/json", ...who }
            : who),
          ...init?.headers,
        },
      });

    const createIssue = async (
      t: TestApp,
      who: Who,
      slug: string,
      title: string,
    ) => {
      const res = await req(t, `/projects/${slug}/issues`, who, {
        method: "POST",
        body: JSON.stringify({ title, body: "body" }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number; number: number };
    };

    const dbOf = async (t: TestApp, id: number, slug: string) =>
      t.ctx.router.forProject(
        routeInfoOf({ id, slug, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );

    const move = (
      t: TestApp,
      who: Who,
      from: string,
      number: number,
      to: string,
    ) =>
      req(t, `/projects/${from}/issues/${number}/move`, who, {
        method: "POST",
        body: JSON.stringify({ to_project: to }),
      });

    it("finishes a move that died before the address book", async () => {
      const { t, admin, ids } = await app(3);
      const source = await createIssue(t, admin, A, "interrupted at 3");
      const comment = await req(
        t,
        `/projects/${A}/issues/${source.number}/comments`,
        admin,
        { method: "POST", body: JSON.stringify({ body: "travels" }) },
      );
      const oldCommentId = ((await json(comment)) as { id: number }).id;

      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      // Frozen, not gone: reads pass, writes do not, and no redirect yet.
      const read = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(read.status).toBe(200);
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "nope" }) },
      );
      expect(write.status).toBe(409);
      expect((await json(write)).error.code).toBe("issue_moving");

      expect(await sweepMoves(t.ctx)).toBe(1);

      // Converged: the tombstone redirects, and exactly one copy exists.
      const after = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(after.status).toBe(301);
      const to = (await json(after)).moved_to as {
        slug: string;
        number: number;
      };
      expect(to.slug).toBe(B);

      const dbB = await dbOf(t, ids[B] as number, B);
      const copies = await dbB
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);

      // The aliases landed too — which is only possible if the id map
      // survived the crash inside the moved_in event.
      const aliased = await req(
        t,
        `/projects/${A}/comments/${oldCommentId}`,
        admin,
      );
      expect(aliased.status).toBe(301);
      expect((await json(aliased)).moved_to.slug).toBe(B);
    });

    it("finishes a move that died after the commit point", async () => {
      const { t, admin, ids } = await app(4);
      const source = await createIssue(t, admin, A, "interrupted at 4");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      // The window the design admits to: past step 4 the copy is live and
      // the source has not been retired yet, so both are readable.
      const dbB = await dbOf(t, ids[B] as number, B);
      const copies = await dbB
        .select({ number: issues.number })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);
      const copyNumber = copies[0]?.number as number;
      expect(
        (await req(t, `/projects/${B}/issues/${copyNumber}`, admin)).status,
      ).toBe(200);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(200);

      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    it("rolls back a move that died before anything was copied", async () => {
      const { t, admin, ids } = await app(2);
      const source = await createIssue(t, admin, A, "interrupted at 2");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      expect(await sweepMoves(t.ctx)).toBe(1);

      // Thawed and forgotten: the card is writable again and no registration
      // row is left for a later sweep to act on.
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "writable again" }) },
      );
      expect(write.status).toBe(200);
      expect(
        await t.ctx.router.system().select().from(issueMoves),
      ).toHaveLength(0);
      const dbB = await dbOf(t, ids[B] as number, B);
      expect(
        await dbB
          .select()
          .from(issues)
          .where(eq(issues.projectId, ids[B] as number)),
      ).toHaveLength(0);
    });

    it("leaves one moved_out however often the sweep runs", async () => {
      const { t, admin, ids } = await app(5);
      const source = await createIssue(t, admin, A, "interrupted at 5");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      await sweepMoves(t.ctx);
      await sweepMoves(t.ctx);

      const dbA = await dbOf(t, ids[A] as number, A);
      const trace = await dbA
        .select({ id: issueEvents.id })
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, source.id),
            eq(issueEvents.type, "moved_out"),
          ),
        );
      // The source project's only remaining record of the card; a replayed
      // step 5 must not turn it into two.
      expect(trace).toHaveLength(1);
    });

    it("refuses a second move during the freeze and leaves no second row", async () => {
      const { t, admin } = await app(3);
      const source = await createIssue(t, admin, A, "contested");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      const second = await move(t, admin, A, source.number, B);
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe("issue_moving");
      const rows = await t.ctx.router.system().select().from(issueMoves);
      expect(rows).toHaveLength(1);

      // …and the sweep still finishes the first move rather than thawing it.
      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    it("keeps the address book flat for every address the card has had", async () => {
      const { t, admin, ids } = await app();
      const source = await createIssue(t, admin, A, "walks the book");
      const out = await json(await move(t, admin, A, source.number, B));
      const back = await json(await move(t, admin, B, out.moved_to.number, A));

      const rows = await t.ctx.router
        .system()
        .select()
        .from(issueAddresses)
        .where(eq(issueAddresses.projectId, ids[A] as number));
      expect(rows).toHaveLength(1);
      // Every address of a lineage points at the same place — the invariant
      // that makes resolution one lookup instead of a chase.
      const all = await t.ctx.router.system().select().from(issueAddresses);
      const targets = new Set(
        all.map((r) => `${r.currentProjectId}/${r.currentNumber}`),
      );
      expect(targets.size).toBe(1);
      expect([...targets][0]).toBe(`${ids[A]}/${back.moved_to.number}`);
    });
  },
);

/**
 * Two projects in ONE dedicated database while the system tables sit
 * elsewhere: the deployment that makes the two path judgements disagree.
 */
describe("two projects sharing a database", () => {
  it("takes the protocol path without colliding on the storage key", async () => {
    const t = await makeTestApp("dedicated-bucketed");
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      const created: Array<{ slug: string; id: number }> = [];
      // `project.id % 2` buckets them, so the first and third share a target.
      for (const slug of ["bkt-one", "bkt-two", "bkt-three"]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        created.push({ slug, id: ((await json(res)) as { id: number }).id });
      }
      const pair = created.filter(
        (p) => p.id % 2 === (created[0] as { id: number }).id % 2,
      );
      expect(pair.length).toBeGreaterThanOrEqual(2);
      const from = pair[0] as { slug: string };
      const to = pair[1] as { slug: string };

      const issue = await json(
        await t.app.request(`/api/projects/${from.slug}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "carries a file", body: "body" }),
        }),
      );
      const form = new FormData();
      form.set(
        "file",
        new File(["bytes"], "shared.txt", { type: "text/plain" }),
      );
      form.set("issue_number", String(issue.number));
      const uploaded = await t.app.request(
        `/api/projects/${from.slug}/attachments`,
        { method: "POST", headers: { cookie }, body: form },
      );
      expect(uploaded.status).toBe(201);

      // The copy keeps the storage key, and the unique index on it spans the
      // whole database — so the source row has to go first even though this
      // is the cross-database path.
      const res = await t.app.request(
        `/api/projects/${from.slug}/issues/${issue.number}/move`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ to_project: to.slug }),
        },
      );
      expect(res.status).toBe(200);
      const moved = await json(res);
      expect(moved.moved_to.slug).toBe(to.slug);

      const listed = await t.app.request(
        `/api/projects/${to.slug}/attachments?issue_number=${moved.moved_to.number}`,
        { headers: { cookie } },
      );
      expect(listed.status).toBe(200);
      expect(await json(listed)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
