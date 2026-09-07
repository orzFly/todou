import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues } from "../src/db/project-schema.ts";
import { issueAddresses } from "../src/db/system-schema.ts";
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

/** ref_formats.effective_from is now(); keep switches strictly ordered. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** What the resolve pass stores for a token it could resolve. */
const LINK = /^\[([^\]]+)\]\(\/projects\/(\d+)\/issues\/(\d+)\)$/;

/**
 * `GET /me/refs/resolve` (T-288): the endpoint that lets a client resolve a
 * prefix held by a project it cannot name.
 *
 * The suite that matters is the last one. Everything above it pins one cell
 * of the matrix; that one asserts the property the whole card exists for —
 * that a token in prose and the same token as an argument get one answer.
 */
describe.each(PLACEMENTS)(
  "ref locator resolution (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let admin: Who;
    /** A member of the prefix holder only: may not follow its card's move. */
    let sourceOnly: Who;
    /** A member of the destination only — the reporter of this card. */
    let destOnly: Who;
    let outsider: Who;

    /** Holds `CH`, and lost a card to B. */
    const A = `refres-a-${placement}`;
    /** Holds `BB`, and is the only project `destOnly` can read. */
    const B = `refres-b-${placement}`;
    /** Held `RT` and gave it back. */
    const C = `refres-c-${placement}`;
    const D = `refres-d-${placement}`;
    const E = `refres-e-${placement}`;
    const ids = new Map<string, number>();

    /** The card that moved A → B, at both of its addresses. */
    let from = { id: 0, number: 0 };
    let to = { id: 0, number: 0 };
    /** A card that stayed in A, so only A's members resolve its ref. */
    let stayed = { id: 0, number: 0 };
    /** A card native to B, and the card `destOnly` writes its comments on. */
    let native = { id: 0, number: 0 };
    let host = { id: 0, number: 0 };

    const req = (path: string, who: Who, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: {
          ...(init?.body
            ? { "content-type": "application/json", ...who }
            : who),
          ...init?.headers,
        },
      });

    const resolve = (ref: string, who: Who) =>
      req(`/me/refs/resolve?ref=${encodeURIComponent(ref)}`, who);

    const dbOf = async (slug: string) =>
      t.ctx.router.forProject(
        routeInfoOf({
          id: ids.get(slug) as number,
          slug,
          databaseUrl: null,
          // Only the routing fields are read.
        } as Parameters<typeof routeInfoOf>[0]),
      );

    const createProject = async (slug: string) => {
      const res = await req("/projects", admin, {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      ids.set(slug, ((await json(res)) as { id: number }).id);
    };

    const putFormat = async (slug: string, prefix: string | null) => {
      const res = await req(`/projects/${slug}/references/format`, admin, {
        method: "PUT",
        body: JSON.stringify({ prefix }),
      });
      expect(res.status).toBe(200);
    };

    const addMember = async (slug: string, userId: number, role: string) => {
      const res = await req(`/projects/${slug}/members/${userId}`, admin, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(204);
    };

    const createIssue = async (slug: string, title: string) => {
      const res = await req(`/projects/${slug}/issues`, admin, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number; number: number };
    };

    /** The rows a move leaves behind, written by hand (as relocation.test.ts). */
    const fakeMove = async () => {
      const dbA = await dbOf(A);
      const dbB = await dbOf(B);
      const idA = ids.get(A) as number;
      const idB = ids.get(B) as number;
      const movedAt = new Date();

      await dbA
        .update(issues)
        .set({ movedAt, body: "" })
        .where(eq(issues.id, from.id));
      await dbA.insert(issueEvents).values({
        projectId: idA,
        issueId: from.id,
        actorId: 1,
        type: "moved_out",
        createdAt: movedAt,
        payload: {
          move_token: `refres-${placement}`,
          to_project_id: idB,
          to_project: B,
          to_number: to.number,
        },
      });
      await dbB.insert(issueEvents).values({
        projectId: idB,
        issueId: to.id,
        actorId: 1,
        type: "moved_in",
        createdAt: movedAt,
        payload: {
          move_token: `refres-${placement}`,
          lineage: 1,
          from_project_id: idA,
          from_project: A,
          from_number: from.number,
        },
      });

      const system = t.ctx.router.system();
      const inserted = await system
        .insert(issueAddresses)
        .values({
          lineage: 0,
          projectId: idA,
          number: from.number,
          currentProjectId: idB,
          currentNumber: to.number,
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
        number: to.number,
        currentProjectId: idB,
        currentNumber: to.number,
      });
    };

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      admin = { cookie };
      for (const slug of [A, B, C, D, E]) await createProject(slug);

      await putFormat(A, "CH");
      await putFormat(B, "BB");
      // A prefix given back: its hold closes, and the plain `#` that replaces
      // it holds nothing.
      await putFormat(C, "RT");
      await settle();
      await putFormat(C, null);
      // Two current holders, which is what `contested` means.
      await putFormat(D, "CT");
      await settle();
      await putFormat(E, "CT");

      const source = await addUserWithToken(
        t.ctx,
        `refres-source-${placement}`,
      );
      sourceOnly = source.headers;
      await addMember(A, source.user.id, "reader");

      const dest = await addUserWithToken(t.ctx, `refres-dest-${placement}`);
      destOnly = dest.headers;
      await addMember(B, dest.user.id, "writer");

      outsider = (await addUserWithToken(t.ctx, `refres-out-${placement}`))
        .headers;

      from = await createIssue(A, "moved away");
      to = await createIssue(B, "moved away");
      stayed = await createIssue(A, "stayed put");
      native = await createIssue(B, "born here");
      host = await createIssue(B, "the card the comments go on");
      await fakeMove();
    });

    afterAll(async () => {
      await t.cleanup();
    });

    describe("a card whose prefix names a project the caller cannot read", () => {
      it("answers the destination member with both addresses", async () => {
        const res = await resolve(`CH-${from.number}`, destOnly);
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({
          // The id and not the slug: `A` is a name this caller may not learn.
          names: { project_ref: String(ids.get(A)), number: from.number },
          at: { slug: B, number: to.number },
        });
      });

      it("answers an admin the same thing", async () => {
        const res = await resolve(`CH-${from.number}`, admin);
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({
          names: { project_ref: String(ids.get(A)), number: from.number },
          at: { slug: B, number: to.number },
        });
      });

      it("404s a member of the source alone", async () => {
        // The gate is on where the card went, never on where the ref points:
        // reading A is no reason to be told about B.
        expect((await resolve(`CH-${from.number}`, sourceOnly)).status).toBe(
          404,
        );
      });

      it("404s an outsider", async () => {
        expect((await resolve(`CH-${from.number}`, outsider)).status).toBe(404);
      });
    });

    describe("a card that never moved", () => {
      it("points `at` at the address the ref spells", async () => {
        const res = await resolve(`BB-${native.number}`, destOnly);
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual({
          names: { project_ref: String(ids.get(B)), number: native.number },
          at: { slug: B, number: native.number },
        });
      });

      it("404s when the holder is unreadable", async () => {
        expect((await resolve(`CH-${stayed.number}`, destOnly)).status).toBe(
          404,
        );
      });

      it("404s a number nothing was ever created at", async () => {
        expect((await resolve("BB-9999", destOnly)).status).toBe(404);
      });
    });

    describe("a prefix with no single current holder", () => {
      it("404s a retired one", async () => {
        expect((await resolve("RT-1", admin)).status).toBe(404);
      });

      it("404s a contested one", async () => {
        expect((await resolve("CT-1", admin)).status).toBe(404);
      });

      it("404s one nobody holds", async () => {
        expect((await resolve("ZZ-1", admin)).status).toBe(404);
      });
    });

    describe("shapes it does not take", () => {
      // 422 is this server's refusal for a malformed request everywhere.
      it.each(["5", "#5", `${B}/5`, `${B}#5`, `${B}/BB-5`, "~~~", "CH-"])(
        "refuses %j",
        async (ref) => {
          expect((await resolve(ref, admin)).status).toBe(422);
        },
      );
    });

    /**
     * The card's acceptance condition, as one assertion rather than two suites:
     * split apart, the two paths are free to drift and each half still passes.
     *
     * No card mid-move is in the table. There the two paths legitimately differ
     * — a new reference is refused (`referenceable`) while a read is allowed
     * (`live`) — so a row for it would record a correct difference as a bug.
     */
    it("gives prose and the endpoint one answer per token", async () => {
      // `resolves` is what each row is there to exercise. Asserting agreement
      // alone would pass just as well if every token had quietly become
      // unresolvable, which is the one way this test could stop testing.
      const tokens = [
        { ref: () => `BB-${native.number}`, resolves: true },
        { ref: () => `CH-${from.number}`, resolves: true },
        { ref: () => `CH-${stayed.number}`, resolves: false },
        { ref: () => "RT-1", resolves: false },
        { ref: () => "CT-1", resolves: false },
        { ref: () => "ZZ-1", resolves: false },
        { ref: () => "BB-9999", resolves: false },
      ];
      for (const row of tokens) {
        const token = row.ref();
        const posted = await req(
          `/projects/${B}/issues/${host.number}/comments`,
          destOnly,
          { method: "POST", body: JSON.stringify({ body: token }) },
        );
        expect(posted.status).toBe(201);
        const stored = ((await json(posted)) as { body: string }).body;
        const link = LINK.exec(stored);
        expect(link !== null, `${token} should resolve in prose`).toBe(
          row.resolves,
        );

        const res = await resolve(token, destOnly);
        if (link === null) {
          expect(stored, `${token} must stay literal in prose`).toBe(token);
          expect(
            res.status,
            `${token} is literal in prose, so it cannot resolve`,
          ).toBe(404);
          continue;
        }
        expect(link[1], `${token} keeps its spelling as the link text`).toBe(
          token,
        );
        expect(
          res.status,
          `${token} is a link in prose, so it must resolve`,
        ).toBe(200);
        const body = (await json(res)) as {
          at: { slug: string; number: number };
        };
        expect({
          projectId: Number(link[2]),
          number: Number(link[3]),
        }).toEqual({
          projectId: ids.get(body.at.slug),
          number: body.at.number,
        });
      }
    });
  },
);
