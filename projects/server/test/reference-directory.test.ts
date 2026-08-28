import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refPrefixes } from "../src/db/system-schema.ts";
import { syncRefPrefixMirror } from "../src/services/reference-directory.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

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

  it("seeds a cutoff the migration recorded", async () => {
    const page = await directory();
    expect(typeof page.since).toBe("string");
    expect(Number.isNaN(Date.parse(page.since))).toBe(false);
  });

  it("mirrors a format change as it is written", async () => {
    expect(await putFormat(PA, "AA")).toMatchObject({ status: 200 });
    const page = await directory();
    expect(holdsOf(page, "AA")).toEqual([
      { prefix: "AA", slug: PA, from: expect.any(String), to: null },
    ]);
  });

  it("closes a hold on handover and reopens the next one", async () => {
    await settle();
    expect(await putFormat(PA, "BB")).toMatchObject({ status: 200 });
    const page = await directory();
    const [aa] = holdsOf(page, "AA");
    const [bb] = holdsOf(page, "BB");
    expect(aa.to).toBe(bb.from);
    expect(bb.to).toBeNull();
  });

  it("releases a prefix entirely when the format goes back to #", async () => {
    await settle();
    expect(await putFormat(PA, null)).toMatchObject({ status: 200 });
    const page = await directory();
    const [bb] = holdsOf(page, "BB");
    expect(bb.to).not.toBeNull();
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
    const mine = await directory(bob.headers);
    expect(mine.entries.every((e: Entry) => e.slug === PA)).toBe(true);
    expect(
      mine.contested.some((c: { prefix: string }) => c.prefix === "XX"),
    ).toBe(true);
  });

  it("re-copies missing mirror rows and stays idempotent", async () => {
    const system = t.ctx.router.system();
    const before = await system.select().from(refPrefixes);
    const victim = before.find((row) => row.prefix === "XX");
    if (!victim) throw new Error("expected a mirrored XX row");
    await system.delete(refPrefixes).where(eq(refPrefixes.id, victim.id));

    expect(await syncRefPrefixMirror(t.ctx)).toBe(1);
    expect(await syncRefPrefixMirror(t.ctx)).toBe(0);
    const after = await system.select().from(refPrefixes);
    expect(after).toHaveLength(before.length);
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
});
