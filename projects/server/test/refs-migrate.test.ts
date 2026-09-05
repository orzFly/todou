import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comments,
  issueEvents,
  issues,
  refFormats,
  revisions,
  specVersionFiles,
  specVersions,
} from "../src/db/project-schema.ts";
import { projects, slugHistory } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { migrateRefs } from "../src/services/refs-migrate.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The one-off migration (T-266), against a corpus that carries every shape
 * the deployment it is aimed at can hold: a card that moved, a project that
 * was renamed and one that reclaimed the old name, text written before the
 * cross-project grammar, qualified spellings, comment anchors, several spec
 * versions and links already written by hand.
 *
 * The bodies are written straight into the rows on purpose. Text that went
 * through the API would already be resolved, which is the one thing the
 * corpus must not be.
 */
describe("refs migrate", () => {
  let t: TestApp;
  let cookie: string;
  // A real database persists between runs, and every slug here is written
  // into the corpus text the assertions spell out — so the run has to own
  // its own names rather than reuse the last one's.
  const run_ = Date.now().toString(36);
  const A = `mig-a-${run_}`;
  const B = `mig-b-${run_}`;
  const id: Record<string, number> = {};
  const authorId = 1;

  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", cookie }
        : { cookie },
    });

  const dbOf = async (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: id[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  const createIssue = async (slug: string, title: string) => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: "" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  /** A body the resolve pass never saw, which is what a real corpus holds. */
  const setBody = async (slug: string, issueId: number, body: string) => {
    const db = await dbOf(slug);
    await db.update(issues).set({ body }).where(eq(issues.id, issueId));
  };

  const addRawComment = async (
    slug: string,
    issueId: number,
    body: string,
  ): Promise<number> => {
    const db = await dbOf(slug);
    const rows = await db
      .insert(comments)
      .values({
        projectId: id[slug] as number,
        issueId,
        authorId,
        body,
      })
      .returning({ id: comments.id });
    return rows[0]?.id as number;
  };

  const bodyOf = async (slug: string, issueId: number) => {
    const db = await dbOf(slug);
    const [row] = await db
      .select({ body: issues.body })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row?.body as string;
  };

  const commentBody = async (slug: string, commentId: number) => {
    const db = await dbOf(slug);
    const [row] = await db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.id, commentId));
    return row?.body as string;
  };

  const run = async (dryRun: boolean) => {
    const lines: string[] = [];
    const report = await migrateRefs(t.ctx, {
      dryRun,
      log: (line) => lines.push(line),
    });
    return { report, lines };
  };

  beforeAll(async () => {
    // The same suite against a real database when one is offered: PGlite's
    // clock has no sub-millisecond digits, and the migration decides which
    // project a segment belongs to by comparing timestamps.
    //   TODOU_TEST_POSTGRES_URL=postgres://… pnpm --filter @todou/server test refs-migrate
    const url = process.env.TODOU_TEST_POSTGRES_URL;
    t = await makeTestApp(
      "shared",
      url === undefined ? undefined : { systemUrl: url },
    );
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      id[slug] = ((await json(res)) as { id: number }).id;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("rewrites the corpus, settles on the second pass and reports first", async () => {
    const targetA = await createIssue(A, "the target in A");
    const targetB = await createIssue(B, "the target in B");
    const anchored = await createIssue(A, "carries a comment");
    const commentId = await addRawComment(A, anchored.id, "load-bearing");

    const card = await createIssue(A, "the corpus");
    const corpus = [
      `bare #${targetA.number} and qualified ${B}#${targetB.number}`,
      `an anchor #comment-${commentId} and a miss #99999`,
      "",
      "```",
      `fenced #${targetA.number}`,
      "```",
      `inline \`#${targetA.number}\` too`,
      "",
      `a hand-written link [look](/projects/${A}/issues/${targetA.number})`,
      `and one nobody claims: nowhere#3`,
    ].join("\n");
    await setBody(A, card.id, corpus);
    const noteId = await addRawComment(
      A,
      card.id,
      `the comment also says #${targetA.number}`,
    );

    const pushed = await req(`/projects/${A}/issues/${card.number}/spec/push`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "plan.md", body: "v1" }],
        message: "v1",
      }),
    });
    expect(pushed.status).toBe(200);
    const second = await req(`/projects/${A}/issues/${card.number}/spec/push`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "plan.md", body: "v2" }],
        message: "v2",
      }),
    });
    expect(second.status).toBe(200);
    // Both versions are part of the corpus, so both get a token to resolve.
    const db = await dbOf(A);
    const specFiles = await db
      .select({ id: specVersionFiles.id })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersions.id, specVersionFiles.versionId))
      .where(eq(specVersions.issueId, card.id));
    expect(specFiles).toHaveLength(2);
    for (const file of specFiles) {
      await db
        .update(specVersionFiles)
        .set({ body: `spec says #${targetA.number}` })
        .where(eq(specVersionFiles.id, file.id));
    }

    const preview = await run(true);
    expect(preview.report.changed).toBeGreaterThan(0);
    // A dry run writes nothing.
    expect(await bodyOf(A, card.id)).toBe(corpus);
    // …and names what it could not resolve, so an operator can look. The
    // list is candidates the grammar produced and the resolver turned down;
    // `nowhere#3` never becomes one, because a qualified form naming an
    // unknown project is consumed as literal text by the scanner itself.
    expect(preview.lines.join("\n")).toContain("#99999");
    expect(preview.lines.join("\n")).not.toContain("nowhere#3");

    const real = await run(false);
    expect(real.report.changed).toBe(preview.report.changed);

    const hrefA = `/projects/${id[A]}/issues/${targetA.number}`;
    expect(await bodyOf(A, card.id)).toBe(
      [
        `bare [#${targetA.number}](${hrefA}) and qualified ` +
          `[${B}#${targetB.number}](/projects/${id[B]}/issues/${targetB.number})`,
        `an anchor [#comment-${commentId}](/projects/${id[A]}/issues/` +
          `${anchored.number}#comment-${commentId}) and a miss #99999`,
        "",
        "```",
        `fenced #${targetA.number}`,
        "```",
        `inline \`#${targetA.number}\` too`,
        "",
        `a hand-written link [look](${hrefA})`,
        `and one nobody claims: nowhere#3`,
      ].join("\n"),
    );
    expect(await commentBody(A, noteId)).toBe(
      `the comment also says [#${targetA.number}](${hrefA})`,
    );

    const specAfter = await db
      .select({ body: specVersionFiles.body })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersions.id, specVersionFiles.versionId))
      .where(eq(specVersions.issueId, card.id));
    expect(specAfter.map((row) => row.body)).toEqual([
      `spec says [#${targetA.number}](${hrefA})`,
      `spec says [#${targetA.number}](${hrefA})`,
    ]);

    // The original text is recoverable, and the card does not claim its
    // author edited it.
    const kept = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, card.id),
        ),
      );
    expect(kept.map((row) => row.body)).toEqual([corpus]);
    const [after] = await db
      .select({ editedAt: issues.bodyEditedAt })
      .from(issues)
      .where(eq(issues.id, card.id));
    expect(after?.editedAt).toBeNull();
    // A spec version is its own history, so it records no revision: only
    // the body and the comment did, which the row type cannot even spell.
    const commentKept = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "comment"),
          eq(revisions.subjectId, noteId),
        ),
      );
    expect(commentKept.map((row) => row.body)).toEqual([
      `the comment also says #${targetA.number}`,
    ]);

    const again = await run(false);
    expect(again.report.changed).toBe(0);
    expect(again.report.links).toBe(0);
  });

  it("reads a moved card's older text under the project that owned it", async () => {
    const inA = await createIssue(A, "A's card");
    // A card that arrived in B from A: text older than the arrival used A's
    // numbering, text younger than it uses B's.
    const inB = await createIssue(B, "B's card with A's number");
    while (inB.number < inA.number) {
      const filler = await createIssue(B, "filler");
      inB.number = filler.number;
      inB.id = filler.id;
    }
    const card = await createIssue(B, "arrived from A");
    const dbB = await dbOf(B);
    const at = new Date(Date.now() - 60_000);
    await dbB.insert(issueEvents).values({
      projectId: id[B] as number,
      issueId: card.id,
      actorId: authorId,
      type: "moved_in",
      createdAt: at,
      payload: {
        move_token: "mig-tok",
        lineage: 1,
        from_project_id: id[A],
        from_project: A,
        from_number: 4242,
      },
    });
    // The body predates the arrival; the comment postdates it.
    await dbB
      .update(issues)
      .set({
        body: `written in A: #${inA.number}`,
        createdAt: new Date(at.getTime() - 1000),
      })
      .where(eq(issues.id, card.id));
    const later = await addRawComment(
      B,
      card.id,
      `written in B: #${inB.number}`,
    );
    await dbB
      .update(comments)
      .set({ createdAt: new Date(at.getTime() + 1000) })
      .where(eq(comments.id, later));

    await run(false);

    expect(await bodyOf(B, card.id)).toBe(
      `written in A: [#${inA.number}](/projects/${id[A]}/issues/${inA.number})`,
    );
    expect(await commentBody(B, later)).toBe(
      `written in B: [#${inB.number}](/projects/${id[B]}/issues/${inB.number})`,
    );
  });

  it("follows the address book to where a card lives now", async () => {
    const traveller = await createIssue(A, "will move");
    const pointer = await createIssue(A, "points at it");
    await setBody(A, pointer.id, `see #${traveller.number}`);

    const moved = await req(`/projects/${A}/issues/${traveller.number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: B }),
    });
    expect(moved.status).toBe(200);
    const to = (await json(moved)).moved_to as { number: number };

    await run(false);
    expect(await bodyOf(A, pointer.id)).toBe(
      `see [#${traveller.number}](/projects/${id[B]}/issues/${to.number})`,
    );
  });

  it("reads a retired slug as whoever held it then", async () => {
    // Inside the old holder's tenure. A date before either project existed
    // would fall through to the current holder instead, which is the
    // deliberate pre-T-156 fallback rather than a gap in the history.
    const whileHeld = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const renamed = `${B}2`;
    const rename = await req(`/projects/${B}`, {
      method: "PATCH",
      body: JSON.stringify({ slug: renamed }),
    });
    expect(rename.status).toBe(200);
    const reclaim = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ slug: B, name: "the reclaimer", reclaim: true }),
    });
    expect(reclaim.status).toBe(201);
    const thiefId = ((await json(reclaim)) as { id: number }).id;

    const inThief = await t.app.request(`/api/projects/${B}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "the reclaimer's card", body: "" }),
    });
    expect(inThief.status).toBe(201);
    const decoy = (await json(inThief)) as { number: number };

    // Written before the reclaim, so `mig-b#N` meant the old holder.
    const card = await createIssue(A, "wrote the old name");
    const dbA = await dbOf(A);
    await dbA
      .update(issues)
      .set({
        body: `old name: ${B}#${decoy.number}`,
        createdAt: whileHeld,
      })
      .where(eq(issues.id, card.id));

    await run(false);
    // Resolved to the project that answered to that spelling at the time,
    // which is the whole reason the migration reads the slug history.
    expect(await bodyOf(A, card.id)).toBe(
      `old name: [${B}#${decoy.number}](/projects/${id[B]}/issues/${decoy.number})`,
    );
    expect(id[B]).not.toBe(thiefId);
  });

  it("merges the events and leaves a slug it cannot place alone", async () => {
    const target = await createIssue(A, "event target");
    const dbA = await dbOf(A);
    await dbA.insert(issueEvents).values([
      {
        projectId: id[A] as number,
        issueId: target.id,
        actorId: authorId,
        type: "referenced",
        payload: { by_issue: 1 },
      },
      {
        projectId: id[A] as number,
        issueId: target.id,
        actorId: authorId,
        type: "cross_referenced",
        payload: { by_project: `${B}2`, by_issue: 2 },
      },
      {
        projectId: id[A] as number,
        issueId: target.id,
        actorId: authorId,
        type: "cross_referenced",
        payload: { by_project: "gone-for-good", by_issue: 3 },
      },
    ]);

    await run(false);

    const rows = await dbA
      .select({ type: issueEvents.type, payload: issueEvents.payload })
      .from(issueEvents)
      .where(
        and(
          eq(issueEvents.projectId, id[A] as number),
          eq(issueEvents.issueId, target.id),
        ),
      );
    const local = rows.find(
      (row) => (row.payload as { by_issue?: number }).by_issue === 1,
    );
    expect(local?.type).toBe("referenced");
    expect(local?.payload).toMatchObject({ by_project_id: id[A], by_issue: 1 });

    const renamed = rows.find(
      (row) => (row.payload as { by_issue?: number }).by_issue === 2,
    );
    expect(renamed?.type).toBe("referenced");
    expect(renamed?.payload).toMatchObject({ by_project_id: id[B] });

    // Nothing says who wrote it, so it keeps the shape it had; the renderer's
    // fallback still shows it, and no id is invented.
    const orphan = rows.find(
      (row) => (row.payload as { by_issue?: number }).by_issue === 3,
    );
    expect(orphan?.type).toBe("cross_referenced");
    expect(orphan?.payload).toMatchObject({ by_project: "gone-for-good" });
  });

  it("reads pre-format-switch text under the format of its own day", async () => {
    const target = await createIssue(A, "prefix-era target");
    const card = await createIssue(A, "written before the switch");
    const dbA = await dbOf(A);
    const switched = new Date(Date.now() - 30_000);
    await dbA.insert(refFormats).values({
      projectId: id[A] as number,
      prefix: "CH",
      effectiveFrom: switched,
    });
    await dbA
      .update(issues)
      .set({
        body: `old style #${target.number}, new style CH-${target.number}`,
        createdAt: new Date(switched.getTime() - 1000),
      })
      .where(eq(issues.id, card.id));

    await run(false);
    // `#N` was the format that day, so it resolves; `CH-N` was not yet.
    expect(await bodyOf(A, card.id)).toBe(
      `old style [#${target.number}](/projects/${id[A]}/issues/${target.number}), ` +
        `new style CH-${target.number}`,
    );
  });

  it("refuses to run while an all-digit slug exists", async () => {
    const system = t.ctx.router.system();
    const [row] = await system
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.slug, A));
    // Straight into the row: the API forbids this shape now, and the point
    // is what happens to a deployment that already has one.
    await system
      .update(projects)
      .set({ slug: `${Date.now() % 100000}` })
      .where(eq(projects.id, row?.id as number));
    try {
      await expect(run(true)).rejects.toThrow(/all-digit/);
    } finally {
      await system
        .update(projects)
        .set({ slug: row?.slug as string })
        .where(eq(projects.id, row?.id as number));
      await system
        .delete(slugHistory)
        .where(eq(slugHistory.slug, "4242"))
        .catch(() => {});
    }
  });
});
