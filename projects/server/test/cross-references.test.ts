import type { ChangeEvent } from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemSettings } from "../src/db/system-schema.ts";
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

  const setCutoff = (at: Date) =>
    t.ctx.router
      .system()
      .update(systemSettings)
      .set({ value: at.toISOString() })
      .where(eq(systemSettings.key, "cross_refs_since"));

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

  it("leaves content written before the cutoff on the old grammar", async () => {
    await setCutoff(new Date(Date.now() + 60 * 60 * 1000));
    try {
      const target = await createIssue(DST, "pre-cutoff target");
      const local = await createIssue(SRC, "pre-cutoff local");
      await createIssue(
        SRC,
        "pre-cutoff source",
        `${DST}/T-${local} and #comment-1`,
      );
      expect(await events(DST, target, "cross_referenced")).toHaveLength(0);
      // Under the old grammar the trailing T-N of a qualified form is just
      // a local reference again.
      expect(await events(SRC, local, "referenced")).toHaveLength(1);
    } finally {
      await setCutoff(new Date(0));
    }
  });
});
