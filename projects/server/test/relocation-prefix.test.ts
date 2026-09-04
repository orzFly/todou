import { MovedError, TodouClient } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";
import { prefixMount } from "./prefix-mount.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The whole relocation chain at once: a real move, the app's own 301, a
 * proxy putting the mount prefix back on the `Location`, `fetch` resolving
 * it, and the real client reading the new address back off the final URL.
 *
 * Every other test of this behaviour asserts against a `Location` or a final
 * URL somebody wrote by hand. This one is the only place that shows the
 * hand-written URL is where a client actually lands, which is what T-246
 * turned out to hinge on.
 */
describe.each(PLACEMENTS)("relocation behind a proxy (%s)", (placement) => {
  let t: TestApp;
  let token = "";
  const A = `rp-a-${placement}`;
  const B = `rp-b-${placement}`;
  let from = { number: 0 };
  let to = { number: 0 };

  beforeAll(async () => {
    t = await makeTestApp(placement);
    const cookie = await t.login();
    const admin = { cookie, "content-type": "application/json" };
    for (const slug of [A, B]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }

    const author = await addUserWithToken(t.ctx, `rp-author-${placement}`);
    token = author.headers.authorization.replace(/^Bearer /, "");
    // The 301 is only offered to a reader who can see the destination; a
    // member of A alone gets a 410 and never exercises the follow.
    for (const slug of [A, B]) {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${author.user.id}`,
        {
          method: "PUT",
          headers: admin,
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    }

    const created = await t.app.request(`/api/projects/${A}/issues`, {
      method: "POST",
      headers: { ...author.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "moved behind a proxy" }),
    });
    expect(created.status).toBe(201);
    from = (await json(created)) as { number: number };

    const move = await t.app.request(
      `/api/projects/${A}/issues/${from.number}/move`,
      {
        method: "POST",
        headers: { ...author.headers, "content-type": "application/json" },
        body: JSON.stringify({ to_project: B }),
      },
    );
    expect(move.status).toBe(200);
    to = ((await json(move)) as { moved_to: { number: number } }).moved_to;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe.each([
    ["under a path prefix", "http://gw.test/todou", "/todou"],
    ["at the origin root", "http://gw.test", ""],
  ])("mounted %s", (_name, baseUrl, mount) => {
    const client = () =>
      new TodouClient({ baseUrl, token, fetch: prefixMount(t.app, mount) });

    it("hands the new address to the client", async () => {
      const error = await client()
        .getIssue(A, from.number)
        .catch((e: unknown) => e);
      // Assert the throw before the address: reading `movedTo` off a
      // resolved issue yields undefined, and the silent-success failure
      // mode this test exists for would pass on `toEqual(undefined)`.
      expect(error).toBeInstanceOf(MovedError);
      expect((error as MovedError).movedTo).toEqual({
        slug: B,
        number: to.number,
      });
    });

    it("hands it over from a sub-route as well", async () => {
      const error = await client()
        .getTimeline(A, from.number, {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MovedError);
      expect((error as MovedError).movedTo).toEqual({
        slug: B,
        number: to.number,
      });
    });
  });

  it("answers a request that leaves the mount point the way the proxy does", async () => {
    const res = await prefixMount(
      t.app,
      "/todou",
    )(`http://gw.test/api/projects/${B}/issues/${to.number}`);
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({
      error: { code: "no_service", message: expect.any(String) },
    });
  });
});
