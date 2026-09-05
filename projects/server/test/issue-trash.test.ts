import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const SLUG = "trash-proj";
/** A second project, so cross-project references get exercised too. */
const OTHER = "trash-other-proj";

type Who = Record<string, string>;

/**
 * The trash (T-145). Two properties carry the whole design and get their own
 * describes below: a deleted card's title reaches no read path at all, and
 * restoring puts every reference to it back exactly as it was.
 */
describe("issue trash", () => {
  let t: TestApp;
  /** The instance admin — admin of every project without a membership row. */
  let cookie: string;
  let admin: Who;
  /** Writer who authors the cards under test. */
  let author: Who;
  let authorId = 0;
  /** Writer who authored nothing: sees no trash, may delete nothing. */
  let bystander: Who;
  /** Reader of the project. */
  let reader: Who;
  /** Not a member at all. */
  let stranger: Who;

  const headers = () => ({ "content-type": "application/json", cookie });
  const asJson = (who: Who) => ({ "content-type": "application/json", ...who });

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: { ...(init?.body ? asJson(who) : who), ...init?.headers },
    });

  const get = async (path: string, who: Who) => {
    const res = await req(path, who);
    expect(res.status).toBe(200);
    return json(res);
  };

  const createIssue = async (
    title: string,
    who: Who = author,
    body = "",
    slug = SLUG,
  ) => {
    const res = await req(`/projects/${slug}/issues`, who, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const del = (n: number, who: Who, slug = SLUG) =>
    req(`/projects/${slug}/issues/${n}`, who, { method: "DELETE" });
  const restore = (n: number, who: Who, slug = SLUG) =>
    req(`/projects/${slug}/issues/${n}/restore`, who, { method: "POST" });

  /** Deletes as the author, asserting the happy path, for tests about after. */
  const trash = async (n: number, who: Who = author) => {
    expect((await del(n, who)).status).toBe(204);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    admin = { cookie };
    for (const slug of [SLUG, OTHER]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: `Trash ${slug}` }),
      });
      expect(res.status).toBe(201);
    }

    const alice = await addUserWithToken(t.ctx, "trash-author");
    const bob = await addUserWithToken(t.ctx, "trash-bystander");
    const carol = await addUserWithToken(t.ctx, "trash-reader");
    const dave = await addUserWithToken(t.ctx, "trash-stranger");
    author = alice.headers;
    authorId = alice.user.id;
    bystander = bob.headers;
    reader = carol.headers;
    stranger = dave.headers;

    for (const [user, role] of [
      [alice, "writer"],
      [bob, "writer"],
      [carol, "reader"],
    ] as const) {
      for (const slug of [SLUG, OTHER]) {
        const res = await t.app.request(
          `/api/projects/${slug}/members/${user.user.id}`,
          {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify({ role }),
          },
        );
        expect(res.status).toBe(204);
      }
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("permission", () => {
    it("lets the author delete and restore their own card", async () => {
      const n = await createIssue("author deletes this");
      await trash(n);
      const restored = await restore(n, author);
      expect(restored.status).toBe(200);
      expect((await json(restored)).deleted_at).toBeNull();
    });

    it("lets a project admin delete someone else's card", async () => {
      const n = await createIssue("admin deletes this");
      expect((await del(n, admin)).status).toBe(204);
    });

    it("lets the author restore a card an admin deleted", async () => {
      const n = await createIssue("admin deleted, author restores");
      expect((await del(n, admin)).status).toBe(204);
      // Trash visibility follows the card's author, not whoever deleted it.
      const seen = await get(`/projects/${SLUG}/issues/${n}`, author);
      expect(seen.title).toBe("admin deleted, author restores");
      expect((await restore(n, author)).status).toBe(200);
    });

    it("refuses a writer who is neither the author nor an admin", async () => {
      const n = await createIssue("not yours to delete");
      expect((await del(n, bystander)).status).toBe(403);
      expect((await del(n, reader)).status).toBe(403);
      // A non-member must not learn the project exists, let alone the card.
      expect((await del(n, stranger)).status).toBe(404);
    });

    it("records who deleted the card, for the banner", async () => {
      const n = await createIssue("deleted by admin");
      expect((await del(n, admin)).status).toBe(204);
      const seen = await get(`/projects/${SLUG}/issues/${n}`, admin);
      expect(seen.deleted_at).not.toBeNull();
      expect(seen.deleted_by.login).toBe("user");
      await restore(n, admin);
    });
  });

  describe("error codes", () => {
    it("409s a second delete, and a restore of a live card", async () => {
      const n = await createIssue("double delete");
      await trash(n);
      const again = await del(n, author);
      expect(again.status).toBe(409);
      expect((await json(again)).error.code).toBe("conflict");

      expect((await restore(n, author)).status).toBe(200);
      const spurious = await restore(n, author);
      expect(spurious.status).toBe(409);
    });

    it("404s — not 409s — for whoever may not see the trash", async () => {
      const n = await createIssue("invisible once deleted");
      await trash(n);
      // The bystander must not be able to tell "deleted" from "never was".
      expect((await del(n, bystander)).status).toBe(404);
      expect((await restore(n, bystander)).status).toBe(404);
      expect((await del(999_999, bystander)).status).toBe(404);
    });
  });

  describe("the title reaches no read path", () => {
    const TITLE = "artichoke secret sauce";
    let n = 0;
    let commentId = 0;
    let attachmentUrl = "";

    beforeAll(async () => {
      n = await createIssue(TITLE, author, "body mentions artichoke too");
      const comment = await req(
        `/projects/${SLUG}/issues/${n}/comments`,
        author,
        {
          method: "POST",
          body: JSON.stringify({ body: "a comment on the artichoke" }),
        },
      );
      expect(comment.status).toBe(201);
      commentId = (await json(comment)).id;

      const form = new FormData();
      form.set(
        "file",
        new File(["secret bytes"], "sauce.txt", {
          type: "text/plain",
        }),
      );
      form.set("issue_number", String(n));
      const uploaded = await t.app.request(
        `/api/projects/${SLUG}/attachments`,
        {
          method: "POST",
          headers: author,
          body: form,
        },
      );
      expect(uploaded.status).toBe(201);
      attachmentUrl = (await json(uploaded)).url;

      await trash(n);
    });

    const numbersIn = (page: { items: Array<{ number: number }> }) =>
      page.items.map((i) => i.number);

    it("is gone from the default list, for everyone", async () => {
      for (const who of [admin, author, bystander, reader]) {
        const page = await get(`/projects/${SLUG}/issues?limit=100`, who);
        expect(numbersIn(page)).not.toContain(n);
      }
    });

    it("is gone from search", async () => {
      for (const who of [admin, author, bystander]) {
        const page = await get(
          `/projects/${SLUG}/issues?limit=100&q=artichoke`,
          who,
        );
        expect(numbersIn(page)).toEqual([]);
      }
    });

    it("is gone from the counts", async () => {
      const before = await get(`/projects/${SLUG}/issues/counts`, admin);
      const live = await createIssue("counted");
      const after = await get(`/projects/${SLUG}/issues/counts`, admin);
      expect(after.open).toBe(before.open + 1);
      await trash(live);
      const back = await get(`/projects/${SLUG}/issues/counts`, admin);
      expect(back.open).toBe(before.open);
    });

    it("is gone from the numbers= batch every ref preview reads", async () => {
      for (const who of [admin, author, bystander]) {
        const page = await get(
          `/projects/${SLUG}/issues?numbers=${n}&limit=10`,
          who,
        );
        expect(page.items).toEqual([]);
      }
    });

    it("is gone from the inbox", async () => {
      for (const who of [admin, bystander, reader]) {
        const page = await get("/me/inbox?limit=100", who);
        const hit = page.items.find(
          (i: { number: number; project: { slug: string } }) =>
            i.project.slug === SLUG && i.number === n,
        );
        expect(hit).toBeUndefined();
      }
    });

    it("404s the detail, timeline, revisions and comments for outsiders", async () => {
      for (const path of [
        `/projects/${SLUG}/issues/${n}`,
        `/projects/${SLUG}/issues/${n}/timeline`,
        `/projects/${SLUG}/issues/${n}/revisions`,
        `/projects/${SLUG}/issues/${n}/comments/${commentId}`,
        `/projects/${SLUG}/comments/${commentId}`,
        `/projects/${SLUG}/attachments?issue_number=${n}`,
      ]) {
        for (const who of [bystander, reader]) {
          expect((await req(path, who)).status).toBe(404);
        }
        // The author and the admin may still read all of it.
        for (const who of [author, admin]) {
          expect((await req(path, who)).status).toBe(200);
        }
      }
    });

    it("404s the attachment for outsiders, keeps it for the trash viewers", async () => {
      expect((await req(attachmentUrl.slice(4), bystander)).status).toBe(404);
      expect((await req(attachmentUrl.slice(4), reader)).status).toBe(404);
      expect((await req(attachmentUrl.slice(4), author)).status).toBe(200);
      expect((await req(attachmentUrl.slice(4), admin)).status).toBe(200);
    });

    it("shows up in the trash list, scoped to who may see it", async () => {
      const forAdmin = await get(
        `/projects/${SLUG}/issues?deleted=1&limit=100`,
        admin,
      );
      expect(numbersIn(forAdmin)).toContain(n);
      expect(forAdmin.items[0].deleted_at).not.toBeNull();

      const forAuthor = await get(
        `/projects/${SLUG}/issues?deleted=1&limit=100`,
        author,
      );
      expect(numbersIn(forAuthor)).toContain(n);
      expect(
        forAuthor.items.every(
          (i: { author: { id: number } }) => i.author.id === authorId,
        ),
      ).toBe(true);

      // Empty, not forbidden: the trash is a view, not a privilege.
      const forBystander = await get(
        `/projects/${SLUG}/issues?deleted=1&limit=100`,
        bystander,
      );
      expect(forBystander.items).toEqual([]);
    });
  });

  describe("writes are frozen while a card is in the trash", () => {
    let n = 0;

    beforeAll(async () => {
      n = await createIssue("frozen while deleted");
      await trash(n);
    });

    const writes: Array<[string, string, unknown]> = [
      ["PATCH", "", { title: "renamed" }],
      ["POST", "/comments", { body: "hello?" }],
      ["POST", "/commands", { body: "hi", commands: [] }],
      ["POST", "/spec/push", { files: [{ path: "a.md", body: "x" }] }],
    ];

    it("409s whoever can see the card, 404s everyone else", async () => {
      for (const [method, suffix, body] of writes) {
        const path = `/projects/${SLUG}/issues/${n}${suffix}`;
        for (const who of [author, admin]) {
          const res = await req(path, who, {
            method,
            body: JSON.stringify(body),
          });
          expect([res.status, method, suffix]).toEqual([409, method, suffix]);
          expect((await json(res)).error.code).toBe("issue_deleted");
        }
        const hidden = await req(path, bystander, {
          method,
          body: JSON.stringify(body),
        });
        expect([hidden.status, method, suffix]).toEqual([404, method, suffix]);
      }
    });

    it("409s an attachment upload", async () => {
      const form = new FormData();
      form.set("file", new File(["x"], "x.txt", { type: "text/plain" }));
      form.set("issue_number", String(n));
      const res = await t.app.request(`/api/projects/${SLUG}/attachments`, {
        method: "POST",
        headers: author,
        body: form,
      });
      expect(res.status).toBe(409);
    });

    it("404s the read-position write, even for the admin", async () => {
      const res = await req(`/projects/${SLUG}/issues/${n}/read`, admin, {
        method: "PUT",
        body: "{}",
      });
      expect(res.status).toBe(404);
    });

    it("still blocks deleting the status the trashed card occupies", async () => {
      const statuses = await get(`/projects/${SLUG}/statuses`, admin);
      const occupied = statuses.find(
        (s: { name: string }) => s.name === "Todo",
      );
      const res = await req(
        `/projects/${SLUG}/statuses/${occupied.id}`,
        admin,
        {
          method: "DELETE",
        },
      );
      // Restoring the card must never land it on a status that is gone.
      expect(res.status).toBe(409);
    });
  });

  describe("references degrade and revive", () => {
    let target = 0;
    let source = 0;
    let sourceBody = "";

    const eventsOf = async (n: number, who: Who) => {
      const page = await get(
        `/projects/${SLUG}/issues/${n}/timeline?limit=100`,
        who,
      );
      return page.items
        .filter((i: { type: string }) => i.type === "event")
        .map((i: { event_type: string }) => i.event_type);
    };

    beforeAll(async () => {
      target = await createIssue("the referenced card");
      source = await createIssue(
        "the referring card",
        author,
        `see #${target}`,
      );
      sourceBody = (await get(`/projects/${SLUG}/issues/${source}`, author))
        .body;
      // Resolved at submission, while the target was still there.
      expect(sourceBody).toMatch(
        /^see \[#\d+\]\(\/projects\/\d+\/issues\/\d+\)$/,
      );
    });

    it("drops the target out of the batch lookup and puts it back", async () => {
      const lookup = async (who: Who) =>
        (await get(`/projects/${SLUG}/issues?numbers=${target}`, who)).items
          .length;
      expect(await lookup(bystander)).toBe(1);

      await trash(target);
      // This is the whole degradation mechanism: <IssueLink> renders the
      // written token as plain text when the number resolves to nothing.
      expect(await lookup(bystander)).toBe(0);

      expect((await restore(target, author)).status).toBe(200);
      expect(await lookup(bystander)).toBe(1);
    });

    it("keeps the referenced event, so links revive with the card", async () => {
      expect(await eventsOf(target, author)).toContain("referenced");
      await trash(target);
      expect(await eventsOf(target, author)).toContain("referenced");
      expect((await restore(target, author)).status).toBe(200);
      // The event survived untouched, and so did the link: trashing a card
      // does not reach into everything that ever named it.
      expect(await eventsOf(target, bystander)).toContain("referenced");
      const still = await get(`/projects/${SLUG}/issues/${source}`, bystander);
      expect(still.body).toBe(sourceBody);
    });

    it("lands no new reference on a card in the trash", async () => {
      const refCount = async () =>
        (await eventsOf(target, author)).filter(
          (e: string) => e === "referenced",
        ).length;
      await trash(target);
      const before = await refCount();
      await createIssue(
        "written while the target was gone",
        author,
        `also see #${target}`,
      );
      expect(await refCount()).toBe(before);
      expect((await restore(target, author)).status).toBe(200);
      // Nothing retroactive: the card is back, the missed event is not.
      expect(await refCount()).toBe(before);
    });

    it("takes no cross-project reference either", async () => {
      const crossCount = async () =>
        (await eventsOf(target, author)).filter(
          (e: string) => e === "cross_referenced",
        ).length;
      await trash(target);
      const before = await crossCount();
      await createIssue(
        "cross-project mention",
        author,
        `see ${SLUG}#${target}`,
        OTHER,
      );
      expect(await crossCount()).toBe(before);
      expect((await restore(target, author)).status).toBe(200);
    });
  });

  describe("the activity stream", () => {
    it("goes quiet except for the deletion itself", async () => {
      const cursorOf = async () =>
        (await get(`/projects/${SLUG}/activity?last=1&limit=1`, admin))
          .next_cursor as string;

      const base = await cursorOf();
      const n = await createIssue("watched, then deleted");
      await req(`/projects/${SLUG}/issues/${n}/comments`, author, {
        method: "POST",
        body: JSON.stringify({ body: "still here" }),
      });

      const before = await get(
        `/projects/${SLUG}/activity?after=${base}&limit=100`,
        admin,
      );
      const mine = (page: { items: Array<{ issue_number: number }> }) =>
        page.items.filter((i) => i.issue_number === n);
      expect(mine(before).length).toBe(2);

      await trash(n);
      const after = await get(
        `/projects/${SLUG}/activity?after=${base}&limit=100`,
        admin,
      );
      // A watching agent learns the card is gone — by number only — and its
      // cursor keeps advancing over an unbroken stream.
      expect(
        mine(after).map((i) => (i as { event_type?: string }).event_type),
      ).toEqual(["deleted"]);

      expect((await restore(n, author)).status).toBe(200);
      const back = await get(
        `/projects/${SLUG}/activity?after=${base}&limit=100`,
        admin,
      );
      expect(mine(back).length).toBe(4);
      expect(
        mine(back).map((i) => (i as { event_type?: string }).event_type),
      ).toEqual(["opened", undefined, "deleted", "restored"]);
    });
  });
});
