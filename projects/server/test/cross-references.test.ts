import type { ChangeEvent } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** effective_from and created_at are both now(); keep them apart so a
 *  hold always strictly precedes the content written under it. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const SRC = "xref-src";
const DST = "xref-dst";
const RIVAL = "xref-rival";

describe("cross-project references T-150", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const projectId: Record<string, number> = {};
  const headers = () => ({ "content-type": "application/json", cookie });

  const createIssue = async (
    slug: string,
    title: string,
    body = "",
    who: Record<string, string> = headers(),
  ): Promise<number> => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  };

  const events = async (
    slug: string,
    number: number,
    type: string,
  ): Promise<Array<{ payload: Record<string, unknown> }>> => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?types=${type}&limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items;
  };

  const putFormat = async (slug: string, prefix: string | null) => {
    await settle();
    const res = await t.app.request(`/api/projects/${slug}/references/format`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ prefix }),
    });
    expect(res.status).toBe(200);
    await settle();
  };

  const dbOf = async (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: projectId[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [SRC, DST, RIVAL]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: `Xref ${slug}` }),
      });
      expect(res.status).toBe(201);
      projectId[slug] = (await json(res)).id;
    }
    bob = await addUserWithToken(t.ctx, "xref-bob");
    const res = await t.app.request(
      `/api/projects/${SRC}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(res.status).toBe(204);
    await putFormat(SRC, "T");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("records one event per qualified spelling of a target", async () => {
    const targets = await Promise.all([
      createIssue(DST, "by slug-hash"),
      createIssue(DST, "by slug-slash"),
      createIssue(DST, "by slug-prefix"),
      createIssue(DST, "by slug-slash-hash"),
    ]);
    const [a, b, c, d] = targets as [number, number, number, number];
    const source = await createIssue(
      SRC,
      "four spellings",
      `see ${DST}#${a}, ${DST}/${b}, ${DST}/T-${c} and ${DST}/#${d}`,
    );

    for (const number of targets) {
      const landed = await events(DST, number, "cross_referenced");
      expect(landed).toHaveLength(1);
      expect(landed[0]?.payload).toMatchObject({
        by_project: SRC,
        by_issue: source,
      });
    }
  });

  it("consumes a qualified form whole, never as a local T-N", async () => {
    // This project's own format is "T-", and "/" is a legal left boundary
    // for it — so without the priority rule the tail of xref-dst/T-N would
    // fire as a local reference.
    const decoy = await createIssue(SRC, "local decoy");
    await createIssue(SRC, "decoy source", `see ${DST}/T-${decoy}`);
    expect(await events(SRC, decoy, "referenced")).toHaveLength(0);
  });

  it("replays an edit without duplicating the event", async () => {
    const target = await createIssue(DST, "edit target");
    const source = await createIssue(SRC, "editable", `first ${DST}#${target}`);
    const res = await t.app.request(`/api/projects/${SRC}/issues/${source}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ body: `second ${DST}#${target}` }),
    });
    expect(res.status).toBe(200);
    expect(await events(DST, target, "cross_referenced")).toHaveLength(1);
  });

  it("carries the source comment when the reference came from one", async () => {
    const target = await createIssue(DST, "comment target");
    const source = await createIssue(SRC, "commenter");
    const res = await t.app.request(
      `/api/projects/${SRC}/issues/${source}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: `also ${DST}#${target}` }),
      },
    );
    expect(res.status).toBe(201);
    const comment = await json(res);
    const landed = await events(DST, target, "cross_referenced");
    expect(landed[0]?.payload).toMatchObject({
      by_project: SRC,
      by_issue: source,
      by_comment: comment.id,
    });
  });

  it("wakes the target project's bus, not the source's", async () => {
    const target = await createIssue(DST, "bus target");
    const seen: Array<{ projectId: number; event: ChangeEvent }> = [];
    const stop = t.ctx.bus.subscribe((projectId, event) => {
      seen.push({ projectId, event });
    });
    try {
      await createIssue(SRC, "bus source", `ping ${DST}#${target}`);
    } finally {
      stop();
    }
    const dstEvents = seen.filter(
      (e) => e.event.entity === "timeline" && e.event.issue_number === target,
    );
    expect(dstEvents).toHaveLength(1);
    const dstProject = await json(
      await t.app.request(`/api/projects/${DST}`, { headers: { cookie } }),
    );
    expect(dstEvents[0]?.projectId).toBe(dstProject.id);
  });

  it("resolves a bare foreign prefix through its single holder", async () => {
    await putFormat(DST, "DST");
    const target = await createIssue(DST, "bare target");
    await createIssue(SRC, "bare source", `fixes DST-${target}`);
    expect(await events(DST, target, "cross_referenced")).toHaveLength(1);
  });

  it("refuses to guess once a second project claims the prefix", async () => {
    await putFormat(RIVAL, "DST");
    const target = await createIssue(DST, "contested target");
    await createIssue(SRC, "contested source", `fixes DST-${target}`);
    expect(await events(DST, target, "cross_referenced")).toHaveLength(0);
  });

  it("writes nothing when the author cannot read the target", async () => {
    const target = await createIssue(DST, "walled target");
    const source = await createIssue(
      SRC,
      "outsider",
      `peek ${DST}#${target}`,
      bob.headers,
    );
    expect(source).toBeGreaterThan(0);
    expect(await events(DST, target, "cross_referenced")).toHaveLength(0);
  });

  it("treats a bare comment anchor as a reference to its issue", async () => {
    const target = await createIssue(SRC, "anchored");
    const res = await t.app.request(
      `/api/projects/${SRC}/issues/${target}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "the load-bearing comment" }),
      },
    );
    expect(res.status).toBe(201);
    const comment = await json(res);
    await createIssue(SRC, "anchor source", `see #comment-${comment.id}`);
    expect(await events(SRC, target, "referenced")).toHaveLength(1);
  });

  it("records a cross reference from text written years ago", async () => {
    const target = await createIssue(DST, "old-text target");
    const source = await createIssue(SRC, "old-text source");
    const db = await dbOf(SRC);
    await db
      .update(issues)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(
        and(
          eq(issues.projectId, projectId[SRC] as number),
          eq(issues.number, source),
        ),
      );
    const res = await t.app.request(`/api/projects/${SRC}/issues/${source}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ body: `see ${DST}#${target}` }),
    });
    expect(res.status).toBe(200);
    expect(await events(DST, target, "cross_referenced")).toHaveLength(1);
  });
});

