import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * `scope` is a correlated subquery over jsonb and a row comparison, so it
 * runs against a real postgres too whenever TODOU_TEST_POSTGRES_URL points
 * at one (see timeline-postgres.test.ts for the invocation).
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const BACKENDS: Array<[string, string | undefined]> = [
  ["pglite", undefined],
  ...(PG_URL ? [["postgres", PG_URL] as [string, string | undefined]] : []),
];

type Item = {
  type: string;
  body?: string;
  event_type?: string;
  issue_number: number;
};

describe.each(BACKENDS)("activity scope T-576 (%s)", (backend, systemUrl) => {
  let t: TestApp;
  let cookie: string;
  let meId = 0;
  let meLogin = "";
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  let baseline = "";
  const stamp = Date.now().toString(36);
  const slug = `scope-${backend}-${stamp}`;
  const elsewhere = `scope-to-${backend}-${stamp}`;
  /** Card number → its fixture name, so a key reads as `x:comment x-1`. */
  const names = new Map<number, string>();

  const mine = () => ({ "content-type": "application/json", cookie });
  const bobs = () => ({ "content-type": "application/json", ...bob.headers });

  const keyOf = (i: Item) =>
    `${names.get(i.issue_number) ?? i.issue_number}:${
      i.type === "comment" ? i.body?.split(" ")[0] : i.event_type
    }`;

  const activity = async (qs: string) => {
    const res = await t.app.request(
      `/api/projects/${slug}/activity?after=${encodeURIComponent(baseline)}&limit=100&${qs}`,
      { headers: { cookie } },
    );
    return res;
  };
  const keys = async (qs: string): Promise<string[]> => {
    const res = await activity(qs);
    expect(res.status).toBe(200);
    return ((await json(res)).items as Item[]).map(keyOf);
  };

  const create = async (
    name: string,
    opts: { body?: string; assignee_ids?: number[] } = {},
  ): Promise<number> => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      // Self-mentions are never recorded, so the author is bob unless the
      // card is handed to me at birth, which takes triage.
      headers: opts.assignee_ids === undefined ? bobs() : mine(),
      body: JSON.stringify({ title: name, ...opts }),
    });
    expect(res.status).toBe(201);
    const number = (await json(res)).number as number;
    names.set(number, name);
    return number;
  };
  const comment = async (number: number, body: string) => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      { method: "POST", headers: bobs(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; body: string };
  };
  const assignees = async (number: number, ids: number[]) => {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      headers: mine(),
      body: JSON.stringify({ assignee_ids: ids }),
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", systemUrl ? { systemUrl } : undefined);
    cookie = await t.login();
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    meId = me.id as number;
    meLogin = me.login as string;
    for (const s of [slug, elsewhere]) {
      expect(
        (
          await t.app.request("/api/projects", {
            method: "POST",
            headers: mine(),
            body: JSON.stringify({ slug: s, name: s }),
          })
        ).status,
      ).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, `bob-${slug}`);
    expect(
      (
        await t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
          method: "PUT",
          headers: mine(),
          body: JSON.stringify({ role: "writer" }),
        })
      ).status,
    ).toBe(204);
    // An empty project has no position; one card before the baseline gives
    // the stream one, and keeps that card out of every assertion.
    await create("before");
    baseline = (
      await json(
        await t.app.request(`/api/projects/${slug}/activity?last=1&limit=1`, {
          headers: { cookie },
        }),
      )
    ).next_cursor as string;

    // x: mine from creation (no assignment event at all), later taken away.
    const x = await create("x", { assignee_ids: [meId] });
    await comment(x, "x-1");
    // y: never mine; one comment names me.
    const y = await create("y");
    await comment(y, "y-plain");
    await comment(y, `y-ping @${meLogin}`);
    // z: assigned and unassigned in the middle of its life.
    const z = await create("z");
    await comment(z, "z-before");
    await assignees(z, [meId]);
    await comment(z, "z-held");
    await assignees(z, []);
    await comment(z, "z-after");
    // w: its body names me, nothing else does.
    await create("w", { body: `for @${meLogin}` });
    // v: a mention added by editing an old comment is not news.
    const v = await create("v");
    const old = await comment(v, "v-old");
    expect(
      (
        await t.app.request(
          `/api/projects/${slug}/issues/${v}/comments/${old.id}`,
          {
            method: "PATCH",
            headers: bobs(),
            body: JSON.stringify({ body: `v-old @${meLogin}` }),
          },
        )
      ).status,
    ).toBe(200);
    // Taking x away last: its earlier entries happened while it was mine
    // and must stay in a replay read after the fact.
    await assignees(x, []);
    await comment(x, "x-after");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("delivers what concerned the account when it happened, and nothing else", async () => {
    expect(await keys("scope=assigned,mentioned")).toEqual([
      "x:opened",
      "x:x-1",
      "y:y-ping",
      "z:assigned",
      "z:z-held",
      "z:unassigned",
      "w:opened",
      "x:unassigned",
    ]);
  });

  it("keeps the two axes apart", async () => {
    expect(await keys("scope=assigned")).toEqual([
      "x:opened",
      "x:x-1",
      "z:assigned",
      "z:z-held",
      "z:unassigned",
      "x:unassigned",
    ]);
    expect(await keys("scope=mentioned")).toEqual(["y:y-ping", "w:opened"]);
  });

  it("leaves an unscoped read whole", async () => {
    const all = await keys("");
    expect(all).toContain("y:y-plain");
    expect(all).toContain("z:z-before");
    expect(all).toContain("z:z-after");
    expect(all).toContain("x:x-after");
    expect(all).toHaveLength(16);
    const res = await activity("");
    expect((await json(res)).scope).toBeUndefined();
  });

  it("echoes the scope it applied, normalized", async () => {
    const res = await activity("scope=mentioned,assigned,assigned");
    expect((await json(res)).scope).toEqual(["assigned", "mentioned"]);
  });

  it("refuses a scope it does not know, naming it", async () => {
    const res = await activity("scope=assigned,watching");
    expect(res.status).toBe(422);
    expect(JSON.stringify(await json(res))).toContain("watching");
  });

  it("is the scope of the account that reads, not of a parameter", async () => {
    const res = await t.app.request(
      `/api/projects/${slug}/activity?after=${encodeURIComponent(baseline)}&limit=100&scope=assigned,mentioned`,
      { headers: bob.headers },
    );
    expect(res.status).toBe(200);
    expect((await json(res)).items).toEqual([]);
  });

  it("applies across projects the same way", async () => {
    const res = await t.app.request(
      `/api/activity?projects=${slug}&after=${encodeURIComponent(baseline)}&limit=100&scope=assigned,mentioned`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.scope).toEqual(["assigned", "mentioned"]);
    expect((body.items as Item[]).map(keyOf)).toEqual([
      "x:opened",
      "x:x-1",
      "y:y-ping",
      "z:assigned",
      "z:z-held",
      "z:unassigned",
      "w:opened",
      "x:unassigned",
    ]);
  });

  it("lets one session of a shared account call the others", async () => {
    const before = (
      await json(
        await t.app.request(`/api/projects/${slug}/activity?last=1&limit=1`, {
          headers: { cookie },
        }),
      )
    ).next_cursor as string;
    const s = await create("s");
    const as = (session?: string) => ({
      ...mine(),
      ...(session === undefined
        ? {}
        : {
            "x-todou-agent-context": JSON.stringify({
              agent: "claude-code",
              session_id: session,
            }),
          }),
    });
    for (const [headers, body] of [
      [as("session-caller"), `s-call @${meLogin}`],
      [as(), `s-web @${meLogin}`],
    ] as const) {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${s}/comments`,
        { method: "POST", headers, body: JSON.stringify({ body }) },
      );
      expect(res.status).toBe(201);
    }
    // What a watching session sends: its own session, and the account for
    // entries that carry none.
    const seenBy = async (session: string) => {
      const res = await t.app.request(
        `/api/projects/${slug}/activity?after=${encodeURIComponent(before)}&limit=100&scope=mentioned&exclude_actor=${meId}&exclude_agent_session=${session}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      return ((await json(res)).items as Item[]).map(keyOf);
    };
    expect(await seenBy("session-sibling")).toEqual(["s:s-call"]);
    expect(await seenBy("session-caller")).toEqual([]);
  });

  it("tells the holder when its card moves away", async () => {
    const before = (
      await json(
        await t.app.request(`/api/projects/${slug}/activity?last=1&limit=1`, {
          headers: { cookie },
        }),
      )
    ).next_cursor as string;
    const held = await create("held", { assignee_ids: [meId] });
    const other = await create("other");
    for (const number of [held, other]) {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}/move`,
        {
          method: "POST",
          headers: mine(),
          body: JSON.stringify({ to_project: elsewhere }),
        },
      );
      expect(res.status).toBe(200);
    }
    const res = await t.app.request(
      `/api/projects/${slug}/activity?after=${encodeURIComponent(before)}&limit=100&scope=assigned&types=moved_out`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const items = (await json(res)).items as Item[];
    expect(items.map((i) => i.issue_number)).toEqual([held]);
  });
});
