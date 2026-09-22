import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refPrefixes } from "../src/db/system-schema.ts";
import { syncRefPrefixMirror } from "../src/services/reference-directory.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** ref_formats.effective_from is now(); keep switches apart so the
 *  holding intervals they bound are strictly ordered. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const PA = "dir-a";
const PB = "dir-b";
const PC = "dir-c";

describe("reference prefix directory T-150", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  const putFormat = (slug: string, prefix: string | null) =>
    t.app.request(`/api/projects/${slug}/references/format`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ prefix }),
    });

  const directory = async (who?: Record<string, string>) => {
    const res = await t.app.request("/api/me/reference-directory", {
      headers: who ?? { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  type Entry = {
    prefix: string;
    slug: string;
    from: string;
    to: string | null;
  };
  const holdsOf = (page: { entries: Entry[] }, p: string): Entry[] =>
    page.entries.filter((e) => e.prefix === p);

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [PA, PB, PC]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: `Directory ${slug}` }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "dir-bob");
    const res = await t.app.request(
      `/api/projects/${PA}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("reports no cutoff, the grammar no longer having one (T-260)", async () => {
    expect(await directory()).not.toHaveProperty("since");
  });

  it("mirrors a format change as it is written", async () => {
    expect(await putFormat(PA, "AA")).toMatchObject({ status: 200 });
    const page = await directory();
    expect(holdsOf(page, "AA")).toEqual([
      { prefix: "AA", slug: PA, from: expect.any(String), to: null },
    ]);
  });

  it("hands the prefix over instead of holding both", async () => {
    const [before] = holdsOf(await directory(), "AA");
    await settle();
    expect(await putFormat(PA, "BB")).toMatchObject({ status: 200 });
    const page = await directory();
    expect(holdsOf(page, "AA")).toEqual([]);
    expect(holdsOf(page, "BB")).toEqual([
      { prefix: "BB", slug: PA, from: expect.any(String), to: null },
    ]);
    // The new hold starts at the switch, not at the project's creation: the
    // old shape proved that by matching the closed hold's end, and nothing
    // else here would notice a `from` copied off the first row.
    const [bb] = holdsOf(page, "BB");
    expect(Date.parse(bb.from)).toBeGreaterThan(Date.parse(before.from));
  });

  it("releases a prefix entirely when the format goes back to #", async () => {
    await settle();
    expect(await putFormat(PA, null)).toMatchObject({ status: 200 });
    const page = await directory();
    // A newest row of NULL means the project holds nothing, rather than
    // falling back to the last prefix it did hold.
    expect(holdsOf(page, "BB")).toEqual([]);
    expect(holdsOf(page, "#")).toEqual([]);
  });

  it("reports an overlap as contested without naming a holder", async () => {
    await settle();
    expect(await putFormat(PB, "XX")).toMatchObject({ status: 200 });
    await settle();
    expect(await putFormat(PC, "XX")).toMatchObject({ status: 200 });

    const page = await directory();
    const contested = page.contested.filter(
      (c: { prefix: string }) => c.prefix === "XX",
    );
    expect(contested).toHaveLength(1);
    expect(contested[0].to).toBeNull();
    expect(contested[0]).not.toHaveProperty("slug");
    // The overlap opens when the SECOND holder claims it, not before.
    const [pc] = holdsOf(page, "XX").filter((e) => e.slug === PC);
    expect(contested[0].from).toBe(pc.from);
  });

  it("trims entries to the viewer's projects but keeps every contested window", async () => {
    // PA gave its prefix up two cases ago, so the viewer's slice would be
    // empty and every assertion over it vacuously true. Give it one back.
    await settle();
    expect(await putFormat(PA, "A2")).toMatchObject({ status: 200 });

    const mine = await directory(bob.headers);
    // The whole array rather than a predicate over it: bob reads PA alone, so
    // this also says PB's and PC's XX entries were trimmed away.
    expect(mine.entries).toEqual([
      { prefix: "A2", slug: PA, from: expect.any(String), to: null },
    ]);
    expect(
      mine.contested.some((c: { prefix: string }) => c.prefix === "XX"),
    ).toBe(true);
  });

  it("leaves a colocated mirror alone — the write path cannot leave a gap", async () => {
    const log = await countStatements(t, async () => {
      // Regression watchdog: green on the parent commit too, where there was
      // simply nothing to repair.
      expect(await syncRefPrefixMirror(t.ctx)).toBe(0);
    });
    // This one is the card's criterion: the sweep used to spend 1 + 2N
    // statements to find that out. The repair case that needs a real gap
    // lives in ref-mirror-placements.test.ts, which can afford to keep the
    // gap: it does not share an app with the directory cases below.
    expect(log.total).toBe(1);
    expect(Object.keys(log.byUrl)).toEqual([t.ctx.router.systemHandle().url]);
  });

  // A prefix chosen at creation (T-148) has to reach the directory by the
  // same route a settings change does, or bare PREFIX-N would not resolve.
  it("mirrors a prefix taken at creation as a hold open since created_at", async () => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug: "dir-d",
        name: "Directory dir-d",
        ref_prefix: "DD",
      }),
    });
    expect(res.status).toBe(201);
    const project = await json(res);

    const page = await directory();
    expect(holdsOf(page, "DD")).toEqual([
      { prefix: "DD", slug: "dir-d", from: project.created_at, to: null },
    ]);
  });

  it("contests an already-held prefix when a new project is created on it", async () => {
    const before = await directory();
    const held = holdsOf(before, "XX").map(
      (e) => `${e.slug}:${e.from}:${e.to}`,
    );

    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug: "dir-e",
        name: "Directory dir-e",
        ref_prefix: "XX",
      }),
    });
    expect(res.status).toBe(201);

    const page = await directory();
    // The existing holders keep their intervals — a new claim overlaps
    // them, it does not close them.
    expect(
      holdsOf(page, "XX")
        .filter((e) => e.slug !== "dir-e")
        .map((e) => `${e.slug}:${e.from}:${e.to}`),
    ).toEqual(held);
    const contested = page.contested.filter(
      (c: { prefix: string }) => c.prefix === "XX",
    );
    expect(contested).toHaveLength(1);
    expect(contested[0].to).toBeNull();
  });

  it("refuses an autolink prefix that shadows a project's qualified form", async () => {
    const res = await t.app.request(
      `/api/projects/${PA}/references/autolinks`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          prefix: `${PB}#`,
          url_template: "https://tracker.example/<num>",
        }),
      },
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain(PB);

    // A slug that does not exist is nobody's reference form.
    const ok = await t.app.request(`/api/projects/${PA}/references/autolinks`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prefix: "no-such-project#",
        url_template: "https://tracker.example/<num>",
      }),
    });
    expect(ok.status).toBe(201);
  });

  /** A project of this case's own, so the rows it plants contest nothing. */
  const newProject = async (slug: string): Promise<{ id: number }> => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: `Directory ${slug}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  it("breaks a same-instant tie by the mirror's own row order", async () => {
    // Regression watchdog: green before this card too. Its job is to turn a
    // tie-break that used to ride on whatever order the database returned
    // into a written-down contract. A past instant keeps the two rows from
    // losing to prefixes the cases above took at test-run time.
    const project = await newProject("dir-t");
    const effectiveFrom = new Date("2024-01-02T03:04:05.000Z");
    for (const prefix of ["T1", "T2"]) {
      await t.ctx.router
        .system()
        .insert(refPrefixes)
        .values({ projectId: project.id, prefix, effectiveFrom });
    }

    const page = await directory();
    expect(page.entries.filter((e: Entry) => e.slug === "dir-t")).toEqual([
      { prefix: "T2", slug: "dir-t", from: expect.any(String), to: null },
    ]);
  });

  it("keeps the directory the same size as a project's history grows", async () => {
    const project = await newProject("dir-g");
    const sizes = async (): Promise<{ entries: number; bytes: number }> => {
      const page = await directory();
      return {
        entries: page.entries.filter((e: Entry) => e.slug === "dir-g").length,
        // Equal-length prefixes and a 24-character ISO timestamp are what
        // make a byte count comparable at all; no other project is written
        // to between the two reads, so their share is constant.
        bytes: JSON.stringify(page).length,
      };
    };
    const takeFour = async (from: number) => {
      for (let i = from; i < from + 4; i++) {
        await settle();
        expect(await putFormat("dir-g", `G${i}`)).toMatchObject({
          status: 200,
        });
      }
    };

    await takeFour(1);
    const first = await sizes();
    await takeFour(5);
    const second = await sizes();

    expect(second.entries).toBe(first.entries);
    expect(second.bytes).toBe(first.bytes);

    // The history itself is untouched: the directory stops reading all of it,
    // nothing trims it. A project created without a prefix inserts no row of
    // its own, so eight switches are eight rows.
    const rows = await t.ctx.router
      .system()
      .select({ id: refPrefixes.id })
      .from(refPrefixes)
      .where(eq(refPrefixes.projectId, project.id));
    expect(rows).toHaveLength(8);
  });
});
