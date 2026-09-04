import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import {
  attachments,
  comments,
  issueEvents,
  issueReads,
  issues,
  pendingUploads,
  revisions,
  specVersionFiles,
  specVersions,
  statuses,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  clearIssueChildren,
  copyIssueTree,
  ISSUE_CHILD_TABLES,
} from "../src/services/move/copy.ts";
import { microIso } from "../src/services/timeline.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const A = "copy-src";
const B = "copy-dst";

/**
 * `copyIssueTree` against a real database, table by table off the same
 * checklist the copier walks — the point being that a table nobody copied
 * and nobody deleted is invisible to every other test in the suite.
 */
describe("copyIssueTree", () => {
  let t: TestApp;
  let cookie: string;
  let db: Db;
  let idA = 0;
  let idB = 0;
  let issue: { id: number; number: number };
  let commentIds: number[] = [];
  let attachmentId = 0;

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body ? headers() : { cookie },
    });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      const project = (await json(res)) as { id: number };
      if (slug === A) idA = project.id;
      else idB = project.id;
    }
    db = await t.ctx.router.forProject(
      routeInfoOf({ id: idA, slug: A, databaseUrl: null } as Parameters<
        typeof routeInfoOf
      >[0]),
    );

    const created = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "travels well", body: "first body" }),
      }),
    );
    issue = { id: created.id, number: created.number };

    // Four comments, then a deleted one in the middle: identity columns never
    // reuse the gap, so the surviving ids are non-contiguous and a copier
    // that pairs by row order rather than by id will mispair them.
    for (const body of ["one", "two", "three", "four"]) {
      const res = await req(`/projects/${A}/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      expect(res.status).toBe(201);
      commentIds.push((await json(res)).id as number);
    }
    const doomed = commentIds[1] as number;
    expect(
      (
        await req(`/projects/${A}/issues/${issue.number}/comments/${doomed}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    commentIds = commentIds.filter((id) => id !== doomed);

    // An edit on each of the two subject kinds, so both revision shapes move.
    await req(`/projects/${A}/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "second body" }),
    });
    await req(
      `/projects/${A}/issues/${issue.number}/comments/${commentIds[0]}`,
      { method: "PATCH", body: JSON.stringify({ body: "one, edited" }) },
    );

    const form = new FormData();
    form.set("file", new File(["blob"], "a.txt", { type: "text/plain" }));
    form.set("issue_number", String(issue.number));
    const uploaded = await t.app.request(`/api/projects/${A}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    attachmentId = (await json(uploaded)).id as number;

    const pushed = await req(
      `/projects/${A}/issues/${issue.number}/spec/push`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "v1",
          files: [
            { path: "design.md", body: "# design" },
            { path: "plan.md", body: "# plan" },
          ],
        }),
      },
    );
    expect(pushed.status).toBe(200);

    // Rows on the two tables that are deliberately not copied.
    await db.insert(issueReads).values({
      projectId: idA,
      issueId: issue.id,
      userId: 1,
      lastSeenAt: new Date(),
    });
    await db.insert(pendingUploads).values({
      projectId: idA,
      issueId: issue.id,
      uploaderId: 1,
      filename: "half.bin",
      contentType: "application/octet-stream",
      declaredSize: 10,
      storageKey: "pending/half",
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("copies every child table, keeps the ones that must not travel", async () => {
    const [status] = await db
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, idB))
      .limit(1);
    const row = (
      await db.select().from(issues).where(eq(issues.id, issue.id))
    )[0];
    if (row === undefined || status === undefined) throw new Error("fixture");

    const before = {
      comments: await db
        .select({
          id: comments.id,
          body: comments.body,
          ts: microIso(comments.createdAt),
        })
        .from(comments)
        .where(eq(comments.issueId, issue.id)),
      events: await db
        .select({ type: issueEvents.type, payload: issueEvents.payload })
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issue.id)),
    };

    const map = await copyIssueTree(
      db,
      db,
      {
        row,
        source: { project: { id: idA } },
        target: { project: { id: idB } },
        status: { to: { id: status.id } },
        labelIds: [],
        assigneeIds: [],
        movedAt: new Date(),
        sameProjectDb: true,
      },
      { number: 1, reinhabit: false },
    );

    // The map pairs by id, not by position: each new comment must carry the
    // body of the source comment it claims to come from.
    const sourceBodies = new Map(before.comments.map((c) => [c.id, c.body]));
    expect(map.comments.size).toBe(3);
    for (const [oldId, newId] of map.comments) {
      const [copied] = await db
        .select({ body: comments.body })
        .from(comments)
        .where(eq(comments.id, newId));
      expect(copied?.body).toBe(sourceBodies.get(oldId));
    }
    expect(map.attachments.get(attachmentId)).toBeDefined();

    const copiedComments = await db
      .select({ body: comments.body, ts: microIso(comments.createdAt) })
      .from(comments)
      .where(eq(comments.issueId, map.issueId));
    expect(copiedComments).toHaveLength(3);
    // Timeline cursors are (created_at µs, kind, id): a rounded copy would
    // reorder the card's own history against cursors clients already hold.
    expect(copiedComments.map((c) => c.ts).sort()).toEqual(
      before.comments.map((c) => c.ts).sort(),
    );

    const copiedVersions = await db
      .select({ id: specVersions.id })
      .from(specVersions)
      .where(eq(specVersions.issueId, map.issueId));
    expect(copiedVersions).toHaveLength(1);
    const copiedFiles = await db
      .select({ path: specVersionFiles.path })
      .from(specVersionFiles)
      .where(eq(specVersionFiles.versionId, copiedVersions[0]?.id as number));
    expect(copiedFiles.map((f) => f.path).sort()).toEqual([
      "design.md",
      "plan.md",
    ]);

    const copiedBodyRevisions = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, idB),
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, map.issueId),
        ),
      );
    expect(copiedBodyRevisions.map((r) => r.body)).toEqual(["first body"]);

    const editedNewId = map.comments.get(commentIds[0] as number) as number;
    const copiedCommentRevisions = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, idB),
          eq(revisions.subjectType, "comment"),
          eq(revisions.subjectId, editedNewId),
        ),
      );
    expect(copiedCommentRevisions.map((r) => r.body)).toEqual(["one"]);

    const copiedEvents = await db
      .select({ type: issueEvents.type, payload: issueEvents.payload })
      .from(issueEvents)
      .where(eq(issueEvents.issueId, map.issueId));
    expect(copiedEvents).toHaveLength(before.events.length);
    const added = copiedEvents.find((e) => e.type === "attachment_added");
    const payload = added?.payload as { attachment?: { id?: number } };
    expect(payload.attachment?.id).toBe(map.attachments.get(attachmentId));

    // Neither of the two travels, and the copy must not invent rows either.
    expect(
      await db
        .select()
        .from(issueReads)
        .where(eq(issueReads.issueId, map.issueId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(pendingUploads)
        .where(eq(pendingUploads.issueId, map.issueId)),
    ).toHaveLength(0);
  });

  it("leaves nothing under the source once the children are cleared", async () => {
    await clearIssueChildren(db, issue.id);

    const counts = await Promise.all([
      db.select().from(comments).where(eq(comments.issueId, issue.id)),
      db.select().from(issueEvents).where(eq(issueEvents.issueId, issue.id)),
      db.select().from(attachments).where(eq(attachments.issueId, issue.id)),
      db.select().from(specVersions).where(eq(specVersions.issueId, issue.id)),
      db.select().from(issueReads).where(eq(issueReads.issueId, issue.id)),
      db
        .select()
        .from(pendingUploads)
        .where(eq(pendingUploads.issueId, issue.id)),
      db
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.projectId, idA),
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, issue.id),
          ),
        ),
    ]);
    for (const rows of counts) expect(rows).toHaveLength(0);

    // The spec files hang off the version rather than the issue, which is the
    // one that would survive a checklist walked by foreign key alone.
    const orphanFiles = await db
      .select()
      .from(specVersionFiles)
      .where(eq(specVersionFiles.projectId, idA));
    expect(orphanFiles).toHaveLength(0);
  });

  it("keeps the copy and clear checklists in step", () => {
    // Both halves read this list; a table added to the schema and forgotten
    // here leaves rows under a tombstone permanently.
    expect(ISSUE_CHILD_TABLES.map((entry) => entry.name).sort()).toEqual([
      "attachments",
      "comments",
      "issue_assignees",
      "issue_events",
      "issue_labels",
      "issue_reads",
      "pending_uploads",
      "revisions",
      "spec_version_files",
      "spec_versions",
    ]);
    expect(
      ISSUE_CHILD_TABLES.filter((entry) => !entry.copied).map((e) => e.name),
    ).toEqual(["issue_reads", "pending_uploads"]);
  });
});
