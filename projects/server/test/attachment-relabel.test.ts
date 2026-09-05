import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import {
  attachments,
  comments,
  issues,
  revisions,
  specVersionFiles,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  relabelAttachments,
  relabelSegment,
  type SegmentContext,
} from "../src/services/attachment-relabel.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The fixture is the state migration 0013 leaves behind: the attachment row
 * carries the new name while its `attachment_added` event still carries the
 * old one. Uploading twice would not produce it — the upload path writes the
 * settled name into the event — so the rename is applied to the row directly,
 * exactly as the migration does.
 */
describe("attachments relabel", () => {
  let t: TestApp;
  let cookie: string;
  let db: Db;
  let projectId = 0;
  let renamedId = 0;
  let keptId = 0;
  let renamed = "";
  let issueId = 0;
  let commentId = 0;
  let specFileId = 0;
  let body = "";
  let commentBody = "";
  let specBody = "";
  const slug = "relabel";
  const GONE = 999999;
  const ORIGIN = "https://todou.test";
  const headers = () => ({ "content-type": "application/json", cookie });
  const lines: string[] = [];

  const at = (owner: string | number, id: number, name?: string) =>
    `/api/projects/${owner}/attachments/${id}/download${
      name === undefined ? "" : `/${name}`
    }`;

  const upload = async (name: string) => {
    const form = new FormData();
    form.set("file", new File(["bytes"], name, { type: "text/plain" }));
    form.set("issue_number", "1");
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  const run = async (dryRun: boolean) => {
    lines.length = 0;
    return relabelAttachments(
      { router: t.ctx.router },
      { dryRun, slug, log: (line) => lines.push(line) },
    );
  };

  const readBack = async () => {
    const [issue] = await db
      .select({ body: issues.body })
      .from(issues)
      .where(eq(issues.id, issueId));
    const [comment] = await db
      .select({ body: comments.body })
      .from(comments)
      .where(eq(comments.id, commentId));
    const [spec] = await db
      .select({ body: specVersionFiles.body, size: specVersionFiles.size })
      .from(specVersionFiles)
      .where(eq(specVersionFiles.id, specFileId));
    return {
      issue: issue?.body ?? "",
      comment: comment?.body ?? "",
      spec: spec?.body ?? "",
      specSize: spec?.size ?? 0,
    };
  };

  beforeAll(async () => {
    // Only an absolute URL against the configured origin is autolinked, and
    // only an autolink is the shape T-266 wraps.
    t = await makeTestApp("dedicated", {
      extraToml: `[http]\npublic_origin = "${ORIGIN}"`,
    });
    cookie = await t.login();
    const project = await json(
      await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: "Relabel" }),
      }),
    );
    projectId = project.id;
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "with links" }),
    });

    const first = await upload("foo.png");
    const second = await upload("keep.png");
    renamedId = first.id;
    keptId = second.id;
    renamed = `foo-${renamedId}.png`;

    db = await t.ctx.router.forProject(
      routeInfoOf({
        id: projectId,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    // What 0013 does: the row moves, the event stays.
    await db
      .update(attachments)
      .set({ filename: renamed })
      .where(eq(attachments.id, renamedId));

    // Submitted in the slug spelling a person would type. T-266's resolve
    // pass anchors every href it can on the project id before storing, and
    // wraps the bare one — so what relabel actually meets is what comes back
    // out, not what goes in.
    await t.app.request(`/api/projects/${slug}/issues/1`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        body: [
          `[foo.png](${at(slug, renamedId, "foo.png")})`,
          `[截图](${at(slug, renamedId, "foo.png")})`,
          `![](${at(slug, renamedId, "foo.png")})`,
          "inline `foo.png` in code, and foo.png in prose",
          `[keep.png](${at(slug, keptId, "keep.png")})`,
          `[gone.png](${at(slug, GONE, "gone.png")})`,
          `${ORIGIN}${at(slug, renamedId, "foo.png")}`,
        ].join("\n\n"),
      }),
    });

    const [issue] = await db
      .select({ id: issues.id, body: issues.body })
      .from(issues)
      .where(eq(issues.number, 1));
    issueId = (issue as { id: number }).id;
    body = (issue as { body: string }).body;

    // A deployment that has not run `refs migrate` still holds the slug
    // spelling everywhere, so that half is written past the resolve pass
    // rather than through it.
    commentBody = [
      `[foo.png](${at(slug, renamedId, "foo.png")})`,
      `[foo.png](${at(slug, renamedId)})`,
      `[foo.png](/api/projects/other/attachments/${renamedId}/download/foo.png)`,
    ].join("\n\n");
    commentId = (
      await json(
        await t.app.request(`/api/projects/${slug}/issues/1/comments`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: "placeholder" }),
        }),
      )
    ).id;
    await db
      .update(comments)
      .set({ body: commentBody })
      .where(eq(comments.id, commentId));

    specBody = `see [foo.png](${at(projectId, renamedId, "foo.png")})\n`;
    await t.app.request(`/api/projects/${slug}/issues/1/spec/push`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ files: [{ path: "plan.md", body: specBody }] }),
    });

    const [file] = await db
      .select({ id: specVersionFiles.id })
      .from(specVersionFiles);
    specFileId = (file as { id: number }).id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("meets the shapes T-266 stores, wrapped bare URL included", () => {
    // The premise the rest of this file rests on, asserted rather than
    // assumed: resolvable hrefs come back anchored on the project id, one
    // that resolves to nothing keeps its slug spelling, and the bare address
    // is now a link whose TEXT is the whole URL as typed.
    expect(body).toBe(
      [
        `[foo.png](${at(projectId, renamedId, "foo.png")})`,
        `[截图](${at(projectId, renamedId, "foo.png")})`,
        `![](${at(projectId, renamedId, "foo.png")})`,
        "inline `foo.png` in code, and foo.png in prose",
        `[keep.png](${at(projectId, keptId, "keep.png")})`,
        `[gone.png](${at(slug, GONE, "gone.png")})`,
        `[${ORIGIN}${at(slug, renamedId, "foo.png")}](${at(projectId, renamedId, "foo.png")})`,
      ].join("\n\n"),
    );
  });

  it("changes nothing on a --dry-run, and says what it would change", async () => {
    const report = await run(true);
    expect(report).toMatchObject({ projects: 1, segments: 3, links: 7 });
    // The one link nobody can resolve: the row it names is gone.
    expect(report.skipped).toBe(1);
    expect(lines).toContain(
      `${slug}/1 issue_body #${renamedId}: "foo.png" → "${renamed}"`,
    );

    const after = await readBack();
    expect(after.issue).toBe(body);
    expect(after.comment).toBe(commentBody);
    expect(after.spec).toBe(specBody);
  });

  it("moves only the link text that was the filename, and the url segment", async () => {
    const report = await run(false);
    expect(report).toMatchObject({ segments: 3, links: 7, skipped: 1 });

    const after = await readBack();
    expect(after.issue).toBe(
      [
        `[${renamed}](${at(projectId, renamedId, renamed)})`,
        `[截图](${at(projectId, renamedId, renamed)})`,
        `![](${at(projectId, renamedId, renamed)})`,
        "inline `foo.png` in code, and foo.png in prose",
        `[keep.png](${at(projectId, keptId, "keep.png")})`,
        `[gone.png](${at(slug, GONE, "gone.png")})`,
        // The wrapped bare URL: the filename moves on both sides, and the
        // origin and slug the author typed stay exactly as they were.
        `[${ORIGIN}${at(slug, renamedId, renamed)}](${at(projectId, renamedId, renamed)})`,
      ].join("\n\n"),
    );
  });

  it("reads the project segment as either the slug or the id", async () => {
    const after = await readBack();
    expect(after.comment).toBe(
      [
        `[${renamed}](${at(slug, renamedId, renamed)})`,
        // No last segment to move; the link text still does.
        `[${renamed}](${at(slug, renamedId)})`,
        // Another project's spelling of the same id is not ours to touch.
        `[foo.png](/api/projects/other/attachments/${renamedId}/download/foo.png)`,
      ].join("\n\n"),
    );
  });

  it("rewrites spec files and keeps their recorded size honest", async () => {
    const after = await readBack();
    expect(after.spec).toBe(
      `see [${renamed}](${at(projectId, renamedId, renamed)})\n`,
    );
    expect(after.specSize).toBe(Buffer.byteLength(after.spec, "utf8"));
  });

  it("leaves the pre-rewrite text as a revision on the body and the comment", async () => {
    // Newest first: the body was also edited to plant the fixture, so the
    // relabel's snapshot is the one on top.
    const [issueRevision] = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, issueId),
        ),
      )
      .orderBy(desc(revisions.id))
      .limit(1);
    expect(issueRevision?.body).toBe(body);

    const commentRevisions = await db
      .select({ body: revisions.body })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "comment"),
          eq(revisions.subjectId, commentId),
        ),
      );
    expect(commentRevisions).toEqual([{ body: commentBody }]);
  });

  it("finds nothing left to do on a second run", async () => {
    const before = await readBack();
    const report = await run(false);
    expect(report).toMatchObject({ segments: 0, links: 0 });
    expect(await readBack()).toEqual(before);
  });
});

