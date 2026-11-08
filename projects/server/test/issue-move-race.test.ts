import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestHooks } from "../src/bootstrap.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

/**
 * A move against a competing move, trash or edit (T-666).
 *
 * The hooks put the competitor on a chosen side of each gap: committed
 * after the move planned but before it took the card, or after the trash
 * checked but before it wrote. Shared placement exercises the single
 * transaction, the other two the freeze. PGlite serialises every
 * transaction on one connection, so only real postgres has the trash
 * actually wait on the move's row lock — the simultaneous cases are the
 * ones that run there.
 */
describe.each(PLACEMENTS)("move races (%s placement)", (placement) => {
  races(placement, (hooks) => makeTestApp(placement, undefined, hooks));
});

describe.skipIf(!PG_URL)("move races on real postgres", () => {
  // The database persists across runs; unique slugs isolate each one.
  races(`pg-${Date.now().toString(36)}`, (hooks) =>
    makeTestApp("shared", { systemUrl: PG_URL }, hooks),
  );
});

function races(tag: string, open: (hooks: TestHooks) => Promise<TestApp>) {
  let t: TestApp;
  let admin: Who;
  const A = `race-a-${tag}`;
  const B = `race-b-${tag}`;
  const C = `race-c-${tag}`;

  /** Each hook fires once, so the competitor it starts does not re-enter it. */
  const pending: {
    afterMovePlan?: () => Promise<void>;
    beforeTrashWrite?: () => Promise<void>;
  } = {};
  const once = (key: keyof typeof pending) => async () => {
    const run = pending[key];
    delete pending[key];
    await run?.();
  };
  const hooks: TestHooks = {
    afterMovePlan: once("afterMovePlan"),
    beforeTrashWrite: once("beforeTrashWrite"),
  };

  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...admin }
        : admin,
    });
  const createIssue = async (title: string) => {
    const res = await req(`/projects/${A}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: "body" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { number: number };
  };
  const move = (number: number, to: string) =>
    req(`/projects/${A}/issues/${number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
  const trash = (number: number) =>
    req(`/projects/${A}/issues/${number}`, { method: "DELETE" });
  /** Live cards titled `title` in `slug`, by number. */
  const liveIn = async (slug: string, title: string) =>
    (await json(await req(`/projects/${slug}/issues?limit=100`))).items
      .filter((i: { title: string }) => i.title === title)
      .map((i: { number: number }) => i.number);

  beforeAll(async () => {
    t = await open(hooks);
    admin = { cookie: await t.login() };
    for (const slug of [A, B, C]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("refuses a move whose card another move took after it planned", async () => {
    const card = await createIssue("contested");
    let second: Response | undefined;
    pending.afterMovePlan = async () => {
      second = await move(card.number, C);
    };

    const first = await move(card.number, B);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect((await json(first)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "contested")).toEqual([]);
    expect(await liveIn(C, "contested")).toHaveLength(1);
    const source = await req(`/projects/${A}/issues/${card.number}`);
    expect(source.status).toBe(301);
    expect(source.headers.get("location")).toContain(`/projects/${C}/`);
  });

  it("refuses a move whose card went to the trash after it planned", async () => {
    const card = await createIssue("trashed mid-move");
    let trashed: Response | undefined;
    pending.afterMovePlan = async () => {
      trashed = await trash(card.number);
    };

    const res = await move(card.number, B);
    expect(trashed?.status).toBe(204);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_deleted");
    expect(await liveIn(B, "trashed mid-move")).toEqual([]);
    // Still in the trash where it was put, and still restorable.
    const source = await json(
      await req(`/projects/${A}/issues/${card.number}`),
    );
    expect(source.deleted_at).not.toBeNull();
    expect(
      (
        await req(`/projects/${A}/issues/${card.number}/restore`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a trash whose card moved after it checked", async () => {
    const card = await createIssue("moved mid-trash");
    let moved: Response | undefined;
    pending.beforeTrashWrite = async () => {
      moved = await move(card.number, B);
    };

    const res = await trash(card.number);
    expect(moved?.status).toBe(200);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "moved mid-trash")).toHaveLength(1);
    // The tombstone was not marked deleted behind the redirect.
    expect((await req(`/projects/${A}/issues/${card.number}`)).status).toBe(
      301,
    );
  });

  it("refuses to trash a tombstone", async () => {
    const card = await createIssue("already gone");
    expect((await move(card.number, B)).status).toBe(200);
    const res = await trash(card.number);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "already gone")).toHaveLength(1);
  });

  it("carries an edit made after the move planned", async () => {
    for (const slug of [A, B]) {
      const res = await req(`/projects/${slug}/labels`, {
        method: "POST",
        body: JSON.stringify({ name: `late-${tag}` }),
      });
      expect(res.status).toBe(201);
    }
    const labelA = (await json(await req(`/projects/${A}/labels`))).find(
      (l: { name: string }) => l.name === `late-${tag}`,
    );
    const statusesA = await json(await req(`/projects/${A}/statuses`));
    const done = statusesA.find((s: { name: string }) => s.name === "Done");
    expect(done).toBeDefined();
    const card = await createIssue("before the edit");
    pending.afterMovePlan = async () => {
      const res = await req(`/projects/${A}/issues/${card.number}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "after the edit",
          status_id: done.id,
          label_ids: [labelA.id],
        }),
      });
      expect(res.status).toBe(200);
    };

    const res = await move(card.number, B);
    expect(res.status).toBe(200);
    const result = await json(res);
    // The response describes the move that happened, not the plan before it.
    expect(result.mapping.status).toEqual({ from: "Done", to: "Done" });
    expect(result.issue.title).toBe("after the edit");
    expect(result.issue.status.name).toBe("Done");
    expect(result.issue.labels.map((l: { name: string }) => l.name)).toEqual([
      `late-${tag}`,
    ]);
  });

  const ROUNDS = 5;

  it("lets exactly one of two simultaneous moves through", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const title = `simultaneous ${round}`;
      const card = await createIssue(title);
      const results = await Promise.all([
        move(card.number, B),
        move(card.number, C),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const copies = [...(await liveIn(B, title)), ...(await liveIn(C, title))];
      expect(copies).toHaveLength(1);
    }
  });

  it("never answers both a move and a trash with success", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const title = `move or trash ${round}`;
      const card = await createIssue(title);
      const [m, d] = await Promise.all([
        move(card.number, B),
        trash(card.number),
      ]);
      // Whichever commits first wins; the other is refused, never both.
      expect([m.status, d.status].sort().join()).toMatch(/^(200,409|204,409)$/);
      expect(await liveIn(B, title)).toHaveLength(m.status === 200 ? 1 : 0);
    }
  });
}
