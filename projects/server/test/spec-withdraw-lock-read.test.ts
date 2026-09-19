import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { issues } from "../src/db/project-schema.ts";
import {
  pushSpec,
  submitSpecReview,
  withdrawSpec,
} from "../src/services/spec.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const files = [{ path: "design.md", body: "Original proposal.\n" }];

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// These barriers deliberately pause after loadIssue, before opening a
// transaction. They prove state is re-read, without claiming PGlite can
// distinguish row locking from its own single-connection serialization.
describe.each(PLACEMENTS)("spec withdrawal lock-read (%s)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let actor: UserRow;
  let reviewer: UserRow;
  let projectId: number;
  const slug = `withdraw-lock-${placement}`;
  const headers = () => ({ cookie, "content-type": "application/json" });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    const response = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Lock-read" }),
    });
    expect(response.status).toBe(201);
    projectId = (await json(response)).id;
    const author = await addUserWithToken(t.ctx, `lock-author-${placement}`);
    const other = await addUserWithToken(t.ctx, `lock-reviewer-${placement}`);
    actor = author.user;
    reviewer = other.user;
    for (const user of [actor, reviewer]) {
      expect(
        (
          await t.app.request(`/api/projects/${slug}/members/${user.id}`, {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify({ role: "writer" }),
          })
        ).status,
      ).toBe(204);
    }
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  async function createSpec() {
    const response = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Stale state" }),
    });
    expect(response.status).toBe(201);
    const issue = await json(response);
    await pushSpec(t.ctx, actor, slug, issue.number, { files });
    return issue as { id: number; number: number };
  }

  async function pauseBeforeTransaction<T>(start: () => Promise<T>) {
    const db = await t.ctx.router.forProject({ id: projectId, slug });
    const original = db.transaction.bind(db);
    const entered = barrier();
    const release = barrier();
    const spy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce(async (callback, config) => {
        entered.resolve();
        await release.promise;
        return original(callback, config);
      });
    // Capture rejection immediately; an expected conflict must never become an
    // unhandled rejection while another writer is being committed.
    const pending = start().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await entered.promise;
    return {
      db,
      pending,
      resume: release.resolve,
      restore: () => spy.mockRestore(),
    };
  }

  it.each(["approve", "request_changes"] as const)(
    "a review paused before its transaction rejects %s after withdrawal commits",
    async (verdict) => {
      const issue = await createSpec();
      const paused = await pauseBeforeTransaction(() =>
        submitSpecReview(t.ctx, reviewer, slug, issue.number, {
          version: 1,
          verdict,
          body: "must not insert",
          comments: [
            {
              anchor: { version: 1, path: "design.md" },
              body: "nor this annotation",
            },
          ],
        }),
      );
      try {
        await withdrawSpec(t.ctx, actor, slug, issue.number, { version: 1 });
        paused.resume();
        expect((await paused.pending).error).toMatchObject({
          code: "conflict",
        });
        const [row] = await paused.db
          .select()
          .from(issues)
          .where(eq(issues.id, issue.id));
        expect(row).toMatchObject({
          specReviewStatus: "withdrawn",
          specUnresolvedComments: 0,
        });
      } finally {
        paused.resume();
        await paused.pending;
        paused.restore();
      }
    },
  );

  it("a withdrawal paused before its transaction rejects the newly committed approval", async () => {
    const issue = await createSpec();
    const paused = await pauseBeforeTransaction(() =>
      withdrawSpec(t.ctx, actor, slug, issue.number, { version: 1 }),
    );
    try {
      await submitSpecReview(t.ctx, reviewer, slug, issue.number, {
        version: 1,
        verdict: "approve",
        comments: [],
      });
      paused.resume();
      expect((await paused.pending).error).toMatchObject({ code: "conflict" });
      const [row] = await paused.db
        .select()
        .from(issues)
        .where(eq(issues.id, issue.id));
      expect(row?.specReviewStatus).toBe("approved");
    } finally {
      paused.resume();
      await paused.pending;
      paused.restore();
    }
  });

  it("an identical push paused before its transaction sees withdrawal and resubmits", async () => {
    const issue = await createSpec();
    const paused = await pauseBeforeTransaction(() =>
      pushSpec(t.ctx, actor, slug, issue.number, { files }),
    );
    try {
      await withdrawSpec(t.ctx, actor, slug, issue.number, { version: 1 });
      paused.resume();
      const result = await paused.pending;
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({
        version: 2,
        unchanged: false,
        added: [],
        changed: [],
        removed: [],
      });
    } finally {
      paused.resume();
      await paused.pending;
      paused.restore();
    }
  });

  it("withdrawal rechecks the moving gate after the unlocked issue read", async () => {
    const issue = await createSpec();
    const paused = await pauseBeforeTransaction(() =>
      withdrawSpec(t.ctx, actor, slug, issue.number, { version: 1 }),
    );
    try {
      await paused.db
        .update(issues)
        .set({ movingSince: new Date() })
        .where(eq(issues.id, issue.id));
      paused.resume();
      expect((await paused.pending).error).toMatchObject({
        code: "issue_moving",
      });
    } finally {
      paused.resume();
      await paused.pending;
      paused.restore();
    }
  });
});