/**
 * The wrapped-bare-URL rule up close. Rewriting text that merely looks like a
 * URL would be a guess, so all three gates get their own case.
 */
describe("link text that is itself an attachment URL", () => {
  const ctx: SegmentContext = {
    renames: new Map([[1, { before: "foo.png", after: "foo-1.png" }]]),
    known: new Set([1, 2]),
    owners: new Set(["7", "mine"]),
  };
  const href = "/api/projects/7/attachments/1/download/foo.png";
  const wrap = (label: string) => `[${label}](${href})`;

  it("moves the filename on both sides and keeps the origin verbatim", () => {
    const typed = "https://todou.test/api/projects/mine/attachments/1/download";
    const out = relabelSegment(wrap(`${typed}/foo.png`), ctx);
    expect(out.text).toBe(
      `[${typed}/foo-1.png](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
    expect(out.changes).toHaveLength(1);
  });

  it("takes a path-spelled text too", () => {
    const out = relabelSegment(
      wrap("/api/projects/mine/attachments/1/view/foo.png"),
      ctx,
    );
    expect(out.text).toBe(
      `[/api/projects/mine/attachments/1/view/foo-1.png](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
  });

  it("leaves text naming another attachment alone", () => {
    const label =
      "https://todou.test/api/projects/mine/attachments/2/download/foo.png";
    expect(relabelSegment(wrap(label), ctx).text).toBe(
      `[${label}](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
  });

  it("leaves text naming another project alone", () => {
    const label =
      "https://todou.test/api/projects/theirs/attachments/1/download/foo.png";
    expect(relabelSegment(wrap(label), ctx).text).toBe(
      `[${label}](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
  });

  it("leaves text whose last segment is not the old name alone", () => {
    const label =
      "https://todou.test/api/projects/mine/attachments/1/download/other.png";
    expect(relabelSegment(wrap(label), ctx).text).toBe(
      `[${label}](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
  });

  it("leaves a URL with trailing prose in the text alone", () => {
    const label =
      "https://todou.test/api/projects/mine/attachments/1/download/foo.png and more";
    expect(relabelSegment(wrap(label), ctx).text).toBe(
      `[${label}](/api/projects/7/attachments/1/download/foo-1.png)`,
    );
  });
});
