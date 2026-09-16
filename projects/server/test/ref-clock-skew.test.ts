/**
 * Asking "which prefix is in force" must not compare two clocks (T-360).
 *
 * The skew is built by moving `effective_from` forward rather than by faking
 * a clock: a database whose clock runs δ ahead of the application leaves
 * exactly this state behind, and constructing it directly keeps the suite
 * free of sleeps, fake timers and driver-specific timestamp precision.
 *
 * Both copies of the row move together because that is what the deployment
 * does — the system-database mirror is written by copying the project
 * database's value verbatim, so a row stamped by a fast clock is ahead on
 * both sides.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refFormats } from "../src/db/project-schema.ts";
import { refPrefixes } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** ref_formats stamps effective_from with now(); keep switches ordered. */
const settle = () => new Promise((r) => setTimeout(r, 5));

describe.each(PLACEMENTS)(
  "ref format clock skew (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;

    /** Holds `CK`, and is where every comment below is written. */
    const A = `ckskew-a-${placement}`;
    /** Holds `BB`, so a bare `BB-N` in A has to cross the directory. */
    const B = `ckskew-b-${placement}`;
    const ids = new Map<string, number>();

    /** The card references point at, and the card they are written on. */
    let target = 0;
    let host = 0;
    let abroad = 0;

    const headers = () => ({ "content-type": "application/json", cookie });

    const req = (path: string, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: init?.body ? headers() : { cookie },
      });

    const dbOf = async (slug: string) =>
      t.ctx.router.forProject(
        routeInfoOf({
          id: ids.get(slug) as number,
          slug,
          databaseUrl: null,
          // Only the routing fields are read.
        } as Parameters<typeof routeInfoOf>[0]),
      );

    const createProject = async (slug: string) => {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      ids.set(slug, ((await json(res)) as { id: number }).id);
    };

    const putFormat = async (slug: string, prefix: string) => {
      await settle();
      const res = await req(`/projects/${slug}/references/format`, {
        method: "PUT",
        body: JSON.stringify({ prefix }),
      });
      expect(res.status).toBe(200);
    };

    const createIssue = async (
      slug: string,
      title: string,
    ): Promise<number> => {
      const res = await req(`/projects/${slug}/issues`, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return ((await json(res)) as { number: number }).number;
    };

    const comment = async (
      slug: string,
      number: number,
      body: string,
    ): Promise<{ id: number; body: string }> => {
      const res = await req(`/projects/${slug}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number; body: string };
    };

    const events = async (slug: string, number: number): Promise<unknown[]> => {
      const res = await req(
        `/projects/${slug}/issues/${number}/timeline?types=referenced&limit=100`,
      );
      expect(res.status).toBe(200);
      return ((await json(res)) as { items: unknown[] }).items;
    };

    /** Restamp a project's hold on `prefix` as if a fast clock had written it. */
    const skew = async (slug: string, prefix: string) => {
      const at = new Date(Date.now() + 5 * 60_000);
      const id = ids.get(slug) as number;
      await (await dbOf(slug))
        .update(refFormats)
        .set({ effectiveFrom: at })
        .where(
          and(eq(refFormats.projectId, id), eq(refFormats.prefix, prefix)),
        );
      await t.ctx.router
        .system()
        .update(refPrefixes)
        .set({ effectiveFrom: at })
        .where(
          and(eq(refPrefixes.projectId, id), eq(refPrefixes.prefix, prefix)),
        );
    };

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      await createProject(A);
      await createProject(B);
      await putFormat(A, "CK");
      await putFormat(B, "BB");
      target = await createIssue(A, "the card being pointed at");
      host = await createIssue(A, "the card the references are written on");
      abroad = await createIssue(B, "the foreign card");
      await skew(A, "CK");
      await skew(B, "BB");
    });

    afterAll(async () => {
      await t.cleanup();
    });

    it("resolves this project's own prefix", async () => {
      const written = await comment(A, host, `blocked by CK-${target}`);
      expect(written.body).toBe(
        `blocked by [CK-${target}](/projects/${ids.get(A)}/issues/${target})`,
      );
      expect(await events(A, target)).toHaveLength(1);
    });

    it("labels a comment's issue with this project's own prefix", async () => {
      const written = await comment(A, host, "nothing to resolve here");
      const res = await req(`/projects/${A}/comments/${written.id}`);
      expect(res.status).toBe(200);
      expect(((await json(res)) as { issue_ref: string }).issue_ref).toBe(
        `CK-${host}`,
      );
    });

    it("resolves a foreign prefix through the directory", async () => {
      const written = await comment(A, host, `see BB-${abroad}`);
      expect(written.body).toBe(
        `see [BB-${abroad}](/projects/${ids.get(B)}/issues/${abroad})`,
      );
      expect(await events(B, abroad)).toHaveLength(1);
    });
  },
);
