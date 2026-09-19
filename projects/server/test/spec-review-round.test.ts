import type { ChangeEvent, SpecInfo, SpecReviewVerdict } from "@todou/shared";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import type { Db } from "../src/db/driver.ts";
import { comments, issueEvents, issues } from "../src/db/project-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;
type Actor = { user: UserRow; headers: Record<string, string> };
const FILE_BODY = "# Design\n\nKeep this line.\nReview this line.\n";
const PLANTED = "2020-01-01T00:00:00.000Z";

const annotation = (version: number, path = "design.md") => ({
  anchor: { path, version, line_start: 3, line_end: 3 },
  body: "A valid annotation that must not escape a rejected review.",
});
const fullReview = (version = 1, verdict: SpecReviewVerdict = "approve") => ({
  version,
  verdict,
  body: "A summary that must not escape a rejected review.",
  comments: [annotation(version)],
});

describe.each(PLACEMENTS)("spec review rounds (%s placement)", (placement) => {
  let t: TestApp;
  let db: Db;
  let projectId: number;
  let p: Actor;
  let a: Actor;
  let b: Actor;
  const slug = `review-round-${placement}`;

  const request = (
    number: number,
    suffix: string,
    who: Actor,
    method = "GET",
    body?: unknown,
  ) =>
    t.app.request(`/api/projects/${slug}/issues/${number}${suffix}`, {
      method,
      headers: { "content-type": "application/json", ...who.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    const owner = {
      "content-type": "application/json",
      cookie: await t.login(),
    };
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ slug, name: "Review rounds" }),
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id;
    db = await t.ctx.router.forProject({
      id: projectId,
      slug,
      database_url: "",
    });
    p = await addUserWithToken(t.ctx, "round-pusher");
    a = await addUserWithToken(t.ctx, "round-reviewer-a");
    b = await addUserWithToken(t.ctx, "round-reviewer-b");
    for (const actor of [p, a, b]) {
      const member = await t.app.request(
        `/api/projects/${slug}/members/${actor.user.id}`,
        {
          method: "PUT",
          headers: owner,
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function push(number: number, version: number) {
    const res = await request(number, "/spec/push", p, "POST", {
      files: [
        { path: "design.md", body: `${FILE_BODY}\nRevision ${version}.\n` },
      ],
    });
    expect(res.status).toBe(200);
    expect((await json(res)).version).toBe(version);
  }

  async function createIssue() {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...p.headers },
      body: JSON.stringify({ title: "Independent review round" }),
    });
    expect(res.status).toBe(201);
    const { number } = await json(res);
    await push(number, 1);
    return number as number;
  }

  async function info(number: number, who: Actor): Promise<SpecInfo> {
    const res = await request(number, "/spec", who);
    expect(res.status).toBe(200);
    return json(res);
  }

  async function viewers(
    number: number,
    approvedA: boolean,
    approvedB: boolean,
    version = 1,
    status?: SpecInfo["review_status"],
    approvedP = false,
  ) {
    for (const [who, approved] of [
      [p, approvedP],
      [a, approvedA],
      [b, approvedB],
    ] as const) {
      const result = await info(number, who);
      expect(result.current_version).toBe(version);
      expect(result.viewer_review).toEqual({
        user_id: who.user.id,
        approved_in_current_round: approved,
      });
      if (status !== undefined) expect(result.review_status).toBe(status);
    }
  }

  async function accepted(
    number: number,
    who: Actor,
    verdict: SpecReviewVerdict,
    version = 1,
    withComments = false,
  ) {
    const res = await request(
      number,
      "/spec/reviews",
      who,
      "POST",
      withComments
        ? fullReview(version, verdict)
        : {
            version,
            verdict,
            ...(verdict === "comment" ? { body: "Discussion" } : {}),
          },
    );
    expect(res.status).toBe(201);
    const result = await json(res);
    expect(result).toMatchObject({ version, verdict });
    expect(result.event_id).toBeGreaterThan(0);
    expect(result.comment_ids).toHaveLength(withComments ? 1 : 0);
    if (withComments || verdict === "comment") {
      expect(result.summary_comment_id).toBeGreaterThan(0);
    } else {
      expect(result.summary_comment_id).toBeNull();
    }
    return result;
  }

  async function issueRow(number: number) {
    const [row] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
    if (!row) throw new Error("fixture issue missing");
    return row;
  }

  async function stored(number: number) {
    const issue = await issueRow(number);
    return {
      issue,
      comments: await db
        .select()
        .from(comments)
        .where(eq(comments.issueId, issue.id))
        .orderBy(asc(comments.id)),
      events: await db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issue.id))
        .orderBy(asc(issueEvents.id)),
    };
  }

  async function rejected(
    number: number,
    who: Actor,
    body: unknown,
    status: number,
    diagnostic: string,
  ) {
    // Make an accidental updatedAt write observable even on a fast machine.
    await db
      .update(issues)
      .set({ updatedAt: new Date(PLANTED) })
      .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
    const before = await stored(number);
    expect(before.issue.updatedAt.toISOString()).toBe(PLANTED);
    const personalBefore = await Promise.all(
      [p, a, b].map((who) => info(number, who)),
    );
    const publications: ChangeEvent[] = [];
    const off = t.ctx.bus.subscribe((pid, event) => {
      if (pid === projectId) publications.push(event);
    });
    try {
      const res = await request(number, "/spec/reviews", who, "POST", body);
      expect(res.status).toBe(status);
      const error = (await json(res)).error;
      expect(error.code).toBe(status === 403 ? "forbidden" : "conflict");
      expect(error.message).toContain(diagnostic);
      // Full rows cover counters, status, updatedAt, summaries, annotations and events.
      expect(await stored(number)).toEqual(before);
      expect(
        await Promise.all([p, a, b].map((who) => info(number, who))),
      ).toEqual(personalBefore);
      expect(publications).toEqual([]);
    } finally {
      off();
    }
  }

  const duplicate = (number: number, who = a, version = 1) =>
    rejected(
      number,
      who,
      fullReview(version),
      409,
      `already approved v${version} in the current review round`,
    );

  async function withdraw(number: number, version = 1) {
    const res = await request(number, "/spec/withdraw", p, "POST", { version });
    expect(res.status).toBe(200);
    expect((await json(res)).review_status).toBe("withdrawn");
  }

  // Storage fixtures are reserved for histories HTTP cannot produce (clock skew,
  // imported old-version events, and an otherwise impossible pusher approval).
  async function eventFixture(
    number: number,
    who: Actor,
    verdict: SpecReviewVerdict,
    version: number,
    createdAt = new Date(PLANTED),
  ) {
    const issue = await issueRow(number);
    const [event] = await db
      .insert(issueEvents)
      .values({
        projectId,
        issueId: issue.id,
        actorId: who.user.id,
        type: "spec_review",
        payload: { version, verdict, comment_id: null, annotation_count: 0 },
        createdAt,
      })
      .returning();
    if (!event) throw new Error("fixture event missing");
    return event;
  }

  it("reports false without review events and rejects A's duplicate atomically", async () => {
    const number = await createIssue();
    expect(
      (await stored(number)).events.filter(
        (event) => event.type === "spec_review",
      ),
    ).toEqual([]);
    await viewers(number, false, false, 1, "unreviewed");
    await accepted(number, a, "approve", 1, true);
    await viewers(number, true, false, 1, "approved");
    const before = await stored(number);
    expect(before.comments).toHaveLength(2);
    expect(before.issue.specUnresolvedComments).toBe(1);
    await duplicate(number);
    await viewers(number, true, false, 1, "approved");
  });

  it("keeps A and B approvals independently when either actor is the latest reviewer", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    await viewers(number, true, false, 1, "approved");
    await accepted(number, b, "approve");
    await viewers(number, true, true, 1, "approved");
    await duplicate(number, a);
    await duplicate(number, b);
  });

  it("derives personal state from the bearer token even with another user_id in the query", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    const res = await request(number, `/spec?user_id=${a.user.id}`, b);
    expect(res.status).toBe(200);
    expect((await json(res)).viewer_review).toEqual({
      user_id: b.user.id,
      approved_in_current_round: false,
    });
    await viewers(number, true, false, 1, "approved");
  });

  it.each(["self", "other"] as const)(
    "%s request_changes resets everyone's approvals, including older approved rounds",
    async (resetter) => {
      const number = await createIssue();
      await accepted(number, a, "approve");
      await accepted(number, b, "approve");
      await viewers(number, true, true);
      await accepted(number, resetter === "self" ? a : b, "request_changes");
      await viewers(number, false, false, 1, "changes_requested");
      // B's fresh approval cannot resurrect A's approval from the older round.
      await accepted(number, b, "approve");
      await viewers(number, false, true, 1, "approved");
      await accepted(number, a, "approve");
      await viewers(number, true, true, 1, "approved");
      await duplicate(number, a);
    },
  );

  it("allows consecutive request_changes by the same account and by another account", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    await accepted(number, a, "request_changes");
    await viewers(number, false, false, 1, "changes_requested");
    await accepted(number, a, "request_changes");
    await viewers(number, false, false, 1, "changes_requested");
    await accepted(number, b, "request_changes");
    await viewers(number, false, false, 1, "changes_requested");
    const rows = (await stored(number)).events.filter(
      (event) => event.type === "spec_review",
    );
    expect(rows.map((event) => event.payload)).toEqual([
      { version: 1, verdict: "approve", comment_id: null, annotation_count: 0 },
      ...Array.from({ length: 3 }, () => ({
        version: 1,
        verdict: "request_changes",
        comment_id: null,
        annotation_count: 0,
      })),
    ]);
    await accepted(number, a, "approve");
    await viewers(number, true, false, 1, "approved");
  });

  it.each(["self", "other", "pusher"] as const)(
    "%s comments never reset an approval or erase a request_changes boundary",
    async (commenter) => {
      const number = await createIssue();
      const who = commenter === "self" ? a : commenter === "other" ? b : p;
      await accepted(number, a, "approve");
      await accepted(number, who, "comment", 1, true);
      await viewers(number, true, false, 1, "approved");
      await duplicate(number);
      await accepted(number, b, "request_changes");
      await viewers(number, false, false, 1, "changes_requested");
      await accepted(number, who, "comment", 1, true);
      await viewers(number, false, false, 1, "changes_requested");
      await accepted(number, a, "approve");
      await viewers(number, true, false, 1, "approved");
    },
  );

  it("starts a fresh version without carrying approvals or old-version resets into it", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    await accepted(number, b, "approve");
    await viewers(number, true, true);
    await push(number, 2);
    await viewers(number, false, false, 2, "unreviewed");
    await accepted(number, a, "approve", 2);
    await viewers(number, true, false, 2, "approved");
    // A newer storage id for v1 must not reset v2 or mark B approved on v2.
    await eventFixture(number, b, "request_changes", 1);
    await viewers(number, true, false, 2, "approved");
    await duplicate(number, a, 2);
    await eventFixture(number, b, "approve", 1);
    await viewers(number, true, false, 2, "approved");
    await accepted(number, b, "approve", 2);
    await viewers(number, true, true, 2, "approved");
  });

  it("ignores a later old-version reset even when this actor never approved that old version", async () => {
    const number = await createIssue();
    await push(number, 2);
    await accepted(number, a, "approve", 2);
    await eventFixture(number, b, "request_changes", 1);
    await viewers(number, true, false, 2, "approved");
    await duplicate(number, a, 2);
  });

  it("does not leak another issue's approvals or request_changes at the same version", async () => {
    const first = await createIssue();
    const second = await createIssue();
    await accepted(first, a, "approve");
    await viewers(first, true, false);
    await viewers(second, false, false, 1, "unreviewed");
    await accepted(second, a, "approve");
    await accepted(second, b, "request_changes");
    await viewers(second, false, false, 1, "changes_requested");
    await viewers(first, true, false, 1, "approved");
    await duplicate(first);
    await accepted(second, a, "approve");
    await viewers(second, true, false);
    await accepted(first, b, "request_changes");
    await viewers(first, false, false, 1, "changes_requested");
    await viewers(second, true, false, 1, "approved");
    await duplicate(second);
  });

  it("ignores another issue's later reset without needing an approval on that issue", async () => {
    const first = await createIssue();
    const second = await createIssue();
    await accepted(first, a, "approve");
    await accepted(second, b, "request_changes");
    await viewers(first, true, false, 1, "approved");
    await duplicate(first);
  });

  it.each(["approve", "request_changes"] as const)(
    "uses event ids when the newest stored event is %s but timestamps run backwards",
    async (latest) => {
      const number = await createIssue();
      const earlier = await eventFixture(
        number,
        a,
        latest === "approve" ? "request_changes" : "approve",
        1,
        new Date("2040-01-01T00:00:00.000Z"),
      );
      const later = await eventFixture(
        number,
        latest === "approve" ? a : b,
        latest,
        1,
      );
      expect(later.id).toBeGreaterThan(earlier.id);
      expect(later.createdAt.getTime()).toBeLessThan(
        earlier.createdAt.getTime(),
      );
      await viewers(number, latest === "approve", false);
      if (latest === "approve") {
        await duplicate(number);
      } else {
        await accepted(number, a, "approve");
        await viewers(number, true, false, 1, "approved");
        await duplicate(number);
      }
    },
  );

  it("ignores a newer approval by another actor after A's older round was reset", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    await accepted(number, b, "request_changes");
    await accepted(number, b, "approve");
    await viewers(number, false, true, 1, "approved");
    await accepted(number, a, "approve");
    await viewers(number, true, true, 1, "approved");
  });

  it.each(["approve", "request_changes"] as const)(
    "keeps the pusher's %s forbidden ahead of withdrawn and duplicate diagnostics",
    async (verdict) => {
      const number = await createIssue();
      // Model imported history: HTTP itself correctly forbids this approval.
      await eventFixture(number, p, "approve", 1);
      await viewers(number, false, false, 1, "unreviewed", true);
      await rejected(
        number,
        p,
        fullReview(1, verdict),
        403,
        "pushed by this account",
      );
      await withdraw(number);
      await rejected(
        number,
        p,
        fullReview(1, verdict),
        403,
        "pushed by this account",
      );
      await viewers(number, false, false, 1, "withdrawn", true);
    },
  );

  it.each(["approve", "request_changes"] as const)(
    "keeps withdrawn ahead of duplicate and anchor diagnostics for %s",
    async (verdict) => {
      const number = await createIssue();
      await withdraw(number);
      // HTTP cannot withdraw an approved spec. Seed imported approval history
      // after a legal withdrawal to make both rejection guards applicable.
      await eventFixture(number, a, "approve", 1);
      await viewers(number, true, false, 1, "withdrawn");
      await rejected(number, a, fullReview(1, verdict), 409, "v1 is withdrawn");
      await rejected(
        number,
        a,
        {
          ...fullReview(1, verdict),
          comments: [annotation(1, "missing.md")],
        },
        409,
        "v1 is withdrawn",
      );
      await accepted(number, a, "comment", 1, true);
      await accepted(number, p, "comment", 1, true);
      await viewers(number, true, false, 1, "withdrawn");
      await rejected(number, a, fullReview(), 409, "v1 is withdrawn");
    },
  );

  it("keeps the version guard ahead of pusher, withdrawn and duplicate diagnostics", async () => {
    const number = await createIssue();
    await push(number, 2);
    await withdraw(number, 2);
    // Imported history makes every guard applicable while preserving the
    // withdrawn status; a real approval would make HTTP withdrawal illegal.
    await eventFixture(number, a, "approve", 2);
    await eventFixture(number, p, "approve", 2);
    await viewers(number, true, false, 2, "withdrawn", true);
    for (const who of [p, a, b]) {
      for (const verdict of [
        "approve",
        "request_changes",
        "comment",
      ] as const) {
        await rejected(
          number,
          who,
          fullReview(1, verdict),
          409,
          "moved to v2 while you were reviewing v1",
        );
      }
    }
    await viewers(number, true, false, 2, "withdrawn", true);
  });

  it("rejects a duplicate before validating its nonexistent anchor path", async () => {
    const number = await createIssue();
    await accepted(number, a, "approve");
    await rejected(
      number,
      a,
      {
        ...fullReview(),
        comments: [annotation(1, "missing.md")],
      },
      409,
      "already approved v1",
    );
    await viewers(number, true, false, 1, "approved");
  });
});
