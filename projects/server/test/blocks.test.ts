import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueBlocks } from "../src/db/system-schema.ts";
import { repairBlocks } from "../src/services/blocks.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps carry µs; keep actions apart so read positions cannot tie. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const PA = "block-a";
const PB = "block-b";
/** Nobody but the owner is a member here: the redaction case. */
const PC = "block-c";

describe("issue block edges T-377", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  let reporter: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  async function createIssue(
    slug: string,
    title: string,
    who?: Record<string, string>,
  ): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: who ? { "content-type": "application/json", ...who } : headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  const block = async (
    slug: string,
    number: number,
    direction: "blocked-by" | "blocks",
    ref: string,
    who?: Record<string, string>,
  ): Promise<Response> =>
    t.app.request(`/api/projects/${slug}/issues/${number}/${direction}`, {
      method: "POST",
      headers: who ? { "content-type": "application/json", ...who } : headers(),
      body: JSON.stringify({ ref }),
    });

  const unblock = async (
    slug: string,
    number: number,
    direction: "blocked-by" | "blocks",
    edgeId: number,
  ): Promise<Response> =>
    t.app.request(
      `/api/projects/${slug}/issues/${number}/${direction}/${edgeId}`,
      { method: "DELETE", headers: headers() },
    );

  async function issue(
    slug: string,
    number: number,
    who?: Record<string, string>,
  ) {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      headers: who ?? { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  async function statuses(slug: string) {
    const res = await t.app.request(`/api/projects/${slug}/statuses`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  async function statusNamed(slug: string, name: string): Promise<number> {
    const rows = await statuses(slug);
    const row = rows.find((s: { name: string }) => s.name === name);
    expect(row, `status ${name} in ${slug}`).toBeDefined();
    return row.id as number;
  }

  async function setStatus(
    slug: string,
    number: number,
    name: string,
  ): Promise<void> {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: await statusNamed(slug, name) }),
    });
    expect(res.status).toBe(200);
  }

  async function timelineTypes(
    slug: string,
    number: number,
  ): Promise<string[]> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const page = await json(res);
    return page.items
      .filter((i: { type: string }) => i.type === "event")
      .map((i: { event_type: string }) => i.event_type);
  }

  async function blockEvents(
    slug: string,
    number: number,
    who?: Record<string, string>,
  ) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=100`,
      { headers: who ?? { cookie } },
    );
    expect(res.status).toBe(200);
    const page = await json(res);
    return page.items.filter((i: { event_type?: string }) =>
      i.event_type?.startsWith("block_"),
    );
  }

  async function setClearLine(
    slug: string,
    statusName: string | null,
  ): Promise<Response> {
    return t.app.request(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        block_clear_status_id:
          statusName === null ? null : await statusNamed(slug, statusName),
      }),
    });
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const [slug, name, prefix] of [
      [PA, "Block A", "BK"],
      [PB, "Block B", null],
      [PC, "Block C", null],
    ] as const) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name, ref_prefix: prefix }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "block-bob");
    reporter = await addUserWithToken(t.ctx, "block-reporter");
    for (const slug of [PA, PB]) {
      for (const [user, role] of [
        [bob, "writer"],
        [reporter, "reporter"],
      ] as const) {
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

  it("declares an edge and answers with that whole direction", async () => {
    const blocked = await createIssue(PA, "waits");
    const blocker = await createIssue(PA, "goes first");

    const res = await block(PA, blocked, "blocked-by", `#${blocker}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.blocked_by).toHaveLength(1);
    expect(body.blocked_by[0]).toMatchObject({
      number: blocker,
      // This project was created with a prefix, so its own cards spell T-style.
      ref: `BK-${blocker}`,
      hidden: false,
      cleared_at: null,
      blocker_deleted: false,
    });

    // The same row read from both ends.
    expect((await issue(PA, blocked)).blocked_by).toHaveLength(1);
    const other = await issue(PA, blocker);
    expect(other.blocks).toHaveLength(1);
    expect(other.blocks[0].number).toBe(blocked);
    expect(other.blocked_by).toEqual([]);

    // Both ends hear about it — the blocker is being waited on, which is
    // exactly what whoever holds that work needs to know.
    expect(await timelineTypes(PA, blocked)).toContain("block_added");
    expect(await timelineTypes(PA, blocker)).toContain("block_added");
  });

  it("is idempotent: a repeat answers the same and records nothing", async () => {
    const blocked = await createIssue(PA, "repeat blocked");
    const blocker = await createIssue(PA, "repeat blocker");
    const first = await json(
      await block(PA, blocked, "blocked-by", `#${blocker}`),
    );
    const again = await block(PA, blocked, "blocked-by", `BK-${blocker}`);
    expect(again.status).toBe(200);
    const second = await json(again);
    expect(second.blocked_by).toHaveLength(1);
    expect(second.blocked_by[0].edge_id).toBe(first.blocked_by[0].edge_id);
    expect(
      (await timelineTypes(PA, blocked)).filter((t) => t === "block_added"),
    ).toHaveLength(1);
  });

  it("refuses an issue that would block itself", async () => {
    const n = await createIssue(PA, "ouroboros");
    const res = await block(PA, n, "blocked-by", `#${n}`);
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("block_self");
  });

  it("allows a longer cycle, which reads as both cards blocked", async () => {
    const a = await createIssue(PA, "cycle a");
    const b = await createIssue(PA, "cycle b");
    expect((await block(PA, a, "blocked-by", `#${b}`)).status).toBe(200);
    expect((await block(PA, b, "blocked-by", `#${a}`)).status).toBe(200);
    expect((await issue(PA, a)).blocked_by).toHaveLength(1);
    expect((await issue(PA, b)).blocked_by).toHaveLength(1);
  });

  it("resolves every spelling a ref may arrive in", async () => {
    const blocked = await createIssue(PA, "many spellings");
    const target = await createIssue(PB, "the target");
    const bare = await createIssue(PA, "local target");
    const projectId = (await issue(PB, target)).id; // unused id, see below
    expect(projectId).toBeGreaterThan(0);

    for (const ref of [`${PB}#${target}`, `${PB}/${target}`]) {
      const res = await block(PA, blocked, "blocked-by", ref);
      expect(res.status, ref).toBe(200);
    }
    // Both spellings named the same card, so there is still one edge.
    expect((await issue(PA, blocked)).blocked_by).toHaveLength(1);

    for (const ref of [`${bare}`, `#${bare}`]) {
      expect((await block(PA, blocked, "blocked-by", ref)).status, ref).toBe(
        200,
      );
    }
    expect((await issue(PA, blocked)).blocked_by).toHaveLength(2);

    // The stored-link form, which is what a body carries after resolution.
    const pbId = (
      await json(
        await t.app.request(`/api/projects/${PB}`, { headers: { cookie } }),
      )
    ).id;
    const second = await createIssue(PB, "second target");
    const res = await block(
      PA,
      blocked,
      "blocked-by",
      `/projects/${pbId}/issues/${second}`,
    );
    expect(res.status).toBe(200);
    expect((await issue(PA, blocked)).blocked_by).toHaveLength(3);
  });

  it("answers 404 for a ref pointing where the caller may not read", async () => {
    const mine = await createIssue(PA, "mine");
    const theirs = await createIssue(PC, "not bob's business");
    const res = await block(PA, mine, "blocked-by", `${PC}#${theirs}`, {
      ...bob.headers,
    });
    expect(res.status).toBe(404);
  });

  it("takes no new edge against a card in the trash", async () => {
    const mine = await createIssue(PA, "wants to wait");
    const gone = await createIssue(PA, "about to be binned");
    expect(
      (
        await t.app.request(`/api/projects/${PA}/issues/${gone}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    const res = await block(PA, mine, "blocked-by", `#${gone}`);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_not_referenceable");
  });

  it("needs a writer: a reporter is refused", async () => {
    const blocked = await createIssue(PA, "reporter tries");
    const blocker = await createIssue(PA, "reporter target");
    const res = await block(PA, blocked, "blocked-by", `#${blocker}`, {
      ...reporter.headers,
    });
    expect(res.status).toBe(403);
  });

  it("drops an edge only from the end and direction that owns it", async () => {
    const blocked = await createIssue(PA, "delete me blocked");
    const blocker = await createIssue(PA, "delete me blocker");
    const created = await json(
      await block(PA, blocked, "blocked-by", `#${blocker}`),
    );
    const edgeId = created.blocked_by[0].edge_id as number;

    // Right id, wrong direction on the same card.
    expect((await unblock(PA, blocked, "blocks", edgeId)).status).toBe(404);
    // Right direction, wrong card.
    expect((await unblock(PA, blocker, "blocked-by", edgeId)).status).toBe(404);
    // The blocker's own view of the same edge is the other direction.
    expect((await unblock(PA, blocker, "blocks", edgeId)).status).toBe(204);

    expect((await issue(PA, blocked)).blocked_by).toEqual([]);
    expect(await timelineTypes(PA, blocked)).toContain("block_removed");
  });

  it("keeps the fact and hides the name across a project the reader cannot see", async () => {
    const mine = await createIssue(PA, "blocked by a secret");
    const secret = await createIssue(PC, "the secret");
    expect(
      (await block(PA, mine, "blocked-by", `${PC}#${secret}`)).status,
    ).toBe(200);

    const asOwner = await issue(PA, mine);
    expect(asOwner.blocked_by[0]).toMatchObject({ hidden: false });
    expect(asOwner.blocked_by[0].number).toBe(secret);

    const asBob = await issue(PA, mine, bob.headers);
    expect(asBob.blocked_by).toHaveLength(1);
    expect(asBob.blocked_by[0]).toMatchObject({
      hidden: true,
      project_id: null,
      project: null,
      number: null,
      ref: null,
    });
    // The edge id is not a name: it stays, so the blocked card's owner can
    // still drop an edge they cannot see the far end of.
    expect(asBob.blocked_by[0].edge_id).toBeGreaterThan(0);

    // The timeline entry is masked the same way, row kept.
    const res = await t.app.request(
      `/api/projects/${PA}/issues/${mine}/timeline?limit=100`,
      { headers: bob.headers },
    );
    const added = (await json(res)).items.find(
      (i: { event_type?: string }) => i.event_type === "block_added",
    );
    expect(added.payload).toMatchObject({
      role: "blocked",
      other_project_id: null,
      other_number: null,
    });
    expect(added.payload.other_project).toBeNull();
  });

  it("names both ends and all four block events from the same visible project set", async () => {
    const directory = await json(
      await t.app.request("/api/projects", { headers: { cookie } }),
    );
    const otherId = directory.find((p: { slug: string }) => p.slug === PB).id;
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    expect((await setClearLine(PB, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "timeline waiting");
    const blocker = await createIssue(PB, "timeline prerequisite");
    const a = await json(
      await block(PA, blocked, "blocked-by", `${PB}#${blocker}`),
    );
    expect(a.blocked_by).toHaveLength(1);
    const edgeId = a.blocked_by[0].edge_id;

    await setStatus(PB, blocker, "Shipped");
    await setStatus(PB, blocker, "In Progress");
    const blockedEvents = await blockEvents(PA, blocked);
    expect(
      blockedEvents.map((e: { event_type: string }) => e.event_type),
    ).toEqual(["block_added", "block_cleared", "block_reblocked"]);
    for (const event of blockedEvents) {
      expect(event.payload).toMatchObject(
        event.event_type === "block_added"
          ? {
              edge_id: edgeId,
              role: "blocked",
              other_project: PB,
              other_project_id: otherId,
              other_number: blocker,
            }
          : {
              edge_id: edgeId,
              blocker_project: PB,
              blocker_project_id: otherId,
              blocker_number: blocker,
            },
      );
    }
    expect((await blockEvents(PB, blocker))[0].payload).toMatchObject({
      edge_id: edgeId,
      role: "blocker",
      other_project: PA,
      other_number: blocked,
    });

    expect((await unblock(PA, blocked, "blocked-by", edgeId)).status).toBe(204);
    expect((await blockEvents(PA, blocked)).at(-1).payload).toMatchObject({
      role: "blocked",
      other_project: PB,
      other_number: blocker,
    });
    expect((await blockEvents(PB, blocker)).at(-1).payload).toMatchObject({
      role: "blocker",
      other_project: PA,
      other_number: blocked,
    });
    expect((await setClearLine(PB, null)).status).toBe(200);
  });

  it("clears when the blocker reaches the closed category, with no line set", async () => {
    const blocked = await createIssue(PB, "waiting on closure");
    const blocker = await createIssue(PB, "closes");
    await block(PB, blocked, "blocked-by", `#${blocker}`);

    await setStatus(PB, blocker, "Shipped");
    expect((await issue(PB, blocked)).blocked_by[0].cleared_at).toBeNull();

    await setStatus(PB, blocker, "Done");
    const after = await issue(PB, blocked);
    expect(after.blocked_by[0].cleared_at).not.toBeNull();
    expect(await timelineTypes(PB, blocked)).toContain("block_cleared");
  });

  it("clears at the configured line, and re-blocks on the way back", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "waiting on shipped");
    const blocker = await createIssue(PA, "ships");
    await block(PA, blocked, "blocked-by", `#${blocker}`);

    await setStatus(PA, blocker, "Ready to Ship");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();

    await setStatus(PA, blocker, "Shipped");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
    expect(await timelineTypes(PA, blocked)).toContain("block_cleared");

    // Back below the line: the edge blocks again, and says so — somebody may
    // have started work on the strength of the first message.
    await setStatus(PA, blocker, "In Progress");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();
    expect(await timelineTypes(PA, blocked)).toContain("block_reblocked");
  });

  it("clears through a slash command too", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "waiting on a command");
    const blocker = await createIssue(PA, "moved by command");
    await block(PA, blocked, "blocked-by", `#${blocker}`);

    const res = await t.app.request(
      `/api/projects/${PA}/issues/${blocker}/commands`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          body: "shipping it",
          commands: [
            { type: "status", status_id: await statusNamed(PA, "Shipped") },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
  });

  it("re-decides every edge when the line moves", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "line moves under it");
    const blocker = await createIssue(PA, "sits in ready to ship");
    await block(PA, blocked, "blocked-by", `#${blocker}`);
    await setStatus(PA, blocker, "Ready to Ship");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();

    expect((await setClearLine(PA, "Ready to Ship")).status).toBe(200);
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();

    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();
  });

  it("re-decides every edge when statuses are reordered", async () => {
    expect((await setClearLine(PB, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PB, "reorder watcher");
    const blocker = await createIssue(PB, "sits in progress");
    await block(PB, blocked, "blocked-by", `#${blocker}`);
    await setStatus(PB, blocker, "In Progress");
    expect((await issue(PB, blocked)).blocked_by[0].cleared_at).toBeNull();

    // Drag Shipped to the front: "at this position or past it" now covers
    // every card in the project, this blocker included.
    const shipped = await statusNamed(PB, "Shipped");
    const res = await t.app.request(`/api/projects/${PB}/statuses/${shipped}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ position: -1 }),
    });
    expect(res.status).toBe(200);
    expect((await issue(PB, blocked)).blocked_by[0].cleared_at).not.toBeNull();

    // Put it back where it was so the rest of the suite reads normally.
    expect(
      (
        await t.app.request(`/api/projects/${PB}/statuses/${shipped}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ position: 5 }),
        })
      ).status,
    ).toBe(200);
    expect((await issue(PB, blocked)).blocked_by[0].cleared_at).toBeNull();
    await setClearLine(PB, null);
  });

  it("re-decides every edge when a status changes category", async () => {
    // A project of its own, with no clear line: the verdict is then the
    // category fallback, which every project starts on — a migration leaves
    // `block_clear_status_id` NULL everywhere.
    const slug = "block-category";
    expect(
      (
        await t.app.request("/api/projects", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug, name: "Category" }),
        })
      ).status,
    ).toBe(201);
    const blocked = await createIssue(slug, "waits on a category");
    const blocker = await createIssue(slug, "sits in next");
    await block(slug, blocked, "blocked-by", `#${blocker}`);
    await setStatus(slug, blocker, "Next");
    expect((await issue(slug, blocked)).blocked_by[0].cleared_at).toBeNull();

    const next = await statusNamed(slug, "Next");
    const res = await t.app.request(`/api/projects/${slug}/statuses/${next}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ category: "closed" }),
    });
    expect(res.status).toBe(200);
    expect(
      (await issue(slug, blocked)).blocked_by[0].cleared_at,
    ).not.toBeNull();
    expect(await timelineTypes(slug, blocked)).toContain("block_cleared");

    // And back: the fallback moves both ways.
    expect(
      (
        await t.app.request(`/api/projects/${slug}/statuses/${next}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ category: "open" }),
        })
      ).status,
    ).toBe(200);
    expect((await issue(slug, blocked)).blocked_by[0].cleared_at).toBeNull();
    expect(await timelineTypes(slug, blocked)).toContain("block_reblocked");
  });

  it("refuses to delete the status a project uses as its clear line", async () => {
    const res = await t.app.request(`/api/projects/${PA}/statuses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "Line", category: "open" }),
    });
    expect(res.status).toBe(201);
    const line = (await json(res)).id as number;
    expect(
      (
        await t.app.request(`/api/projects/${PA}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ block_clear_status_id: line }),
        })
      ).status,
    ).toBe(200);

    const refused = await t.app.request(
      `/api/projects/${PA}/statuses/${line}`,
      { method: "DELETE", headers: headers() },
    );
    expect(refused.status).toBe(409);

    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    expect(
      (
        await t.app.request(`/api/projects/${PA}/statuses/${line}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
  });

  it("refuses a clear line that is not this project's status", async () => {
    const foreign = await statusNamed(PB, "Shipped");
    const res = await t.app.request(`/api/projects/${PA}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ block_clear_status_id: foreign }),
    });
    expect(res.status).toBe(422);
  });

  it("suspends rather than clears when the blocker goes to the trash", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "blocker gets binned");
    const blocker = await createIssue(PA, "gets binned");
    await block(PA, blocked, "blocked-by", `#${blocker}`);

    expect(
      (
        await t.app.request(`/api/projects/${PA}/issues/${blocker}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    const held = (await issue(PA, blocked)).blocked_by[0];
    expect(held.cleared_at).toBeNull();
    expect(held.blocker_deleted).toBe(true);
    expect(await timelineTypes(PA, blocked)).not.toContain("block_cleared");

    expect(
      (
        await t.app.request(`/api/projects/${PA}/issues/${blocker}/restore`, {
          method: "POST",
          headers: headers(),
        })
      ).status,
    ).toBe(200);
    expect((await issue(PA, blocked)).blocked_by[0].blocker_deleted).toBe(
      false,
    );
  });

  it("filters the list by blocked, across every page", async () => {
    const slug = "block-pages";
    expect(
      (
        await t.app.request("/api/projects", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug, name: "Block pages" }),
        })
      ).status,
    ).toBe(201);
    const blocker = await createIssue(slug, "the one everybody waits for");
    const blocked: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = await createIssue(slug, `waiting ${i}`);
      // Every other card is blocked, so neither answer is the whole project.
      if (i % 2 === 0) {
        expect((await block(slug, n, "blocked-by", `#${blocker}`)).status).toBe(
          200,
        );
        blocked.push(n);
      }
    }

    const walk = async (qs: string): Promise<number[]> => {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url = `/api/projects/${slug}/issues?limit=2&${qs}${
          cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
        }`;
        const res: Response = await t.app.request(url, { headers: { cookie } });
        expect(res.status).toBe(200);
        const body = await json(res);
        seen.push(...body.items.map((i: { number: number }) => i.number));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }
      return seen;
    };

    const onlyBlocked = await walk("blocked=1");
    expect(new Set(onlyBlocked)).toEqual(new Set(blocked));
    expect(onlyBlocked).toHaveLength(blocked.length);

    const unblocked = await walk("blocked=0");
    expect(unblocked).not.toHaveLength(0);
    expect(unblocked.some((n) => blocked.includes(n))).toBe(false);
    expect(new Set([...onlyBlocked, ...unblocked]).size).toBe(
      onlyBlocked.length + unblocked.length,
    );

    // A cleared edge is not a block any more: the card rejoins the other side.
    await setStatus(slug, blocker, "Done");
    const afterClearing = await walk("blocked=1");
    expect(afterClearing).toEqual([]);
  });

  it("repairs a drifted verdict and sends the clearing nobody was told about", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "repair target");
    const blocker = await createIssue(PA, "repair blocker");
    await block(PA, blocked, "blocked-by", `#${blocker}`);
    await setStatus(PA, blocker, "Shipped");
    const edgeId = (await issue(PA, blocked)).blocked_by[0].edge_id as number;

    // Damage the row on purpose, both halves of the pair: a verdict that
    // disagrees with the blocker's status, and a clearing nobody was told
    // about. A check nobody has watched fail is a check nobody has tested.
    const system = t.ctx.router.system();
    await system
      .update(issueBlocks)
      .set({ clearedAt: null, clearedNotifiedAt: null })
      .where(eq(issueBlocks.id, edgeId));
    const before = await issue(PA, blocked);
    expect(
      before.blocked_by[0].cleared_at,
      "nothing but the sweep may repair this",
    ).toBeNull();

    const result = await repairBlocks(t.ctx);
    expect(result.recomputed).toBeGreaterThan(0);
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
    const rows = await system
      .select()
      .from(issueBlocks)
      .where(eq(issueBlocks.id, edgeId));
    expect(rows[0]?.clearedNotifiedAt).not.toBeNull();
    expect(
      (await timelineTypes(PA, blocked)).filter((t) => t === "block_cleared"),
    ).toHaveLength(2);
  });

  it("re-sends a clearing whose announcement never landed", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "never heard");
    const blocker = await createIssue(PA, "quietly shipped");
    await block(PA, blocked, "blocked-by", `#${blocker}`);
    await setStatus(PA, blocker, "Shipped");
    const edgeId = (await issue(PA, blocked)).blocked_by[0].edge_id as number;

    // The verdict stands; only the announcement was lost. This is the state
    // the two columns exist to make findable.
    await t.ctx.router
      .system()
      .update(issueBlocks)
      .set({ clearedNotifiedAt: null })
      .where(eq(issueBlocks.id, edgeId));

    const result = await repairBlocks(t.ctx);
    expect(result.announced).toBeGreaterThan(0);
    expect(
      (await timelineTypes(PA, blocked)).filter((t) => t === "block_cleared"),
    ).toHaveLength(2);
  });

  it("carries edges along when the card moves to another project", async () => {
    const blocked = await createIssue(PA, "moves away");
    const blocker = await createIssue(PA, "stays put");
    await block(PA, blocked, "blocked-by", `#${blocker}`);

    const res = await t.app.request(
      `/api/projects/${PA}/issues/${blocked}/move`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ to_project: PB }),
      },
    );
    expect(res.status).toBe(200);
    const landed = (await json(res)).moved_to.number as number;

    const moved = await issue(PB, landed);
    expect(moved.blocked_by).toHaveLength(1);
    expect(moved.blocked_by[0].number).toBe(blocker);
    // And the far end now points at the new address.
    expect((await issue(PA, blocker)).blocks[0]).toMatchObject({
      project: PB,
      number: landed,
    });
  });

  it("takes its edges with it when the project is deleted", async () => {
    const slug = "block-doomed";
    expect(
      (
        await t.app.request("/api/projects", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug, name: "Doomed" }),
        })
      ).status,
    ).toBe(201);
    const mine = await createIssue(PA, "outlives the other project");
    const doomed = await createIssue(slug, "goes with its project");
    expect(
      (await block(PA, mine, "blocked-by", `${slug}#${doomed}`)).status,
    ).toBe(200);
    expect((await issue(PA, mine)).blocked_by).toHaveLength(1);

    expect(
      (
        await t.app.request(`/api/projects/${slug}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    expect((await issue(PA, mine)).blocked_by).toEqual([]);
  });

  it("reaches an inbox that has weak unread turned off", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    // Bob is the reader; the owner does the blocking and the shipping, so
    // every entry below is somebody else's.
    const inboxOf = async (): Promise<number[]> => {
      const res = await t.app.request("/api/me/inbox", {
        headers: bob.headers,
      });
      expect(res.status).toBe(200);
      return (await json(res)).items.map((i: { number: number }) => i.number);
    };
    const prefs = async (weak: boolean) => {
      const res = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ show_weak_unread: weak }),
      });
      expect(res.status).toBe(200);
    };
    const readIt = async (number: number) => {
      await settle();
      const res = await t.app.request(
        `/api/projects/${PA}/issues/${number}/read`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", ...bob.headers },
          body: "{}",
        },
      );
      expect(res.status).toBe(204);
      await settle();
    };

    // Mints Bob's frontiers: everything above this point is already read.
    await inboxOf();
    await prefs(false);
    await settle();

    const blocked = await createIssue(PA, "bob's blocked card");
    const blocker = await createIssue(PA, "bob's blocker");
    await block(PA, blocked, "blocked-by", `#${blocker}`);
    // Somebody else opened the card, which is strong unread on its own
    // (T-151) — reading it clears the field so the next assertion is about
    // the block events and nothing else.
    await readIt(blocked);
    expect(await inboxOf()).not.toContain(blocked);

    await setStatus(PA, blocker, "Shipped");
    await settle();
    expect(await inboxOf()).toContain(blocked);

    // And the bad news stays weak: re-blocking is not an action signal.
    await readIt(blocked);
    expect(await inboxOf()).not.toContain(blocked);
    await setStatus(PA, blocker, "In Progress");
    await settle();
    expect(await inboxOf()).not.toContain(blocked);

    await prefs(true);
    expect(await inboxOf()).toContain(blocked);
  });

  it("keeps a muted card quiet even when its blocker clears", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "muted and blocked");
    const blocker = await createIssue(PA, "clears for a muted card");
    await block(PA, blocked, "blocked-by", `#${blocker}`);
    const res = await t.app.request(
      `/api/projects/${PA}/issues/${blocked}/mute`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ mode: "forever" }),
      },
    );
    expect(res.status).toBe(204);
    await setStatus(PA, blocker, "Shipped");
    await settle();

    const page = await json(
      await t.app.request("/api/me/inbox", { headers: bob.headers }),
    );
    expect(page.items.map((i: { number: number }) => i.number)).not.toContain(
      blocked,
    );
  });

  it("holds an edge declared against an already-shipped card as cleared", async () => {
    expect((await setClearLine(PA, "Shipped")).status).toBe(200);
    const blocked = await createIssue(PA, "late to the party");
    const blocker = await createIssue(PA, "already done");
    await setStatus(PA, blocker, "Shipped");

    const body = await json(
      await block(PA, blocked, "blocked-by", `#${blocker}`),
    );
    expect(body.blocked_by[0].cleared_at).not.toBeNull();
    // Nothing cleared just now, so nobody is owed the news — and the repair
    // sweep must not decide otherwise later.
    expect(await timelineTypes(PA, blocked)).not.toContain("block_cleared");
    await repairBlocks(t.ctx);
    expect(await timelineTypes(PA, blocked)).not.toContain("block_cleared");
  });

  it("sorts the unresolved ones first", async () => {
    const blocked = await createIssue(PB, "sorting");
    const first = await createIssue(PB, "sorts a");
    const second = await createIssue(PB, "sorts b");
    await block(PB, blocked, "blocked-by", `#${first}`);
    await block(PB, blocked, "blocked-by", `#${second}`);
    await setStatus(PB, first, "Done");

    const rows = (await issue(PB, blocked)).blocked_by;
    expect(rows.map((r: { number: number }) => r.number)).toEqual([
      second,
      first,
    ]);
  });

  it("carries both directions on a list row as well", async () => {
    const blocked = await createIssue(PB, "list row blocked");
    const blocker = await createIssue(PB, "list row blocker");
    await block(PB, blocked, "blocked-by", `#${blocker}`);
    const res = await t.app.request(
      `/api/projects/${PB}/issues?numbers=${blocked},${blocker}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const items = (await json(res)).items as {
      number: number;
      blocked_by: unknown[];
      blocks: unknown[];
    }[];
    expect(items.find((i) => i.number === blocked)?.blocked_by).toHaveLength(1);
    expect(items.find((i) => i.number === blocker)?.blocks).toHaveLength(1);
  });

  it("leaves an edge alone when the far end is only queried", async () => {
    // A guard against the WHERE in blocksForIssues matching by number alone:
    // two projects in one database hold the same numbers.
    const a = await createIssue(PA, "same number, other project");
    const b = await createIssue(PB, "same number here");
    await block(PA, a, "blocked-by", `#${await createIssue(PA, "x")}`);
    const rows = await t.ctx.router
      .system()
      .select()
      .from(issueBlocks)
      .where(
        and(
          eq(issueBlocks.blockedNumber, a),
          eq(issueBlocks.blockedProjectId, 0),
        ),
      );
    expect(rows).toEqual([]);
    expect((await issue(PB, b)).blocked_by).toEqual([]);
  });
});
