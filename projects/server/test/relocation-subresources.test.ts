import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

const PLAIN = "a plain comment";
const SPEC_FILES = [{ path: "design.md", body: "# Design\n\nAlpha.\n" }];
const QUESTIONS = [
  {
    question: "Ship behind a flag?",
    options: [{ label: "dev" }, { label: "prod" }],
  },
];

/**
 * What the addresses *under* a moved card answer (T-245): who gets the
 * redirect, and which address the redirect names.
 *
 * The move really runs here rather than being faked row by row as in
 * relocation.test.ts, because every subresource under test — spec, questions,
 * revisions, attachments — has to have been copied for the address it lands
 * on to be worth asserting.
 */
describe.each(PLACEMENTS)(
  "relocated subresources (%s placement)",
  (placement) => {
    let t: TestApp;
    let admin: Who;
    /** Writer in both projects, and the author of the cards below. */
    let author: Who;
    /** Reader in the destination alone: the reader T-245 lets through. */
    let destOnly: Who;
    /** Writer in the source alone: still told only that the card left. */
    let sourceOnly: Who;
    /** Member of neither: an old address must not admit it ever existed. */
    let outsider: Who;
    const A = `subres-a-${placement}`;
    const B = `subres-b-${placement}`;

    /** The card that moved, at both of its addresses. */
    let oldNumber = 0;
    let newNumber = 0;
    let oldCommentId = 0;
    let newCommentId = 0;
    /** A card that never left A, to prove the gate did not open too wide. */
    let staying = { number: 0, commentId: 0 };

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

    /**
     * The Location as the client would resolve it, so the assertion says
     * where the reader lands rather than how the header spelled it (T-246).
     */
    const locationOf = (res: Response, from: string): string => {
      const raw = res.headers.get("location");
      expect(raw).not.toBeNull();
      const url = new URL(raw as string, `http://localhost/api${from}`);
      return `${url.pathname}${url.search}`;
    };

    /** The 301, and what actually comes back from following it. */
    const follow = async (path: string, who: Who) => {
      const res = await req(path, who);
      expect(res.status).toBe(301);
      const location = locationOf(res, path);
      return {
        location,
        followed: await t.app.request(location, { headers: who }),
      };
    };

    /** A card with one of everything the eight read entries can serve. */
    const seedCard = async (
      slug: string,
      title: string,
    ): Promise<{ number: number; commentId: number }> => {
      const created = await req(`/projects/${slug}/issues`, author, {
        method: "POST",
        body: JSON.stringify({ title, body: "the original body" }),
      });
      expect(created.status).toBe(201);
      const { number } = (await json(created)) as { number: number };

      const commented = await req(
        `/projects/${slug}/issues/${number}/comments`,
        author,
        { method: "POST", body: JSON.stringify({ body: PLAIN }) },
      );
      expect(commented.status).toBe(201);
      const commentId = (await json(commented)).id as number;

      const asked = await req(
        `/projects/${slug}/issues/${number}/comments`,
        author,
        {
          method: "POST",
          body: JSON.stringify({
            body: "context…",
            component: { type: "questions", questions: QUESTIONS },
          }),
        },
      );
      expect(asked.status).toBe(201);

      const pushed = await req(
        `/projects/${slug}/issues/${number}/spec/push`,
        author,
        {
          method: "POST",
          body: JSON.stringify({ files: SPEC_FILES, message: "v1" }),
        },
      );
      expect(pushed.status).toBe(200);

      // Straight through `app.request`: the helper above would stamp a JSON
      // content-type on the form and the upload would come back 422.
      const form = new FormData();
      form.set(
        "file",
        new File(["potato bytes"], "note.txt", {
          type: "text/plain",
        }),
      );
      form.set("issue_number", String(number));
      const uploaded = await t.app.request(
        `/api/projects/${slug}/attachments`,
        {
          method: "POST",
          headers: author,
          body: form,
        },
      );
      expect(uploaded.status).toBe(201);

      // Both revision lists need an edit behind them, or an empty `items`
      // would pass every assertion below without proving anything.
      const editedIssue = await req(
        `/projects/${slug}/issues/${number}`,
        author,
        {
          method: "PATCH",
          body: JSON.stringify({ body: "the edited body" }),
        },
      );
      expect(editedIssue.status).toBe(200);
      const editedComment = await req(
        `/projects/${slug}/issues/${number}/comments/${commentId}`,
        author,
        { method: "PATCH", body: JSON.stringify({ body: `${PLAIN}, edited` }) },
      );
      expect(editedComment.status).toBe(200);

      return { number, commentId };
    };

    /** The eight addresses this card changes the answer for, under `slug`. */
    const subresourcesOf = (
      slug: string,
      number: number,
      commentId: number,
    ): string[] => [
      `/projects/${slug}/issues/${number}/spec`,
      `/projects/${slug}/issues/${number}/spec/files`,
      `/projects/${slug}/issues/${number}/spec/comments`,
      `/projects/${slug}/issues/${number}/timeline`,
      `/projects/${slug}/issues/${number}/questions`,
      `/projects/${slug}/issues/${number}/revisions`,
      `/projects/${slug}/issues/${number}/comments/${commentId}/revisions`,
      `/projects/${slug}/attachments?issue_number=${number}`,
    ];

    const oldAddresses = () => subresourcesOf(A, oldNumber, oldCommentId);

    /** Every address paired with its status, so a failure names which one. */
    const statusesOf = async (paths: string[], who: Who) => {
      const seen: Array<[string, number]> = [];
      for (const path of paths)
        seen.push([path, (await req(path, who)).status]);
      return seen;
    };
    const allOf = (paths: string[], status: number) =>
      paths.map((path) => [path, status]);

    beforeAll(async () => {
      t = await makeTestApp(placement);
      admin = { cookie: await t.login() };
      for (const slug of [A, B]) {
        const res = await req("/projects", admin, {
          method: "POST",
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
      }

      const alice = await addUserWithToken(t.ctx, `subres-author-${placement}`);
      const dest = await addUserWithToken(t.ctx, `subres-dest-${placement}`);
      const source = await addUserWithToken(t.ctx, `subres-src-${placement}`);
      author = alice.headers;
      destOnly = dest.headers;
      sourceOnly = source.headers;
      outsider = (await addUserWithToken(t.ctx, `subres-out-${placement}`))
        .headers;
      for (const [user, slug, role] of [
        [alice, A, "writer"],
        [alice, B, "writer"],
        // A bare reader, the smallest role the redirect must answer.
        [dest, B, "reader"],
        [source, A, "writer"],
      ] as const) {
        const res = await req(
          `/projects/${slug}/members/${user.user.id}`,
          admin,
          {
            method: "PUT",
            body: JSON.stringify({ role }),
          },
        );
        expect(res.status).toBe(204);
      }

      const card = await seedCard(A, "goes to B");
      oldNumber = card.number;
      oldCommentId = card.commentId;
      staying = await seedCard(A, "never leaves A");

      const moved = await req(
        `/projects/${A}/issues/${oldNumber}/move`,
        author,
        { method: "POST", body: JSON.stringify({ to_project: B }) },
      );
      expect(moved.status).toBe(200);
      newNumber = (await json(moved)).moved_to.number as number;

      // The comment's new id read off the destination rather than the move
      // result, which does not publish the mapping.
      const timeline = await req(
        `/projects/${B}/issues/${newNumber}/timeline`,
        author,
      );
      expect(timeline.status).toBe(200);
      const items = (await json(timeline)).items as Array<{
        type: string;
        id: number;
        body?: string;
      }>;
      const arrived = items.find(
        (item) => item.type === "comment" && item.body === `${PLAIN}, edited`,
      );
      expect(arrived).toBeDefined();
      newCommentId = (arrived as { id: number }).id;
    });

    afterAll(async () => {
      await t.cleanup();
    });

    describe("who may follow an old subresource address", () => {
      it("redirects a reader of the destination alone", async () => {
        // The eight entries this card widened; every one of them was 404
        // before, which left the reader unable to learn where to look.
        expect(await statusesOf(oldAddresses(), destOnly)).toEqual(
          allOf(oldAddresses(), 301),
        );
      });

      it("admits nothing at all to a reader of neither project", async () => {
        // 404 and not 410: a 410 would confirm this address once held a card.
        // The guard rests on T-242's `sourceReadable`, so it is pinned here
        // for the eight entries that now depend on it.
        expect(await statusesOf(oldAddresses(), outsider)).toEqual(
          allOf(oldAddresses(), 404),
        );
      });

      it("keeps redirecting a reader of both ends", async () => {
        expect(await statusesOf(oldAddresses(), author)).toEqual(
          allOf(oldAddresses(), 301),
        );
      });

      it("tells a reader of the source alone only that the card left", async () => {
        expect(await statusesOf(oldAddresses(), sourceOnly)).toEqual(
          allOf(oldAddresses(), 410),
        );
      });

      it("still hides a card that never left from a non-member", async () => {
        // The gate did not open past the tombstone: same reader, same eight
        // shapes, a card still living in A.
        const live = subresourcesOf(A, staying.number, staying.commentId);
        expect(await statusesOf(live, destOnly)).toEqual(allOf(live, 404));
      });
    });

    describe("where the redirect points", () => {
      it("lands on the subresource that was asked for", async () => {
        const res = await req(
          `/projects/${A}/issues/${oldNumber}/spec`,
          author,
        );
        expect(locationOf(res, `/projects/${A}/issues/${oldNumber}/spec`)).toBe(
          `/api/projects/${B}/issues/${newNumber}/spec`,
        );
      });

      it("carries the query across", async () => {
        // Dropping it would silently swap the version asked for with the
        // current one, and the follower would read different files.
        const from = `/projects/${A}/issues/${oldNumber}/spec/files?version=1`;
        expect(locationOf(await req(from, author), from)).toBe(
          `/api/projects/${B}/issues/${newNumber}/spec/files?version=1`,
        );
      });

      it("rewrites an issue number that lives in the query", async () => {
        const from = `/projects/${A}/attachments?issue_number=${oldNumber}`;
        expect(locationOf(await req(from, author), from)).toBe(
          `/api/projects/${B}/attachments?issue_number=${newNumber}`,
        );
      });

      it("leaves the card's own address spelled as it was", async () => {
        const from = `/projects/${A}/issues/${oldNumber}`;
        expect(locationOf(await req(from, author), from)).toBe(
          `/api/projects/${B}/issues/${newNumber}`,
        );
      });

      it("keeps the 301 body naming only the card", async () => {
        const res = await req(
          `/projects/${A}/issues/${oldNumber}/spec`,
          author,
        );
        expect(await json(res)).toEqual({
          moved_to: { slug: B, number: newNumber },
        });
      });

      it("hands a follower the resource it asked for", async () => {
        // The core of this card: before it, following any of these produced
        // 200 and an issue body — success by status code, another resource by
        // content. Each one is compared against the same read done directly
        // at the new address.
        for (const from of oldAddresses()) {
          const { location, followed } = await follow(from, author);
          expect([from, followed.status]).toEqual([from, 200]);
          const direct = await t.app.request(location, { headers: author });
          expect([from, direct.status]).toEqual([from, 200]);
          expect([from, await json(followed)]).toEqual([
            from,
            await json(direct),
          ]);
        }
      });

      it("hands over a body only that resource could have produced", async () => {
        const at = async (path: string) =>
          json(await follow(path, author).then((r) => r.followed));
        const spec = await at(`/projects/${A}/issues/${oldNumber}/spec`);
        expect(spec.current_version).toBe(1);
        const files = await at(
          `/projects/${A}/issues/${oldNumber}/spec/files?version=1`,
        );
        expect(files.version).toBe(1);
        expect(files.files).toHaveLength(1);
        const specComments = await at(
          `/projects/${A}/issues/${oldNumber}/spec/comments`,
        );
        expect(specComments.current_version).toBe(1);
        const timeline = await at(
          `/projects/${A}/issues/${oldNumber}/timeline`,
        );
        expect(Array.isArray(timeline.items)).toBe(true);
        const questions = await at(
          `/projects/${A}/issues/${oldNumber}/questions`,
        );
        expect(questions.items).toHaveLength(1);
        const revisions = await at(
          `/projects/${A}/issues/${oldNumber}/revisions`,
        );
        expect(revisions.items).toHaveLength(1);
        const attachments = await at(
          `/projects/${A}/attachments?issue_number=${oldNumber}`,
        );
        expect(Array.isArray(attachments)).toBe(true);
        expect(attachments).toHaveLength(1);
      });
    });

    describe("a comment address on a tombstone", () => {
      it("redirects to the comment, not to the card", async () => {
        const from = `/projects/${A}/issues/${oldNumber}/comments/${oldCommentId}`;
        const res = await req(from, author);
        expect(res.status).toBe(301);
        expect(locationOf(res, from)).toBe(
          `/api/projects/${B}/issues/${newNumber}/comments/${newCommentId}`,
        );
        expect(await json(res)).toEqual({
          moved_to: { slug: B, number: newNumber, comment_id: newCommentId },
        });
      });

      it("hands the follower that comment", async () => {
        const { followed } = await follow(
          `/projects/${A}/issues/${oldNumber}/comments/${oldCommentId}`,
          author,
        );
        expect(followed.status).toBe(200);
        expect((await json(followed)).body).toBe(`${PLAIN}, edited`);
      });

      it("keeps the /revisions tail on the comment's own new address", async () => {
        const from = `/projects/${A}/issues/${oldNumber}/comments/${oldCommentId}/revisions`;
        const { location, followed } = await follow(from, author);
        expect(location).toBe(
          `/api/projects/${B}/issues/${newNumber}/comments/${newCommentId}/revisions`,
        );
        expect(followed.status).toBe(200);
        expect((await json(followed)).items).toHaveLength(1);
      });

      it("leaves a bare #comment-N address spelled as it was", async () => {
        const from = `/projects/${A}/comments/${oldCommentId}`;
        const res = await req(from, author);
        expect(res.status).toBe(301);
        expect(locationOf(res, from)).toBe(
          `/api/projects/${B}/issues/${newNumber}/comments/${newCommentId}`,
        );
      });

      it("falls back to the card for a comment id that was never here", async () => {
        // Nothing translates 999999, so keeping the tail would point at
        // whatever B happens to have under that id — worse than the card.
        const from = `/projects/${A}/issues/${oldNumber}/comments/999999`;
        const res = await req(from, author);
        expect(res.status).toBe(301);
        expect(locationOf(res, from)).toBe(
          `/api/projects/${B}/issues/${newNumber}`,
        );
      });

      it("admits neither comment address to a reader of neither project", async () => {
        const hidden = [
          `/projects/${A}/issues/${oldNumber}/comments/${oldCommentId}`,
          `/projects/${A}/issues/${oldNumber}/comments/${oldCommentId}/revisions`,
        ];
        expect(await statusesOf(hidden, outsider)).toEqual(allOf(hidden, 404));
      });
    });
  },
);
