import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps in the DB carry µs; keep test actions >1ms apart so the
 *  ms-precision `now()` default of PUT read can never tie with them. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe.each(PLACEMENTS)(
  "unread read-state #46 (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let slug: string;
    let bob: Awaited<ReturnType<typeof addUserWithToken>>;
    const headers = () => ({ "content-type": "application/json", cookie });

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      slug = `reads-${placement.replaceAll(/[^a-z]/g, "")}`;
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: "Reads" }),
      });
      expect(res.status).toBe(201);
      bob = await addUserWithToken(t.ctx, `bob-${placement}`);
      const member = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
    });

    afterAll(async () => {
      await t.cleanup();
    });

    async function createIssue(title: string): Promise<{ number: number }> {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return json(res);
    }

    async function comment(
      number: number,
      who: Record<string, string>,
      body: string,
    ): Promise<Response> {
      return t.app.request(`/api/projects/${slug}/issues/${number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ body }),
      });
    }

    /** unread flag of one issue as seen by the cookie user's list call. */
    async function unreadOf(number: number): Promise<boolean> {
      const res = await t.app.request(
        `/api/projects/${slug}/issues?numbers=${number}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const page = await json(res);
      expect(page.items).toHaveLength(1);
      expect(typeof page.items[0].unread).toBe("boolean");
      return page.items[0].unread;
    }

    async function markRead(
      number: number,
      body: unknown = {},
    ): Promise<Response> {
      return t.app.request(`/api/projects/${slug}/issues/${number}/read`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      });
    }

    it("bootstraps quietly: history before the first list is read", async () => {
      const issue = await createIssue("ancient history");
      await comment(issue.number, bob.headers, "before bootstrap");
      await settle();
      // First-ever list call by the cookie user creates the frontier at now,
      // so bob's earlier comment never lights up.
      expect(await unreadOf(issue.number)).toBe(false);
    });

    it("lights on foreign activity, never on my own", async () => {
      const mine = await createIssue("mine, untouched");
      // My own `opened` event and comment stay read.
      await comment(mine.number, { cookie }, "talking to myself");
      expect(await unreadOf(mine.number)).toBe(false);

      const active = await createIssue("bob will speak");
      await comment(active.number, bob.headers, "hello from bob");
      expect(await unreadOf(active.number)).toBe(true);
      // My own follow-up neither clears nor re-lights.
      await comment(active.number, { cookie }, "replying without viewing");
      expect(await unreadOf(active.number)).toBe(true);
    });

    it("PUT read clears, events re-light, and reads never regress", async () => {
      const issue = await createIssue("read lifecycle");
      await comment(issue.number, bob.headers, "unread me");
      expect(await unreadOf(issue.number)).toBe(true);

      await settle();
      const cleared = await markRead(issue.number);
      expect(cleared.status).toBe(204);
      expect(await unreadOf(issue.number)).toBe(false);

      // A non-comment foreign action (status change event) re-lights.
      await settle();
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: { cookie },
        }),
      );
      const other = statuses.find((s: { name: string }) => s.name !== "Todo");
      const moved = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ status_id: other.id }),
        },
      );
      expect(moved.status).toBe(200);
      expect(await unreadOf(issue.number)).toBe(true);

      // Clear again, then try to regress with an ancient up_to: still read.
      await settle();
      expect((await markRead(issue.number)).status).toBe(204);
      expect(await unreadOf(issue.number)).toBe(false);
      const regress = await markRead(issue.number, {
        up_to: "2000-01-01T00:00:00Z",
      });
      expect(regress.status).toBe(204);
      expect(await unreadOf(issue.number)).toBe(false);
    });

    it("self-heals when the only foreign activity is deleted", async () => {
      const issue = await createIssue("deletable noise");
      const posted = await comment(issue.number, bob.headers, "oops");
      expect(posted.status).toBe(201);
      const { id } = await json(posted);
      expect(await unreadOf(issue.number)).toBe(true);

      const deleted = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/${id}`,
        { method: "DELETE", headers: bob.headers },
      );
      expect(deleted.status).toBe(204);
      expect(await unreadOf(issue.number)).toBe(false);
    });

    it("validates the body and 404s unknown issues", async () => {
      const missing = await markRead(99999);
      expect(missing.status).toBe(404);

      const issue = await createIssue("validation target");
      const badTime = await markRead(issue.number, { up_to: "yesterday" });
      expect(badTime.status).toBe(422);
      const extraField = await markRead(issue.number, { up_too: "typo" });
      expect(extraField.status).toBe(422);
    });
  },
);
