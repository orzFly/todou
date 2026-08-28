import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userPrefs } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Every key at its schema default — the board's is the odd one out (T-157). */
const DEFAULTS = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
};

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
  /** Overwrite the stored blob wholesale, as an older or newer build would. */
  const storeBlob = async (prefs: Record<string, unknown>) => {
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    await t.ctx.router
      .system()
      .update(userPrefs)
      .set({ prefs })
      .where(eq(userPrefs.userId, me.id));
  };

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
    expect(await json(res)).toEqual(DEFAULTS);

    const rows = await t.ctx.router.system().select().from(userPrefs);
    expect(rows).toHaveLength(0);
  });

  it("PATCH creates the row and returns the full prefs", async () => {
    const res = await patchPrefs({ show_weak_unread: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ...DEFAULTS,
      show_weak_unread: false,
    });

    const after = await json(await getPrefs());
    expect(after).toEqual({ ...DEFAULTS, show_weak_unread: false });
  });

  it("a second PATCH shallow-merges into the stored blob", async () => {
    await patchPrefs({ show_weak_unread: false });
    const res = await patchPrefs({});
    expect(res.status).toBe(200);
    // The empty patch must not clobber the previously stored key.
    expect(await json(res)).toEqual({ ...DEFAULTS, show_weak_unread: false });

    const back = await patchPrefs({ show_weak_unread: true });
    expect(await json(back)).toEqual(DEFAULTS);
  });

  it("stores one surface's placement without touching the others (T-157)", async () => {
    const res = await patchPrefs({ ref_placement_board: "before" });
    expect(res.status).toBe(200);
    // The neighbouring keys were never patched and keep their own defaults.
    expect(await json(res)).toEqual({
      ...DEFAULTS,
      ref_placement_board: "before",
    });

    expect(await json(await getPrefs())).toEqual({
      ...DEFAULTS,
      ref_placement_board: "before",
    });

    const second = await patchPrefs({ ref_placement_list: "after" });
    expect(await json(second)).toEqual({
      ...DEFAULTS,
      ref_placement_board: "before",
      ref_placement_list: "after",
    });

    const back = await patchPrefs({
      ref_placement_board: "own_line",
      ref_placement_list: "before",
    });
    expect(await json(back)).toEqual(DEFAULTS);
  });

  it("rejects unknown keys with the offending path named", async () => {
    const res = await patchPrefs({ show_weak_unread: true, potato: 1 });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("potato");
  });

  it("rejects the retired global ref_before_title key (T-157)", async () => {
    const res = await patchPrefs({ ref_before_title: false });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain("ref_before_title");
  });

  it("rejects a placement outside the surface's own enum", async () => {
    expect((await patchPrefs({ ref_placement_board: "sideways" })).status).toBe(
      422,
    );
    // `own_line` exists, but only on the board.
    expect((await patchPrefs({ ref_placement_list: "own_line" })).status).toBe(
      422,
    );
  });

  it("tolerates stored keys this build does not know", async () => {
    // A newer server wrote an extra key and T-153's retired one lingers.
    await storeBlob({
      show_weak_unread: false,
      from_the_future: true,
      ref_before_title: false,
    });

    const res = await getPrefs();
    expect(res.status).toBe(200);
    // ref_before_title is ignored rather than inherited: T-157 resets every
    // surface to its new default.
    expect(await json(res)).toEqual({ ...DEFAULTS, show_weak_unread: false });
  });

  it("falls back to the default for a stored placement it cannot read", async () => {
    await storeBlob({ ref_placement_board: "sideways", ref_placement_list: 7 });

    const res = await getPrefs();
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(DEFAULTS);
  });

  it("fills every key from an empty stored blob", async () => {
    await storeBlob({});

    expect(await json(await getPrefs())).toEqual(DEFAULTS);
  });

  it("keeps accounts separate", async () => {
    const other = await addUserWithToken(t.ctx, "prefs-neighbor");
    await patchPrefs({ ref_placement_detail: "after" });

    const res = await getPrefs(other.headers);
    expect(res.status).toBe(200);
    // The main account just set one surface; the neighbor still sees defaults.
    expect(await json(res)).toEqual(DEFAULTS);
  });
});
