import type { MemberRole } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUEST_COVERED } from "./guest-covered.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import { agent, openFeed } from "./watchers-helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

/** Every case name below, so the coverage table can be checked against it. */
const CASES = new Set<string>();
function cover(name: string, fn: () => Promise<void>) {
  CASES.add(name);
  it(name, fn);
}

/**
 * T-788. One project holding an admin's card A and two guests' cards G and
 * H; A carries everything a card can carry. Each guest path is asked about
 * A and H, where it must answer exactly as for a number nobody used, and
 * about G, where it must answer normally.
 */
describe("the guest role", () => {
  let t: TestApp;
  let cookie: string;
  let adminLogin = "";
  const P = "guest-vis";
  const D = "guest-downstream";

  const admin = (): Who => ({ "content-type": "application/json", cookie });
  let one: Who;
  let two: Who;
  let lurker: Who;
  let lurkerId = 0;
  let downstream: Who;
  let oneId = 0;

  const A = { number: 0, comment: 0, attachment: 0 };
  const G = { number: 0, comment: 0, attachment: 0 };
  let H = 0;
  /** A number nobody used, the answer every hidden card must match. */
  const NEVER = 9_999;

  const req = (path: string, who: Who, init: RequestInit = {}) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init.body !== undefined && typeof init.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...who,
      },
    });
  const get = (path: string, who: Who) => req(path, who);
  const send = (method: string, path: string, who: Who, body?: unknown) =>
    req(path, who, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function open(slug: string, who: Who, title: string, body = "") {
    const res = await send("POST", `/projects/${slug}/issues`, who, {
      title,
      body,
    });
    expect(res.status, title).toBe(201);
    return (await json(res)).number as number;
  }

  async function comment(number: number, who: Who, body: string) {
    const res = await send(
      "POST",
      `/projects/${P}/issues/${number}/comments`,
      who,
      { body },
    );
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  }

  async function upload(number: number, who: Who) {
    const form = new FormData();
    form.set("file", new File(["bytes"], "shot.txt"));
    form.set("issue_number", String(number));
    const res = await t.app.request(`/api/projects/${P}/attachments`, {
      method: "POST",
      headers: who,
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  }

  async function seat(slug: string, userId: number, role: MemberRole) {
    const res = await send(
      "PUT",
      `/projects/${slug}/members/${userId}`,
      admin(),
      { role },
    );
    expect(res.status).toBe(204);
  }

  /** Same status and body for A, H and a number never used. */
  async function hiddenLikeNothing(path: (n: number) => string, who = one) {
    const never = await get(path(NEVER), who);
    for (const n of [A.number, H]) {
      const res = await get(path(n), who);
      expect(res.status, path(n)).toBe(never.status);
      expect(await res.text(), path(n)).toBe(await never.clone().text());
    }
    expect(never.status, path(NEVER)).toBe(404);
  }

  const timelineOf = async (number: number, who: Who) => {
    const res = await get(
      `/projects/${P}/issues/${number}/timeline?limit=100`,
      who,
    );
    expect(res.status).toBe(200);
    return (await json(res)).items as Array<{
      type: string;
      event_type?: string;
      payload?: Record<string, unknown>;
    }>;
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    adminLogin = (await json(await get("/me", { cookie }))).login;
    for (const [slug, name] of [
      [P, "Guest visibility"],
      [D, "Downstream"],
    ] as const) {
      const res = await send("POST", "/projects", admin(), { slug, name });
      expect(res.status).toBe(201);
    }

    const guestOne = await addUserWithToken(t.ctx, "guest-one");
    const guestTwo = await addUserWithToken(t.ctx, "guest-two");
    const guestOnly = await addUserWithToken(t.ctx, "lurker");
    const writer = await addUserWithToken(t.ctx, "downstream-writer");
    one = guestOne.headers;
    two = guestTwo.headers;
    lurker = guestOnly.headers;
    lurkerId = guestOnly.user.id;
    downstream = writer.headers;
    oneId = guestOne.user.id;
    await seat(P, guestOne.user.id, "guest");
    await seat(P, guestTwo.user.id, "guest");
    await seat(P, guestOnly.user.id, "guest");
    await seat(D, guestOne.user.id, "writer");
    await seat(D, guestTwo.user.id, "reader");
    await seat(D, writer.user.id, "writer");

    G.number = await open(P, one, "the guest's own card");
    H = await open(P, two, "the other guest's card");
    A.number = await open(
      P,
      admin(),
      "the maintainer's card",
      `follows on from #${G.number}`,
    );
    A.comment = await comment(A.number, admin(), "@guest-one have a look");
    A.attachment = await upload(A.number, { cookie });
    G.comment = await comment(G.number, admin(), "thanks, on it");
    G.attachment = await upload(G.number, one);

    // A waits on G, so G's own card has an edge naming A.
    expect(
      (
        await send(
          "POST",
          `/projects/${P}/issues/${A.number}/blocked-by`,
          admin(),
          {
            ref: `#${G.number}`,
          },
        )
      ).status,
    ).toBe(200);
    for (const n of [A.number, G.number]) {
      expect(
        (
          await send("POST", `/projects/${P}/issues/${n}/spec/push`, admin(), {
            files: [{ path: "design.md", body: "# v1" }],
            message: "v1",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send("PATCH", `/projects/${P}/issues/${n}/metadata`, admin(), {
            entries: [{ namespace: "orch", key: "phase", value: "spec" }],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send("POST", `/projects/${P}/issues/${n}/comments`, admin(), {
            body: "context…",
            component: {
              type: "questions",
              questions: [
                {
                  question: "Ship it?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          })
        ).status,
      ).toBe(201);
    }
    // A revision on each, so the revision lists have something to show.
    for (const n of [A.number, G.number]) {
      expect(
        (
          await send("PATCH", `/projects/${P}/issues/${n}`, admin(), {
            body: "edited",
          })
        ).status,
      ).toBe(200);
    }
  });

  afterAll(async () => {
    t.ctx.watchers.dispose();
    await t.cleanup();
  });

  describe("addressing another member's card", () => {
    const paths: Record<string, (n: number) => string> = {
      issue: (n) => `/projects/${P}/issues/${n}`,
      timeline: (n) => `/projects/${P}/issues/${n}/timeline`,
      references: (n) => `/projects/${P}/issues/${n}/references`,
      revisions: (n) => `/projects/${P}/issues/${n}/revisions`,
      questions: (n) => `/projects/${P}/issues/${n}/questions`,
      spec: (n) => `/projects/${P}/issues/${n}/spec`,
      "spec files": (n) => `/projects/${P}/issues/${n}/spec/files?version=1`,
      "spec comments": (n) => `/projects/${P}/issues/${n}/spec/comments`,
      metadata: (n) => `/projects/${P}/issues/${n}/metadata?namespace=orch`,
      "metadata namespaces": (n) =>
        `/projects/${P}/issues/${n}/metadata/namespaces`,
      attachments: (n) => `/projects/${P}/attachments?issue_number=${n}`,
      "deleted attachments": (n) =>
        `/projects/${P}/attachments/deleted?issue_number=${n}`,
    };

    cover("reads of the card and everything hanging off it", async () => {
      for (const [name, path] of Object.entries(paths)) {
        await hiddenLikeNothing(path);
        expect((await get(path(G.number), one)).status, name).toBe(200);
      }
    });

    cover("a comment, by its card or by id alone", async () => {
      const onCard = (n: number, id: number) =>
        `/projects/${P}/issues/${n}/comments/${id}`;
      expect((await get(onCard(A.number, A.comment), one)).status).toBe(404);
      expect(
        (await get(`${onCard(A.number, A.comment)}/revisions`, one)).status,
      ).toBe(404);
      expect((await get(onCard(G.number, G.comment), one)).status).toBe(200);
      expect(
        (await get(`/projects/${P}/comments/${A.comment}`, one)).status,
      ).toBe(404);
      expect(
        (await get(`/projects/${P}/comments/${G.comment}`, one)).status,
      ).toBe(200);
    });

    cover("an attachment by id", async () => {
      for (const variant of ["download", "view"]) {
        expect(
          (
            await get(
              `/projects/${P}/attachments/${A.attachment}/${variant}`,
              one,
            )
          ).status,
          variant,
        ).toBe(404);
        expect(
          (
            await get(
              `/projects/${P}/attachments/${G.attachment}/${variant}`,
              one,
            )
          ).status,
          variant,
        ).toBe(200);
      }
      expect(
        (
          await get(
            `/projects/${P}/attachments/${A.attachment}/references`,
            one,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await get(
            `/projects/${P}/attachments/${G.attachment}/references`,
            one,
          )
        ).status,
      ).toBe(200);
    });

    cover("writes to the card", async () => {
      const writes: Array<[string, (n: number) => string, unknown]> = [
        ["POST", (n) => `/projects/${P}/issues/${n}/comments`, { body: "hi" }],
        ["PATCH", (n) => `/projects/${P}/issues/${n}`, { title: "mine now" }],
        ["DELETE", (n) => `/projects/${P}/issues/${n}`, undefined],
        [
          "PATCH",
          (n) => `/projects/${P}/issues/${n}/comments/${A.comment}`,
          { body: "rewritten" },
        ],
        [
          "POST",
          (n) =>
            `/projects/${P}/issues/${n}/comments/${A.comment}/questions/withdraw`,
          {},
        ],
      ];
      for (const [method, path, body] of writes) {
        for (const n of [A.number, H, NEVER]) {
          expect(
            (await send(method, path(n), one, body)).status,
            `${method} ${path(n)}`,
          ).toBe(404);
        }
      }
      const form = new FormData();
      form.set("file", new File(["x"], "x.txt"));
      form.set("issue_number", String(A.number));
      expect(
        (
          await t.app.request(`/api/projects/${P}/attachments`, {
            method: "POST",
            headers: one,
            body: form,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send(
            "DELETE",
            `/projects/${P}/attachments/${A.attachment}`,
            one,
          )
        ).status,
      ).toBe(404);
    });

    cover("marking read, muting and watching", async () => {
      for (const n of [A.number, H, NEVER]) {
        const read = `/projects/${P}/issues/${n}/read`;
        expect((await send("PUT", read, one, {})).status, read).toBe(404);
        const mute = `/projects/${P}/issues/${n}/mute`;
        expect(
          (await send("PUT", mute, one, { mode: "forever" })).status,
          mute,
        ).toBe(404);
        expect((await send("DELETE", mute, one)).status, mute).toBe(404);
        const watch = `/projects/${P}/issues/${n}/watch`;
        expect(
          (await send("PUT", watch, { ...one, ...agent("guest-s1") })).status,
          watch,
        ).toBe(404);
      }
      expect(
        (await send("PUT", `/projects/${P}/issues/${G.number}/read`, one, {}))
          .status,
      ).toBe(204);
      expect(
        (
          await send("PUT", `/projects/${P}/issues/${G.number}/mute`, one, {
            mode: "forever",
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await send("PUT", `/projects/${P}/issues/${G.number}/watch`, {
            ...one,
            ...agent("guest-s1"),
          })
        ).status,
      ).toBe(200);
      expect(
        (await send("DELETE", `/projects/${P}/issues/${G.number}/mute`, one))
          .status,
      ).toBe(204);
      // Several at once skips what it cannot see, like a number never used.
      expect(
        (
          await send("PUT", `/projects/${P}/issues/read`, one, {
            numbers: [A.number, G.number],
          })
        ).status,
      ).toBe(204);
    });

    cover("a mixed batch answers each item on its own", async () => {
      const res = await send("POST", "/batch", one, {
        requests: [
          { url: `/projects/${P}/issues/${A.number}` },
          { url: `/projects/${P}/issues/${G.number}` },
        ],
      });
      expect(res.status).toBe(200);
      const { responses } = await json(res);
      expect(responses.map((r: { status: number }) => r.status)).toEqual([
        404, 200,
      ]);
    });
  });

  describe("lists, counts and aggregates", () => {
    const numbersOf = (items: Array<{ number: number }>) =>
      items.map((i) => i.number).sort((a, b) => a - b);

    cover("the issue list and its filters", async () => {
      for (const query of [
        "",
        `?numbers=${A.number},${G.number},${H}`,
        "?q=card",
        "?blocked=false",
        "?sort=number&order=asc",
      ]) {
        const res = await get(`/projects/${P}/issues${query}`, one);
        expect(res.status, query).toBe(200);
        expect(numbersOf((await json(res)).items), query).toEqual([G.number]);
      }
      const trash = await get(`/projects/${P}/issues?deleted=true`, one);
      expect((await json(trash)).items).toEqual([]);
    });

    cover("the counts", async () => {
      const res = await get(`/projects/${P}/issues/counts`, one);
      expect(res.status).toBe(200);
      const counts = await json(res);
      expect(counts.open + counts.closed).toBe(1);
    });

    cover("project and cross-project activity", async () => {
      for (const path of [
        `/projects/${P}/activity?limit=100`,
        "/activity?limit=100",
        `/activity?limit=100&projects=${P}`,
      ]) {
        const res = await get(path, one);
        expect(res.status, path).toBe(200);
        const items = (await json(res)).items as Array<{
          issue_number: number;
          project?: string;
        }>;
        const here = items.filter((i) => (i.project ?? P) === P);
        expect(here.length, path).toBeGreaterThan(0);
        expect(new Set(here.map((i) => i.issue_number)), path).toEqual(
          new Set([G.number]),
        );
      }
    });

    cover("the inbox, scoped or not", async () => {
      await comment(A.number, admin(), "@guest-one once more");
      await comment(G.number, admin(), "news on your card");
      for (const path of ["/me/inbox", `/me/inbox?projects=${P}`]) {
        const res = await get(path, one);
        expect(res.status, path).toBe(200);
        const mine = (await json(res)).items.filter(
          (i: { project: { slug: string } }) => i.project.slug === P,
        );
        // The mention on A would have put A here for anyone else named.
        expect(numbersOf(mine), path).toEqual([G.number]);
      }
    });

    cover("mutes, and marking everything read", async () => {
      // A mute left over from before the seat became a guest's.
      await seat(P, lurkerId, "reader");
      expect(
        (
          await send("PUT", `/projects/${P}/issues/${A.number}/mute`, lurker, {
            mode: "forever",
          })
        ).status,
      ).toBe(204);
      await seat(P, lurkerId, "guest");
      const left = await json(await get("/me/mutes", lurker));
      expect(left.issues).toEqual([]);

      expect(
        (
          await send("PUT", `/projects/${P}/issues/${G.number}/mute`, one, {
            mode: "forever",
          })
        ).status,
      ).toBe(204);
      const res = await get("/me/mutes", one);
      expect(res.status).toBe(200);
      expect(
        (await json(res)).issues.map((i: { number: number }) => i.number),
      ).toEqual([G.number]);
      expect(
        (await send("DELETE", `/projects/${P}/issues/${G.number}/mute`, one))
          .status,
      ).toBe(204);
      expect((await send("PUT", `/projects/${P}/mute`, one)).status).toBe(204);
      expect((await send("DELETE", `/projects/${P}/mute`, one)).status).toBe(
        204,
      );
      expect((await send("PUT", "/me/read", one, {})).status).toBe(204);
    });

    cover("the project's watchers", async () => {
      const res = await get(`/projects/${P}/watchers`, one);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.project).toEqual([]);
      for (const number of Object.keys(body.issues)) {
        expect(Number(number)).toBe(G.number);
      }
    });

    cover("what the project shell still shows", async () => {
      for (const path of [
        `/projects/${P}`,
        `/projects/${P}/labels`,
        `/projects/${P}/statuses`,
        `/projects/${P}/references/config`,
      ]) {
        expect((await get(path, one)).status, path).toBe(200);
      }
      // No icon was ever uploaded, so a guest gets the same 404 an admin does.
      const icon = `/projects/${P}/icon`;
      expect((await get(icon, one)).status).toBe(
        (await get(icon, { cookie })).status,
      );
    });

    cover("what a guest is refused outright", async () => {
      for (const path of [
        `/projects/${P}/search?q=card`,
        `/projects/${P}/members`,
        `/projects/${P}/labels/usage`,
        `/projects/${P}/statuses/usage`,
        `/projects/${P}/insights/settings`,
      ]) {
        const res = await get(path, one);
        expect(res.status, path).toBe(403);
      }
      expect(
        (
          await send(
            "POST",
            `/projects/${P}/issues/${G.number}/blocked-by`,
            one,
            {
              ref: `#${H}`,
            },
          )
        ).status,
      ).toBe(403);
    });

    cover("people it only shares the guest project with", async () => {
      expect((await get(`/users/${adminLogin}`, lurker)).status).toBe(404);
      expect((await get(`/users/guest-two`, lurker)).status).toBe(404);
      const projects = await json(await get("/me/reference-directory", lurker));
      expect(projects).toBeDefined();
    });
  });

  describe("other cards seen from the guest's own", () => {
    cover("block edges and timeline lines naming them", async () => {
      const card = await json(
        await get(`/projects/${P}/issues/${G.number}`, one),
      );
      expect(card.blocks).toHaveLength(1);
      expect(card.blocks[0]).toMatchObject({
        hidden: true,
        project_id: null,
        number: null,
        ref: null,
      });

      const items = await timelineOf(G.number, one);
      const edge = items.find((i) => i.event_type === "block_added");
      expect(edge?.payload).toMatchObject({
        other_project_id: null,
        other_number: null,
      });
      // The admin's body named G, and the line saying so would name A.
      expect(items.some((i) => i.event_type === "referenced")).toBe(false);
      const asAdmin = await timelineOf(G.number, { cookie });
      expect(asAdmin.some((i) => i.event_type === "referenced")).toBe(true);
    });

    cover("the references panel", async () => {
      const refs = await json(
        await get(`/projects/${P}/issues/${G.number}/references`, one),
      );
      expect(refs.linked_from).toEqual([]);
    });

    cover("a reference the guest writes stays plain text", async () => {
      const written = `see #${A.number} and #${H} and #comment-${A.comment}, cc @${adminLogin}`;
      const id = await comment(G.number, one, written);
      const back = await json(
        await get(`/projects/${P}/issues/${G.number}/comments/${id}`, one),
      );
      expect(back.body).toBe(written);
      for (const n of [A.number, H]) {
        const lines = await timelineOf(n, { cookie });
        expect(
          lines.some(
            (i) =>
              i.event_type === "referenced" && i.payload?.by_issue === G.number,
          ),
          `#${n}`,
        ).toBe(false);
      }
      // Its own card it may still link.
      const own = await comment(G.number, one, `again #${G.number}`);
      expect(own).toBeGreaterThan(0);
    });

    cover("opening a card refers to nothing it cannot see", async () => {
      const n = await open(P, one, "second card", `after #${A.number}`);
      const card = await json(await get(`/projects/${P}/issues/${n}`, one));
      expect(card.body).toBe(`after #${A.number}`);
      const lines = await timelineOf(A.number, { cookie });
      expect(
        lines.some(
          (i) => i.event_type === "referenced" && i.payload?.by_issue === n,
        ),
      ).toBe(false);
      expect(
        (
          await send("PATCH", `/projects/${P}/issues/${n}`, one, {
            title: "renamed",
          })
        ).status,
      ).toBe(200);
      expect(
        (await send("DELETE", `/projects/${P}/issues/${n}`, one)).status,
      ).toBe(204);
    });
  });

  describe("streams", () => {
    async function changesUntil(
      path: string,
      act: () => Promise<void>,
      done: (e: Record<string, unknown>) => boolean,
    ) {
      const feed = await openFeed(t, `/api${path}`, one);
      try {
        await act();
        const seen: Array<Record<string, unknown>> = [];
        for (;;) {
          const e = await feed.nextChange();
          seen.push(e);
          if (done(e)) return seen;
        }
      } finally {
        feed.abort();
      }
    }

    const burst = async () => {
      await comment(A.number, admin(), "only for the maintainers");
      await comment(H, admin(), "for the other guest");
      expect(
        (
          await send("POST", `/projects/${P}/labels`, admin(), {
            name: `label-${Date.now()}`,
            color: "#123456",
          })
        ).status,
      ).toBe(201);
      await comment(G.number, admin(), "the last word");
    };
    const lastWord = (e: Record<string, unknown>) =>
      e.issue_number === G.number && e.entity === "timeline";

    for (const [name, path] of [
      ["the user stream", "/events?metadata=*&presence=1"],
      ["the project stream", `/projects/${P}/events?metadata=*&presence=1`],
    ] as const) {
      cover(`${name} carries only the guest's cards`, async () => {
        const seen = await changesUntil(path, burst, lastWord);
        const numbers = seen
          .filter((e) => e.project === P && e.issue_number !== undefined)
          .map((e) => e.issue_number);
        expect(new Set(numbers)).toEqual(new Set([G.number]));
        expect(seen.some((e) => e.entity === "label")).toBe(true);
      });
    }
  });

  describe("blocked by a card across projects", () => {
    let waiting = 0;

    beforeAll(async () => {
      waiting = await open(D, downstream, "needs the upstream fix");
    });

    cover("only the guest who opened the far card may name it", async () => {
      // guest-one is a writer in D and the author of G in P.
      const mine = await send(
        "POST",
        `/projects/${D}/issues/${waiting}/blocked-by`,
        one,
        {
          ref: `${P}#${G.number}`,
        },
      );
      expect(mine.status).toBe(200);
      expect((await json(mine)).blocked_by[0]).toMatchObject({
        hidden: false,
        number: G.number,
      });
      for (const n of [A.number, H, NEVER]) {
        expect(
          (
            await send(
              "POST",
              `/projects/${D}/issues/${waiting}/blocked-by`,
              one,
              {
                ref: `${P}#${n}`,
              },
            )
          ).status,
          `${P}#${n}`,
        ).toBe(404);
      }
    });

    cover(
      "everyone else in the downstream project sees it hidden",
      async () => {
        for (const who of [two, downstream]) {
          const card = await json(
            await get(`/projects/${D}/issues/${waiting}`, who),
          );
          expect(card.blocked_by[0]).toMatchObject({
            hidden: true,
            number: null,
          });
        }
        const card = await json(
          await get(`/projects/${D}/issues/${waiting}`, one),
        );
        expect(card.blocked_by[0]).toMatchObject({ hidden: false });
      },
    );

    cover(
      "the far card crossing the clear line still unblocks it",
      async () => {
        const statuses = await json(
          await get(`/projects/${P}/statuses`, { cookie }),
        );
        const shipped = statuses.find(
          (s: { name: string }) => s.name === "Shipped",
        );
        expect(shipped).toBeDefined();
        expect(
          (
            await send("PATCH", `/projects/${P}/issues/${G.number}`, admin(), {
              status_id: shipped.id,
            })
          ).status,
        ).toBe(200);
        for (const who of [one, two, downstream]) {
          const card = await json(
            await get(`/projects/${D}/issues/${waiting}`, who),
          );
          expect(card.blocked_by[0].cleared_at).not.toBeNull();
        }
      },
    );
  });

  it("names a real case for every entry of the coverage table", () => {
    const named = new Set(Object.values(GUEST_COVERED).flat());
    for (const name of named) expect(CASES, name).toContain(name);
    expect(oneId).toBeGreaterThan(0);
  });
});
