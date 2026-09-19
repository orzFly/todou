import type {
  ChangeEvent,
  SpecComments,
  SpecFiles,
  SpecInfo,
  TimelineItem,
} from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import type { Db } from "../src/db/driver.ts";
import {
  comments,
  issueEvents,
  issueMentions,
  issues,
  specVersionFiles,
  specVersions,
} from "../src/db/project-schema.ts";
import { issueToken } from "../src/services/tokens.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Actor = { user: UserRow; headers: Who };
const FILES = [
  {
    path: "design.md",
    body: "# Design\n\nKeep this line.\nResolve this line.\n",
  },
  { path: "notes/phases.md", body: "# Phases\n\nOne.\n" },
];
const PLANTED = "2020-01-01T00:00:00.000Z";
const session = (sessionId: string) => ({
  agent: "claude-code",
  session_id: sessionId,
  model: "test-model",
});

describe.each(PLACEMENTS)(
  "spec withdrawal T-428 (%s placement)",
  (placement) => {
    let t: TestApp;
    let db: Db;
    let projectId: number;
    let owner: Who;
    let writer: Actor;
    let otherWriter: Actor;
    let reader: Actor;
    let reporter: Actor;
    let secondSession: Who;
    const slug = `withdraw-${placement}`;

    const request = (
      number: number,
      suffix: string,
      method = "GET",
      body?: unknown,
      who: Who = writer.headers,
    ) =>
      t.app.request(`/api/projects/${slug}/issues/${number}${suffix}`, {
        method,
        headers: { "content-type": "application/json", ...who },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const push = (number: number, body: unknown, who: Who = writer.headers) =>
      request(number, "/spec/push", "POST", body, who);
    const withdraw = (
      number: number,
      body: unknown,
      who: Who = writer.headers,
    ) => request(number, "/spec/withdraw", "POST", body, who);
    const review = (
      number: number,
      body: unknown,
      who: Who = otherWriter.headers,
    ) => request(number, "/spec/reviews", "POST", body, who);

    async function get(number: number, suffix: string) {
      const res = await request(number, suffix);
      expect(res.status).toBe(200);
      return json(res);
    }
    const info = (number: number): Promise<SpecInfo> => get(number, "/spec");
    const files = (number: number, version?: number): Promise<SpecFiles> =>
      get(
        number,
        `/spec/files${version === undefined ? "" : `?version=${version}`}`,
      );
    const annotations = (number: number): Promise<SpecComments> =>
      get(number, "/spec/comments");
    async function timeline(
      number: number,
      query = "",
    ): Promise<TimelineItem[]> {
      const page = await get(number, `/timeline?limit=100${query}`);
      expect(page.has_more).toBe(false);
      return page.items;
    }
    const since = (number: number, cursor: string) =>
      timeline(number, `&after=${encodeURIComponent(cursor)}`);

    async function createIssue(withSpec = true): Promise<number> {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", ...writer.headers },
        body: JSON.stringify({ title: "Withdrawal lifecycle" }),
      });
      expect(res.status).toBe(201);
      const { number } = await json(res);
      if (withSpec) {
        expect(
          (await push(number, { files: FILES, message: "initial" })).status,
        ).toBe(200);
      }
      return number;
    }

    async function snapshot(number: number) {
      return {
        issue: await get(number, ""),
        info: await info(number),
        files: await files(number),
        comments: await annotations(number),
        timeline: await timeline(number),
      };
    }

    // Raw snapshots remain available when the issue's write/read gate is closed.
    async function stored(number: number) {
      const [issue] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
      if (!issue) throw new Error("fixture issue missing");
      return {
        issue,
        comments: await db
          .select()
          .from(comments)
          .where(eq(comments.issueId, issue.id)),
        events: await db
          .select()
          .from(issueEvents)
          .where(eq(issueEvents.issueId, issue.id)),
        versions: await db
          .select()
          .from(specVersions)
          .where(eq(specVersions.issueId, issue.id)),
        files: await db
          .select({ file: specVersionFiles })
          .from(specVersionFiles)
          .innerJoin(
            specVersions,
            eq(specVersions.id, specVersionFiles.versionId),
          )
          .where(eq(specVersions.issueId, issue.id)),
        mentions: await db
          .select()
          .from(issueMentions)
          .where(eq(issueMentions.issueId, issue.id)),
      };
    }

    async function plantUpdatedAt(number: number) {
      await db
        .update(issues)
        .set({ updatedAt: new Date(PLANTED) })
        .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
      expect((await get(number, "")).updated_at).toBe(PLANTED);
    }

    async function publicationsDuring(body: () => Promise<void>) {
      const seen: ChangeEvent[] = [];
      const off = t.ctx.bus.subscribe((pid, event) => {
        if (pid === projectId) seen.push(event);
      });
      try {
        await body();
      } finally {
        off();
      }
      return seen;
    }

    const annotation = (line: number, body: string) => ({
      anchor: {
        path: "design.md",
        version: 1,
        line_start: line,
        line_end: line,
      },
      body,
    });

    beforeAll(async () => {
      t = await makeTestApp(placement);
      owner = { cookie: await t.login() };
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...owner },
        body: JSON.stringify({ slug, name: "Spec withdrawal" }),
      });
      expect(created.status).toBe(201);
      projectId = (await json(created)).id;
      db = await t.ctx.router.forProject({
        id: projectId,
        slug,
        database_url: "",
      });
      const me = await json(await t.app.request("/api/me", { headers: owner }));
      writer = await addUserWithToken(t.ctx, "withdraw-writer", {
        kind: "machine",
        ownerId: me.id,
      });
      otherWriter = await addUserWithToken(t.ctx, "withdraw-other");
      reader = await addUserWithToken(t.ctx, "withdraw-reader");
      reporter = await addUserWithToken(t.ctx, "withdraw-reporter");
      for (const [member, role] of [
        [writer, "writer"],
        [otherWriter, "writer"],
        [reader, "reader"],
        [reporter, "reporter"],
      ] as const) {
        const res = await t.app.request(
          `/api/projects/${slug}/members/${member.user.id}`,
          {
            method: "PUT",
            headers: { "content-type": "application/json", ...owner },
            body: JSON.stringify({ role }),
          },
        );
        expect(res.status).toBe(204);
      }
      const token = await issueToken(t.ctx.router.system(), writer.user.id, {
        name: "second-session",
      });
      secondSession = {
        authorization: `Bearer ${token.token}`,
        "x-todou-agent-context": JSON.stringify(session("withdraw-session-b")),
      };
    });

    afterAll(async () => {
      await t.cleanup();
    });

    it("rejects unknown keys, null, missing/nonpositive/noninteger versions and empty/oversized reasons without writes", async () => {
      const number = await createIssue();
      const before = await snapshot(number);
      const invalid = [
        { label: "unknown key", body: { version: 1, typo: true } },
        { label: "null body", body: null },
        { label: "missing version", body: { reason: "obsolete" } },
        { label: "null version", body: { version: null } },
        { label: "zero version", body: { version: 0 } },
        { label: "negative version", body: { version: -1 } },
        { label: "fractional version", body: { version: 1.5 } },
        { label: "string version", body: { version: "1" } },
        { label: "null reason", body: { version: 1, reason: null } },
        { label: "non-string reason", body: { version: 1, reason: 1 } },
        { label: "empty reason", body: { version: 1, reason: "" } },
        { label: "whitespace reason", body: { version: 1, reason: " \n\t " } },
        {
          label: "2001 characters",
          body: { version: 1, reason: "x".repeat(2001) },
        },
      ];
      const seen = await publicationsDuring(async () => {
        for (const { label, body } of invalid) {
          expect((await withdraw(number, body)).status, label).toBe(422);
        }
      });
      expect(seen).toEqual([]);
      expect(await snapshot(number)).toEqual(before);
    });

    it("accepts an omitted reason and trimmed reasons of one through 2000 characters", async () => {
      for (const reason of [undefined, " x ", ` \n${"x".repeat(2000)}\t `]) {
        const number = await createIssue();
        const res = await withdraw(number, { version: 1, reason });
        expect(res.status).toBe(200);
        expect(await json(res)).toMatchObject({
          version: 1,
          review_status: "withdrawn",
          unchanged: false,
        });
        const events = await timeline(number, "&types=spec_withdrawn");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          payload: { version: 1, reason: reason?.trim() ?? null },
        });
        expect((await info(number)).versions[0]?.withdrawal?.reason).toBe(
          reason?.trim() ?? null,
        );
      }
    });

    it("allows the pusher and another writer to withdraw with the acting account recorded", async () => {
      for (const actor of [writer, otherWriter]) {
        const number = await createIssue();
        const res = await withdraw(number, { version: 1 }, actor.headers);
        expect(res.status).toBe(200);
        expect((await info(number)).versions[0]?.withdrawal?.actor.id).toBe(
          actor.user.id,
        );
        const events = await timeline(number, "&types=spec_withdrawn");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ actor: { id: actor.user.id } });
      }
    });

    it("denies readers and reporters before revealing spec existence or state", async () => {
      const empty = await createIssue(false);
      const number = await createIssue();
      expect((await withdraw(number, { version: 1 })).status).toBe(200);
      const before = await snapshot(number);
      const seen = await publicationsDuring(async () => {
        for (const actor of [reader, reporter]) {
          for (const target of [empty, number]) {
            for (const version of [1, 99]) {
              expect(
                (await withdraw(target, { version }, actor.headers)).status,
              ).toBe(403);
            }
          }
        }
      });
      expect(seen).toEqual([]);
      expect(await snapshot(number)).toEqual(before);
      expect((await stored(empty)).versions).toEqual([]);
    });

    it("allows a second session of the same account to withdraw and preserves session attribution", async () => {
      const number = await createIssue(false);
      expect(
        (
          await push(
            number,
            { files: FILES },
            {
              ...writer.headers,
              "x-todou-agent-context": JSON.stringify(
                session("withdraw-session-a"),
              ),
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (await withdraw(number, { version: 1 }, secondSession)).status,
      ).toBe(200);
      expect((await info(number)).versions[0]?.withdrawal?.actor.id).toBe(
        writer.user.id,
      );
      expect(await timeline(number, "&types=spec_withdrawn")).toMatchObject([
        {
          actor: { id: writer.user.id },
          agent_context: session("withdraw-session-b"),
        },
      ]);
    });

    it("returns no-spec 404 before version checks and stale-version 409 before withdrawn idempotence", async () => {
      const empty = await createIssue(false);
      const emptyBefore = await stored(empty);
      const missing = await withdraw(empty, { version: 99 });
      expect(missing.status).toBe(404);
      expect((await json(missing)).error.message).toContain("no spec");
      expect(await stored(empty)).toEqual(emptyBefore);

      const number = await createIssue();
      for (const state of ["unreviewed", "withdrawn"]) {
        if (state === "withdrawn") {
          expect((await withdraw(number, { version: 1 })).status).toBe(200);
        }
        const before = await snapshot(number);
        const seen = await publicationsDuring(async () => {
          const res = await withdraw(number, { version: 2 });
          expect(res.status).toBe(409);
          const message = (await json(res)).error.message;
          expect(message).toContain("current spec is v1");
          expect(message).toContain(state);
          expect(message).toContain("cannot withdraw v2");
        });
        expect(seen).toEqual([]);
        expect(await snapshot(number)).toEqual(before);
      }
    });

    it.each([
      ["approve", "approved"],
      ["request_changes", "changes_requested"],
    ] as const)(
      "rejects withdrawal after %s and prioritizes a stale version over the state conflict",
      async (verdict, state) => {
        const number = await createIssue();
        expect((await review(number, { version: 1, verdict })).status).toBe(
          201,
        );
        const before = await snapshot(number);
        const seen = await publicationsDuring(async () => {
          const stale = await withdraw(number, { version: 2 });
          expect(stale.status).toBe(409);
          expect((await json(stale)).error.message).toContain(
            "cannot withdraw v2",
          );
          const current = await withdraw(number, { version: 1 });
          expect(current.status).toBe(409);
          const message = (await json(current)).error.message;
          expect(message).toContain(state);
          expect(message).toContain("only an unreviewed spec");
        });
        expect(seen).toEqual([]);
        expect(await snapshot(number)).toEqual(before);
      },
    );

    it("withdraws once and keeps reason, actor, timestamps, event, cursor and publications stable on retries", async () => {
      const number = await createIssue();
      const original = await info(number);
      await plantUpdatedAt(number);
      const seen = await publicationsDuring(async () => {
        const res = await withdraw(number, {
          version: 1,
          reason: "  superseded  ",
        });
        expect(res.status).toBe(200);
        const first = await json(res);
        expect(first).toMatchObject({
          version: 1,
          review_status: "withdrawn",
          unchanged: false,
        });
        expect(typeof first.cursor).toBe("string");
        const issue = await get(number, "");
        expect(issue).toMatchObject({
          spec_version: 1,
          spec_review_status: "withdrawn",
          spec_unresolved_comments: 0,
        });
        expect(Date.parse(issue.updated_at)).toBeGreaterThan(
          Date.parse(PLANTED),
        );
        const withdrawn = await info(number);
        expect(withdrawn.current_version_cursor).toBe(
          original.current_version_cursor,
        );
        const events = await timeline(number, "&types=spec_withdrawn");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actor: { id: writer.user.id },
          payload: { version: 1, reason: "superseded" },
        });
        expect(withdrawn.versions[0]?.withdrawal).toMatchObject({
          actor: { id: writer.user.id },
          reason: "superseded",
          created_at: events[0]?.created_at,
        });
        expect(await since(number, first.cursor)).toEqual([]);

        // A later entry must not make a retry return a new "now" cursor.
        expect(
          (
            await request(number, "/comments", "POST", {
              body: "after withdrawal",
            })
          ).status,
        ).toBe(201);
        await plantUpdatedAt(number);
        const beforeRetry = await snapshot(number);
        const retryPublications = await publicationsDuring(async () => {
          for (const reason of ["replacement reason", undefined]) {
            const retry = await withdraw(
              number,
              { version: 1, reason },
              otherWriter.headers,
            );
            expect(retry.status).toBe(200);
            expect(await json(retry)).toEqual({ ...first, unchanged: true });
          }
        });
        expect(retryPublications).toEqual([]);
        expect(await snapshot(number)).toEqual(beforeRetry);
        expect(await since(number, first.cursor)).toMatchObject([
          { type: "comment", body: "after withdrawal" },
        ]);
      });
      // The later plain comment contributes its own issue/timeline pair.
      expect(seen.filter((event) => event.entity === "spec")).toHaveLength(1);
      expect(
        seen
          .slice(0, 3)
          .map((event) => `${event.entity}:${event.action}`)
          .sort(),
      ).toEqual(["issue:updated", "spec:updated", "timeline:created"]);
      expect(seen.slice(0, 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entity: "issue",
            issue_number: number,
            list_row: { kind: "activity" },
          }),
        ]),
      );
      expect(seen).toHaveLength(5);
    });

    it("preserves files, versions, comments, resolution and history through identical resubmission", async () => {
      const number = await createIssue();
      expect(
        (
          await request(number, "/comments", "POST", {
            body: "ordinary discussion",
          })
        ).status,
      ).toBe(201);
      const submitted = await review(number, {
        version: 1,
        verdict: "comment",
        body: "review summary",
        comments: [annotation(3, "still open"), annotation(4, "settled")],
      });
      expect(submitted.status).toBe(201);
      const result = await json(submitted);
      expect(
        (
          await request(number, "/spec/comments/resolve", "POST", {
            comment_ids: [result.comment_ids[1]],
          })
        ).status,
      ).toBe(200);
      const before = await snapshot(number);
      expect(before.info).toMatchObject({
        unresolved_comments: 1,
        unresolved_carried_comments: 0,
      });
      expect(
        (await withdraw(number, { version: 1, reason: "reconsider" })).status,
      ).toBe(200);
      const withdrawn = await snapshot(number);
      expect(withdrawn.files).toEqual(before.files);
      expect(withdrawn.comments).toEqual(before.comments);
      expect(withdrawn.info.files).toEqual(before.info.files);
      expect(withdrawn.info.versions).toHaveLength(1);
      expect(withdrawn.info.versions[0]).toMatchObject(
        before.info.versions[0] ?? {},
      );
      expect(withdrawn.timeline.slice(0, -1)).toEqual(before.timeline);
      expect(withdrawn.info).toMatchObject({
        current_version: 1,
        review_status: "withdrawn",
        unresolved_comments: 1,
      });

      const res = await push(number, {
        files: FILES,
        if_version: 1,
        message: "resubmitted",
      });
      expect(res.status).toBe(200);
      const pushed = await json(res);
      expect(pushed).toMatchObject({
        unchanged: false,
        version: 2,
        added: [],
        changed: [],
        removed: [],
      });
      const after = await snapshot(number);
      expect(after.info).toMatchObject({
        current_version: 2,
        review_status: "unreviewed",
        unresolved_comments: 1,
        unresolved_carried_comments: 1,
      });
      expect(after.issue).toMatchObject({
        spec_version: 2,
        spec_review_status: "unreviewed",
        spec_unresolved_comments: 1,
      });
      expect(after.info.versions).toHaveLength(2);
      expect(after.info.versions[0]).toEqual(withdrawn.info.versions[0]);
      expect(after.info.versions[1]).toMatchObject({
        number: 2,
        message: "resubmitted",
      });
      expect(after.info.versions[1]?.withdrawal).toBeUndefined();
      expect(await files(number, 1)).toEqual(before.files);
      expect(after.files.files).toEqual(before.files.files);
      expect(after.comments.items).toEqual(before.comments.items);
      expect(after.comments.current_version).toBe(2);
      expect(after.timeline.slice(0, -1)).toEqual(withdrawn.timeline);
      expect(after.timeline.at(-1)).toMatchObject({
        event_type: "spec_pushed",
        payload: { version: 2, added: [], changed: [], removed: [] },
      });
      expect(after.info.current_version_cursor).not.toBe(
        before.info.current_version_cursor,
      );
      expect(
        await since(number, after.info.current_version_cursor),
      ).toMatchObject([{ event_type: "spec_pushed", payload: { version: 2 } }]);
      expect(await since(number, pushed.cursor)).toEqual([]);

      // A retry for the old withdrawal must conflict once a new submission exists.
      const stale = await withdraw(number, { version: 1 });
      expect(stale.status).toBe(409);
      expect((await json(stale)).error.message).toContain("current spec is v2");
      expect(await snapshot(number)).toEqual(after);
    });

    it("resubmits changed files as a new unreviewed version while retaining withdrawal history", async () => {
      const number = await createIssue();
      expect(
        (await withdraw(number, { version: 1, reason: "new approach" })).status,
      ).toBe(200);
      const withdrawn = await info(number);
      const res = await push(number, {
        if_version: 1,
        files: [
          { path: "design.md", body: "# Revised\n" },
          { path: "new.md", body: "# Added\n" },
        ],
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({
        unchanged: false,
        version: 2,
        added: ["new.md"],
        changed: ["design.md"],
        removed: ["notes/phases.md"],
      });
      const current = await info(number);
      expect(current.review_status).toBe("unreviewed");
      expect(current.versions[0]).toEqual(withdrawn.versions[0]);
      expect(
        (await files(number, 1)).files.map(({ path, body }) => ({
          path,
          body,
        })),
      ).toEqual(FILES);
      expect(
        (await review(number, { version: 2, verdict: "approve" })).status,
      ).toBe(201);
      expect((await info(number)).review_status).toBe("approved");
    });

    it.each(["unreviewed", "approved", "changes_requested"] as const)(
      "keeps an identical push a complete no-op while %s",
      async (state) => {
        const number = await createIssue();
        if (state !== "unreviewed") {
          expect(
            (
              await review(number, {
                version: 1,
                verdict: state === "approved" ? "approve" : "request_changes",
              })
            ).status,
          ).toBe(201);
        }
        await plantUpdatedAt(number);
        const before = await snapshot(number);
        const seen = await publicationsDuring(async () => {
          const res = await push(number, {
            files: FILES,
            if_version: 1,
            message: "ignored on no-op",
          });
          expect(res.status).toBe(200);
          expect(await json(res)).toMatchObject({
            unchanged: true,
            version: 1,
            cursor: before.info.current_version_cursor,
            added: [],
            changed: [],
            removed: [],
          });
        });
        expect(seen).toEqual([]);
        expect(await snapshot(number)).toEqual(before);
      },
    );

    it.each(["approve", "request_changes"] as const)(
      "rejects %s on withdrawn specs without leaving a summary, annotation, event or publication",
      async (verdict) => {
        const number = await createIssue();
        expect((await withdraw(number, { version: 1 })).status).toBe(200);
        await plantUpdatedAt(number);
        const before = await snapshot(number);
        const seen = await publicationsDuring(async () => {
          const res = await review(number, {
            version: 1,
            verdict,
            body: "must roll back",
            comments: [annotation(3, "must also roll back")],
          });
          expect(res.status).toBe(409);
          expect((await json(res)).error.message).toContain("withdrawn");
          // Business-state rejection precedes stored-anchor validation as well.
          const invalidAnchor = await review(number, {
            version: 1,
            verdict,
            body: "still rejected",
            comments: [
              {
                anchor: { path: "missing.md", version: 1 },
                body: "no such file",
              },
            ],
          });
          expect(invalidAnchor.status).toBe(409);
          expect((await json(invalidAnchor)).error.message).toContain(
            "withdrawn",
          );
        });
        expect(seen).toEqual([]);
        expect(await snapshot(number)).toEqual(before);
      },
    );

    it.each(["approve", "request_changes"] as const)(
      "keeps self-%s forbidden before the withdrawn conflict across same-account sessions",
      async (verdict) => {
        const number = await createIssue();
        expect((await withdraw(number, { version: 1 })).status).toBe(200);
        const before = await snapshot(number);
        const seen = await publicationsDuring(async () => {
          for (const who of [writer.headers, secondSession]) {
            const res = await review(
              number,
              {
                version: 1,
                verdict,
                body: "self summary",
                comments: [annotation(3, "self annotation")],
              },
              who,
            );
            expect(res.status).toBe(403);
            expect((await json(res)).error.message).toContain(
              "pushed by this account",
            );
          }
        });
        expect(seen).toEqual([]);
        expect(await snapshot(number)).toEqual(before);
      },
    );

    it("allows comment reviews while withdrawn and keeps the original current_version_cursor", async () => {
      const number = await createIssue();
      const original = await info(number);
      expect(
        (await withdraw(number, { version: 1, reason: "discussion continues" }))
          .status,
      ).toBe(200);
      const withdrawal = (await info(number)).versions[0]?.withdrawal;
      for (const who of [secondSession, otherWriter.headers]) {
        const res = await review(
          number,
          {
            version: 1,
            verdict: "comment",
            body: "a summary after withdrawal",
            comments: [annotation(3, "a question after withdrawal")],
          },
          who,
        );
        expect(res.status).toBe(201);
        expect(await json(res)).toMatchObject({
          version: 1,
          verdict: "comment",
          summary_comment_id: expect.any(Number),
          comment_ids: [expect.any(Number)],
        });
      }
      const current = await info(number);
      expect(current).toMatchObject({
        current_version: 1,
        review_status: "withdrawn",
        unresolved_comments: 2,
        unresolved_carried_comments: 0,
        current_version_cursor: original.current_version_cursor,
      });
      expect(current.versions[0]?.withdrawal).toEqual(withdrawal);
      expect((await get(number, "")).spec_review_status).toBe("withdrawn");
      expect((await annotations(number)).items).toHaveLength(2);
      const replay = await since(number, original.current_version_cursor);
      expect(
        replay
          .filter((item) => item.type === "event")
          .map((item) => item.event_type),
      ).toEqual([
        "spec_pushed",
        "spec_withdrawn",
        "spec_review",
        "spec_review",
      ]);
      expect(replay.filter((item) => item.type === "comment")).toHaveLength(4);
    });

    it("stores reasons as pure text without mention notifications or reference events", async () => {
      const target = await createIssue(false);
      const number = await createIssue();
      const targetBefore = await timeline(target);
      const reason = `@${otherWriter.user.login} see #${target}, **obsolete**, <b>plain text</b>`;
      const seen = await publicationsDuring(async () => {
        expect((await withdraw(number, { version: 1, reason })).status).toBe(
          200,
        );
      });
      expect((await info(number)).versions[0]?.withdrawal?.reason).toBe(reason);
      expect(await timeline(number, "&types=spec_withdrawn")).toMatchObject([
        { payload: { version: 1, reason } },
      ]);
      const saved = await stored(number);
      expect(saved.mentions).toEqual([]);
      expect(saved.comments).toEqual([]);
      expect(await timeline(target)).toEqual(targetBefore);
      expect(seen).toHaveLength(3);
      expect(seen.every((event) => event.issue_number === number)).toBe(true);

      // Prove the mention fixture is eligible for notification in ordinary prose.
      expect(
        (
          await request(number, "/comments", "POST", {
            body: `@${otherWriter.user.login}`,
          })
        ).status,
      ).toBe(201);
      expect((await stored(number)).mentions).toMatchObject([
        { userId: otherWriter.user.id },
      ]);
    });

    it.each([
      ["deletedAt", "issue_deleted"],
      ["movingSince", "issue_moving"],
    ] as const)(
      "refuses withdrawal behind the static %s gate without writes",
      async (column, code) => {
        const number = await createIssue();
        await db
          .update(issues)
          .set({ [column]: new Date(PLANTED) })
          .where(
            and(eq(issues.projectId, projectId), eq(issues.number, number)),
          );
        const before = await stored(number);
        const seen = await publicationsDuring(async () => {
          const res = await withdraw(number, { version: 1 });
          expect(res.status).toBe(409);
          expect((await json(res)).error.code).toBe(code);
        });
        expect(seen).toEqual([]);
        expect(await stored(number)).toEqual(before);
      },
    );

    it("preserves withdrawn history across a project move and refuses withdrawal at the moved source", async () => {
      const destination = `${slug}-destination`;
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...owner },
        body: JSON.stringify({
          slug: destination,
          name: "Withdrawal destination",
        }),
      });
      expect(created.status).toBe(201);
      const number = await createIssue();
      expect(
        (await withdraw(number, { version: 1, reason: "preserve across move" }))
          .status,
      ).toBe(200);
      const original = await info(number);
      const originalFiles = await files(number);
      const originalEvents = await timeline(number, "&types=spec_withdrawn");
      const moved = await request(
        number,
        "/move",
        "POST",
        { to_project: destination },
        owner,
      );
      expect(moved.status).toBe(200);
      const { moved_to: movedTo } = await json(moved);
      const destinationSpec = async () => {
        const res = await t.app.request(
          `/api/projects/${destination}/issues/${movedTo.number}/spec`,
          { headers: owner },
        );
        expect(res.status).toBe(200);
        return json(res);
      };
      const before = await destinationSpec();
      expect(before).toEqual(original);
      const destinationFiles = await t.app.request(
        `/api/projects/${destination}/issues/${movedTo.number}/spec/files`,
        { headers: owner },
      );
      expect(destinationFiles.status).toBe(200);
      expect(await json(destinationFiles)).toEqual(originalFiles);
      const destinationEvents = await t.app.request(
        `/api/projects/${destination}/issues/${movedTo.number}/timeline?types=spec_withdrawn`,
        { headers: owner },
      );
      expect(destinationEvents.status).toBe(200);
      const copiedEvents = (await json(destinationEvents)).items;
      expect(copiedEvents).toHaveLength(1);
      const originalEvent = originalEvents[0];
      if (!originalEvent || originalEvent.type !== "event") {
        throw new Error("withdrawal event missing");
      }
      expect(copiedEvents[0]).toMatchObject({
        event_type: "spec_withdrawn",
        actor: originalEvent.actor,
        payload: originalEvent.payload,
        created_at: originalEvent.created_at,
      });
      const sourceBefore = await stored(number);
      const seen = await publicationsDuring(async () => {
        const res = await withdraw(number, { version: 1 }, owner);
        expect(res.status).toBe(409);
        expect((await json(res)).error.code).toBe("issue_moved");
      });
      expect(seen).toEqual([]);
      expect(await stored(number)).toEqual(sourceBefore);
      expect(await destinationSpec()).toEqual(before);
    });
  },
);