describe("cross-project references across a rename (T-156)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  const create = async (slug: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: `Rename ${slug}` }),
    });
    expect(res.status).toBe(201);
  };

  const rename = async (from: string, body: Record<string, unknown>) => {
    await settle();
    const res = await t.app.request(`/api/projects/${from}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    await settle();
  };

  const issue = async (slug: string, title: string, body = "") => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const crossEvents = async (slug: string, number: number) => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?types=cross_referenced&limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items as Array<{
      payload: Record<string, unknown>;
    }>;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("re-resolves old text to the project that held the slug then", async () => {
    await create("ren-src");
    await create("ren-tgt");
    await create("ren-thief");
    const target = await issue("ren-tgt", "the real target");
    const decoy = await issue("ren-thief", "same number, wrong project");
    expect(decoy).toBe(target);

    await settle();
    const source = await issue("ren-src", "points across", "see ren-tgt/1");
    expect(await crossEvents("ren-tgt", target)).toHaveLength(1);

    await rename("ren-tgt", { slug: "ren-tgt2" });
    await rename("ren-thief", { slug: "ren-tgt", reclaim: true });

    // Editing replays extraction against the body's ORIGINAL timestamp, so
    // "ren-tgt" still means whoever held it when the text was written.
    const edited = await t.app.request(
      `/api/projects/ren-src/issues/${source}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: "see ren-tgt/1 (still)" }),
      },
    );
    expect(edited.status).toBe(200);

    expect(await crossEvents("ren-tgt2", target)).toHaveLength(1);
    expect(await crossEvents("ren-tgt", decoy)).toHaveLength(0);
  });

  it("keeps a renamed project's old references visible on the target", async () => {
    await create("vis-src");
    await create("vis-tgt");
    const target = await issue("vis-tgt", "referenced once");
    await settle();
    await issue("vis-src", "the source", "see vis-tgt/1");
    expect(await crossEvents("vis-tgt", target)).toHaveLength(1);

    await rename("vis-src", { slug: "vis-src2" });

    // The event payload still spells the old slug; the visibility predicate
    // has to know that spelling belongs to a project this viewer can read.
    const after = await crossEvents("vis-tgt", target);
    expect(after).toHaveLength(1);
    expect(after[0]?.payload.by_project).toBe("vis-src");
  });

  it("publishes slug history in the viewer's reference directory", async () => {
    await create("dir-a");
    await rename("dir-a", { slug: "dir-a2" });

    const mine = await t.app.request("/api/me/reference-directory", {
      headers: { cookie },
    });
    const entries = (await json(mine)).slug_entries as Array<{
      slug: string;
      canonical: string;
      to: string | null;
    }>;
    expect(entries).toContainEqual(
      expect.objectContaining({ slug: "dir-a", canonical: "dir-a2" }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        slug: "dir-a2",
        canonical: "dir-a2",
        to: null,
      }),
    );

    const stranger = await addUserWithToken(t.ctx, "dir-stranger");
    const theirs = await t.app.request("/api/me/reference-directory", {
      headers: stranger.headers,
    });
    expect((await json(theirs)).slug_entries).toEqual([]);
  });
});
