import type { ChangeEvent } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type StatusRow = { id: number; name: string; position: number };

describe.each(PLACEMENTS)("status order T-712 (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let counter = 0;
  const headers = () => ({ "content-type": "application/json", cookie });

  async function newProject(): Promise<string> {
    counter += 1;
    const slug = `order-${placement}-${counter}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    return slug;
  }

  async function statuses(slug: string): Promise<StatusRow[]> {
    const res = await t.app.request(`/api/projects/${slug}/statuses`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  const idsOf = (rows: StatusRow[], names: string[]) =>
    names.map((name) => {
      const row = rows.find((s) => s.name === name);
      if (!row) throw new Error(`no status ${name}`);
      return row.id;
    });

  async function lineOf(slug: string): Promise<number | null> {
    const res = await t.app.request(`/api/projects/${slug}`, {
      headers: { cookie },
    });
    return (await json(res)).block_clear_status_id;
  }

  const reorder = (
    slug: string,
    body: unknown,
    who: Record<string, string> = headers(),
  ) =>
    t.app.request(`/api/projects/${slug}/statuses/order`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(body),
    });

  async function createIssue(slug: string, status: number): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "issue", status_id: status }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function blockEvents(slug: string, number: number): Promise<string[]> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items
      .map((i: { event_type?: string }) => i.event_type)
      .filter((type: string | undefined) => type?.startsWith("block_"));
  }

  /** A card blocked by a card sitting in `status`. */
  async function blockedBy(slug: string, status: number): Promise<number> {
    const blocker = await createIssue(slug, status);
    const blocked = await createIssue(slug, status);
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${blocked}/blocked-by`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ref: `#${blocker}` }),
      },
    );
    expect(res.status).toBeLessThan(300);
    return blocked;
  }

  function recordEvents(): { events: ChangeEvent[]; stop: () => void } {
    const events: ChangeEvent[] = [];
    const stop = t.ctx.bus.subscribe((_projectId, event) => {
      events.push(event);
    });
    return { events, stop };
  }

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
  });

  afterAll(async () => t.cleanup());

  it("rewrites positions to the order given", async () => {
    const slug = await newProject();
    const before = await statuses(slug);
    const ids = before.map((s) => s.id).reverse();
    const res = await reorder(slug, { ids });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.statuses.map((s: StatusRow) => s.id)).toEqual(ids);
    expect(body.statuses.map((s: StatusRow) => s.position)).toEqual(
      ids.map((_, i) => i),
    );
    expect(body.block_clear_status_id).toBe(await lineOf(slug));
    expect((await statuses(slug)).map((s) => s.id)).toEqual(ids);
  });

  it("refuses an id set that is not exactly the project's", async () => {
    const slug = await newProject();
    const other = await newProject();
    const ids = (await statuses(slug)).map((s) => s.id);
    // Under dedicated placement every project numbers its statuses from 1,
    // so only the shared one has a foreign id that is not also a local one.
    const foreign = (await statuses(other))
      .map((s) => s.id)
      .find((id) => !ids.includes(id));
    for (const bad of [
      ids.slice(1),
      [...ids, 999_999],
      ...(foreign === undefined ? [] : [[...ids.slice(1), foreign]]),
      [ids[0] as number, ...ids.slice(0, -1)],
    ]) {
      const res = await reorder(slug, { ids: bad });
      expect(res.status).toBe(409);
      expect((await json(res)).error.message).toBe("statuses changed — reload");
    }
    expect((await statuses(slug)).map((s) => s.id)).toEqual(ids);
  });

  it("writes the line in the same request, clears it, refuses an unknown one", async () => {
    const slug = await newProject();
    const rows = await statuses(slug);
    const ids = rows.map((s) => s.id);
    const [done] = idsOf(rows, ["Done"]);

    const moved = await reorder(slug, { ids, block_clear_status_id: done });
    expect(moved.status).toBe(200);
    expect((await json(moved)).block_clear_status_id).toBe(done);
    expect(await lineOf(slug)).toBe(done);

    const cleared = await reorder(slug, { ids, block_clear_status_id: null });
    expect(cleared.status).toBe(200);
    expect(await lineOf(slug)).toBeNull();

    const refused = await reorder(slug, {
      ids,
      block_clear_status_id: 999_999,
    });
    expect(refused.status).toBe(422);
    expect(await lineOf(slug)).toBeNull();
  });

  it("reevaluates blocks once per drop, not once per moved row", async () => {
    // Ready to Ship moves under Shipped (past the line) while the line moves
    // down to Done (back above it): its card ends where it started, still
    // blocking. Done row by row, the first half would clear the block and
    // the second would revert it.
    const slug = await newProject();
    const rows = await statuses(slug);
    const [ready, done] = idsOf(rows, ["Ready to Ship", "Done"]);
    const blocked = await blockedBy(slug, ready as number);
    const before = await blockEvents(slug, blocked);

    const ids = idsOf(rows, [
      "Backlog",
      "Todo",
      "Next",
      "In Progress",
      "Shipped",
      "Ready to Ship",
      "Done",
      "Invalid",
    ]);
    const res = await reorder(slug, { ids, block_clear_status_id: done });
    expect(res.status).toBe(200);
    expect(await blockEvents(slug, blocked)).toEqual(before);

    // And a drop that does change the verdict announces it exactly once.
    const res2 = await reorder(slug, { ids, block_clear_status_id: ready });
    expect(res2.status).toBe(200);
    expect(await blockEvents(slug, blocked)).toEqual([
      ...before,
      "block_cleared",
    ]);
  });

  it("publishes one event per moved row and one for the line", async () => {
    const slug = await newProject();
    const rows = await statuses(slug);
    const ids = rows.map((s) => s.id);
    const swapped = [ids[1], ids[0], ...ids.slice(2)] as number[];
    const [done] = idsOf(rows, ["Done"]);

    const recorder = recordEvents();
    try {
      await reorder(slug, { ids: swapped, block_clear_status_id: done });
    } finally {
      recorder.stop();
    }
    const updated = recorder.events.filter((e) => e.action === "updated");
    expect(
      updated
        .filter((e) => e.entity === "status")
        .map((e) => e.id)
        .sort(),
    ).toEqual([ids[0], ids[1]].sort());
    expect(updated.filter((e) => e.entity === "project")).toHaveLength(1);
  });

  it("stays silent when nothing changes", async () => {
    const slug = await newProject();
    const ids = (await statuses(slug)).map((s) => s.id);
    const line = await lineOf(slug);
    const recorder = recordEvents();
    try {
      const res = await reorder(slug, { ids, block_clear_status_id: line });
      expect(res.status).toBe(200);
      expect((await reorder(slug, { ids })).status).toBe(200);
    } finally {
      recorder.stop();
    }
    expect(recorder.events).toEqual([]);
  });

  it("refuses a member without status.manage", async () => {
    const slug = await newProject();
    const writer = await addUserWithToken(t.ctx, `order-writer-${placement}`);
    const add = await t.app.request(
      `/api/projects/${slug}/members/${writer.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(add.status).toBe(204);
    const ids = (await statuses(slug)).map((s) => s.id);
    expect((await reorder(slug, { ids }, writer.headers)).status).toBe(403);
  });
});
