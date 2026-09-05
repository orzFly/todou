import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comments,
  issues,
  refFormats,
  revisions,
  specVersionFiles,
  specVersions,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * A move respells the references the card's own text wrote at its old address
 * (T-247): storage, display and API text all say `old-project#12`, so a CLI
 * reader can paste what it read back into a positional argument.
 */
describe.each(PLACEMENTS)("move respell (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  const A = `rsp-a-${placement}`;
  const B = `rsp-b-${placement}`;
  const C = `rsp-c-${placement}`;
  const id: Record<string, number> = {};

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body ? headers() : { cookie },
    });

  const dbOf = async (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: id[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  const createIssue = async (slug: string, title: string, body = "") => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  const addComment = async (slug: string, number: number, body: string) => {
    const res = await req(`/projects/${slug}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number };
  };

  const move = async (from: string, number: number, to: string) => {
    const res = await req(`/projects/${from}/issues/${number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
    expect(res.status).toBe(200);
    return (await json(res)) as {
      moved_to: { slug: string; number: number };
    };
  };

  const landed = async (slug: string, number: number) => {
    const db = await dbOf(slug);
    const [row] = await db
      .select({
        id: issues.id,
        body: issues.body,
        bodyEditedAt: issues.bodyEditedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, id[slug] as number),
          eq(issues.number, number),
        ),
      );
    if (row === undefined) throw new Error("landed issue missing");
    return { db, ...row };
  };

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    for (const slug of [A, B, C]) {
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

  it("qualifies bare refs, remaps comment anchors and leaves the rest alone", async () => {
    const target = await createIssue(A, "target in A");
    const neighbour = await createIssue(A, "another card in A");
    const foreign = await addComment(
      A,
      neighbour.number,
      "a comment over here",
    );
    const inB = await createIssue(B, "target in B");

    const body = [
      `sees #${target.number} and ${B}#${inB.number}`,
      "",
      "```",
      `#${target.number} inside a fence`,
      "```",
      `inline \`#${target.number}\` too`,
    ].join("\n");
    const card = await createIssue(A, "travels", body);
    const anchored = await addComment(A, card.number, "the anchored comment");
    const pointing = await addComment(
      A,
      card.number,
      `back to #comment-${anchored.id} and over to #comment-${foreign.id}`,
    );

    const before = await landed(A, card.number);
    const [pointingBefore] = await before.db
      .select({ body: comments.body, editedAt: comments.editedAt })
      .from(comments)
      .where(eq(comments.id, pointing.id));

    const result = await move(A, card.number, B);
    const after = await landed(B, result.moved_to.number);

    expect(after.body).toBe(
      [
        `sees ${A}#${target.number} and ${B}#${inB.number}`,
        "",
        "```",
        `#${target.number} inside a fence`,
        "```",
        `inline \`#${target.number}\` too`,
      ].join("\n"),
    );
    // A spelling normalisation is not an author's edit.
    expect(after.bodyEditedAt).toBe(before.bodyEditedAt);

    const copied = await after.db
      .select({
        id: comments.id,
        body: comments.body,
        editedAt: comments.editedAt,
      })
      .from(comments)
      .where(eq(comments.issueId, after.id))
      .orderBy(comments.id);
    const anchoredNew = copied.find(
      (row) => row.body === "the anchored comment",
    );
    const pointingNew = copied.find((row) => row.body.startsWith("back to"));
    expect(anchoredNew).toBeDefined();
    expect(pointingNew?.body).toBe(
      `back to #comment-${anchoredNew?.id} and over to ` +
        `${A}#${neighbour.number}#comment-${foreign.id}`,
    );
    expect(pointingNew?.editedAt).toBe(pointingBefore?.editedAt ?? null);

    // The superseded text is recoverable, as the author typed it.
    const bodyRevisions = await after.db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, after.id),
        ),
      );
    expect(bodyRevisions.map((row) => row.body)).toEqual([before.body]);
    const commentRevisions = await after.db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "comment"),
          eq(revisions.subjectId, pointingNew?.id as number),
        ),
      );
    expect(commentRevisions.map((row) => row.body)).toEqual([
      pointingBefore?.body,
    ]);
  });

  it("keeps the reference events the respelled text names", async () => {
    const target = await createIssue(A, "event target");
    const card = await createIssue(A, "points at it", `see #${target.number}`);

    await move(A, card.number, B);

    const timeline = await json(
      await req(`/projects/${A}/issues/${target.number}/timeline?limit=100`),
    );
    const cross = timeline.items.filter(
      (item: { event_type?: string }) => item.event_type === "cross_referenced",
    );
    expect(cross).toHaveLength(1);
    expect(cross[0].payload).toMatchObject({ by_project: B });
  });

  it("reads each segment under the format its own owner had then", async () => {
    const target = await createIssue(A, "prefix-era target");
    // A switched to `CH-N` at this instant, so text older than it still means
    // `#N` and text newer than it means `CH-N`.
    const switchedAt = new Date(Date.now() - 60_000);
    const put = await req(`/projects/${A}/references/format`, {
      method: "PUT",
      body: JSON.stringify({ prefix: "CH" }),
    });
    expect(put.status).toBe(200);
    const db = await dbOf(A);
    await db
      .update(refFormats)
      .set({ effectiveFrom: switchedAt })
      .where(
        and(
          eq(refFormats.projectId, id[A] as number),
          eq(refFormats.prefix, "CH"),
        ),
      );

    const card = await createIssue(
      A,
      "spans a switch",
      `old #${target.number}`,
    );
    await db
      .update(issues)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(issues.id, card.id));
    const modern = await addComment(A, card.number, `new CH-${target.number}`);

    const result = await move(A, card.number, B);
    const after = await landed(B, result.moved_to.number);
    expect(after.body).toBe(`old ${A}#${target.number}`);

    const copied = await after.db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, after.id));
    expect(copied.map((row) => row.body)).toEqual([
      `new ${A}#${target.number}`,
    ]);

    // Put A back on `#N` so the rest of the suite reads as it was written.
    expect(
      (
        await req(`/projects/${A}/references/format`, {
          method: "PUT",
          body: JSON.stringify({ prefix: null }),
        })
      ).status,
    ).toBe(200);
    expect(modern.id).toBeGreaterThan(0);
  });

  it("respells every spec version and leaves other files' bytes alone", async () => {
    const target = await createIssue(A, "spec target");
    const card = await createIssue(A, "carries a spec", "no refs here");
    for (const message of ["v1", "v2"]) {
      const push = await req(`/projects/${A}/issues/${card.number}/spec/push`, {
        method: "POST",
        body: JSON.stringify({
          message,
          files: [
            {
              path: "plan.md",
              body: [
                `${message} points at #${target.number}`,
                "```",
                `#${target.number} in code`,
                "```",
              ].join("\n"),
            },
          ],
        }),
      });
      expect(push.status).toBe(200);
    }
    // The schema only admits `.md`, so the one file that must keep its bytes
    // has to be seeded straight into the table.
    const sourceDb = await dbOf(A);
    const [firstVersion] = await sourceDb
      .select({ id: specVersions.id })
      .from(specVersions)
      .where(eq(specVersions.issueId, card.id))
      .orderBy(specVersions.number);
    const raw = `notes with #${target.number}`;
    await sourceDb.insert(specVersionFiles).values({
      projectId: id[A] as number,
      versionId: firstVersion?.id as number,
      path: "notes.txt",
      body: raw,
      size: Buffer.byteLength(raw, "utf8"),
    });

    const result = await move(A, card.number, B);
    const after = await landed(B, result.moved_to.number);

    const files = await after.db
      .select({
        path: specVersionFiles.path,
        body: specVersionFiles.body,
        size: specVersionFiles.size,
        number: specVersions.number,
      })
      .from(specVersionFiles)
      .innerJoin(specVersions, eq(specVersionFiles.versionId, specVersions.id))
      .where(eq(specVersions.issueId, after.id))
      .orderBy(specVersions.number, specVersionFiles.path);

    for (const version of [1, 2]) {
      const plan = files.find(
        (row) => row.number === version && row.path === "plan.md",
      );
      expect(plan?.body).toBe(
        [
          `v${version} points at ${A}#${target.number}`,
          "```",
          `#${target.number} in code`,
          "```",
        ].join("\n"),
      );
      expect(plan?.size).toBe(Buffer.byteLength(plan?.body ?? "", "utf8"));
    }
    const notes = files.find((row) => row.path === "notes.txt");
    expect(notes?.body).toBe(raw);

    // A spec version is its own history; the rewrite adds no revision row.
    expect(
      await after.db
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, after.id),
          ),
        ),
    ).toHaveLength(0);
  });

  it("composes across a second move and survives a round trip", async () => {
    const inA = await createIssue(A, "A's card");
    const card = await createIssue(A, "goes far", `from A: #${inA.number}`);
    const first = await move(A, card.number, B);

    const inB = await createIssue(B, "B's card");
    await addComment(B, first.moved_to.number, `from B: #${inB.number}`);

    const second = await move(B, first.moved_to.number, C);
    const after = await landed(C, second.moved_to.number);
    // The A-era body was respelled by the first move and is position
    // independent now, so the second move has nothing left to do to it.
    expect(after.body).toBe(`from A: ${A}#${inA.number}`);
    const copied = await after.db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, after.id));
    expect(copied.map((row) => row.body)).toEqual([
      `from B: ${B}#${inB.number}`,
    ]);

    // Back where it started: its own text names A explicitly, which stays
    // true at home, so nothing is rewritten and no revision is added.
    const home = await move(C, second.moved_to.number, A);
    const reinhabited = await landed(A, home.moved_to.number);
    expect(reinhabited.body).toBe(`from A: ${A}#${inA.number}`);
    expect(
      await reinhabited.db
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, reinhabited.id),
          ),
        ),
    ).toHaveLength(1);
  });
});
