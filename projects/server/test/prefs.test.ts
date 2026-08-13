import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userPrefs } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("user preferences", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });
  const getPrefs = (extra?: Record<string, string>) =>
    t.app.request("/api/me/prefs", { headers: extra ?? { cookie } });
  const patchPrefs = (
    body: Record<string, unknown>,
    extra?: Record<string, string>,
  ) =>
    t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: extra ?? headers(),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("returns defaults without creating a row", async () => {
    const res = await getPrefs();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ show_weak_unread: true });

    const rows = await t.ctx.router.system().select().from(userPrefs);
    expect(rows).toHaveLength(0);
  });

  it("PATCH creates the row and returns the full prefs", async () => {
    const res = await patchPrefs({ show_weak_unread: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ show_weak_unread: false });

    const after = await json(await getPrefs());
    expect(after).toEqual({ show_weak_unread: false });
  });

  it("a second PATCH shallow-merges into the stored blob", async () => {
    await patchPrefs({ show_weak_unread: false });
    const res = await patchPrefs({});
    expect(res.status).toBe(200);
    // The empty patch must not clobber the previously stored key.
    expect(await json(res)).toEqual({ show_weak_unread: false });

    const back = await patchPrefs({ show_weak_unread: true });
    expect(await json(back)).toEqual({ show_weak_unread: true });
  });

  it("rejects unknown keys with the offending path named", async () => {
    const res = await patchPrefs({ show_weak_unread: true, potato: 1 });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("potato");
  });

  it("tolerates stored keys this build does not know", async () => {
    // Simulate a newer server having written an extra key, then rolled back.
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const system = t.ctx.router.system();
    await system
      .update(userPrefs)
      .set({ prefs: { show_weak_unread: false, from_the_future: true } })
      .where(eq(userPrefs.userId, me.id));

    const res = await getPrefs();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ show_weak_unread: false });
  });

  it("keeps accounts separate", async () => {
    const other = await addUserWithToken(t.ctx, "prefs-neighbor");
    const res = await getPrefs(other.headers);
    expect(res.status).toBe(200);
    // The main account set false above; the neighbor still sees defaults.
    expect(await json(res)).toEqual({ show_weak_unread: true });
  });
});
