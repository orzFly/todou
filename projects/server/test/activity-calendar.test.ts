import {
  ActivityCalendarResponse,
  type ActivityCard,
  type Status,
} from "@todou/shared";
import { and, desc, eq, gt, max, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  comments,
  issueEvents,
  issues,
  revisions,
} from "../src/db/project-schema.ts";
import { issueMoves, projects, users } from "../src/db/system-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

const DAY = "2026-09-18";
const NEXT_DAY = "2026-09-19";
const TZ = "Asia/Shanghai";
const NOW = "2026-09-19T12:00:00.000Z";
const BORN = "2010-01-01T00:00:00.000Z";
const BASE = "2026-09-01T00:00:00.000000Z";
const F_AT = "2026-09-18T15:59:59.999999Z";
const G_AT = "2026-09-18T16:00:00.000000Z";
const SECRET = "calendar-body-must-never-leak";
const QUESTION = {
  type: "questions",
  questions: [
    {
      key: "choice",
      question: SECRET,
      options: [{ label: "yes" }, { label: "no" }],
    },
  ],
};
const SPEC_FILES = [{ path: "design.md", body: `${SECRET}\nsecond line\n` }];

type Who = Record<string, string>;
type Actor = Awaited<ReturnType<typeof addUserWithToken>>;
type Db = Awaited<ReturnType<TestApp["ctx"]["router"]["forProject"]>>;
type Project = { id: number; slug: string; name: string; db: Db };
type Card = { id: number; number: number; project: Project };
type Letter = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K";

// This suite deliberately never imports the evidence classifier, date helpers,
// aggregation service or cursor implementation to compute expected results.
// A-K and their hand oracle come from brainstorm.md:131-147, unchanged.
describe.each(PLACEMENTS)(
  "activity calendar original A-K oracle (%s)",
  (placement) => {
    let t: TestApp;
    let admin: Who;
    let viewer: Actor;
    let alice: Actor;
    let bob: Actor;
    let bot: Actor;
    let P: Project;
    let Q: Project;
    let R: Project;
    let closed: Status;
    let open: Status;
    let cComment: number;
    let kQuestion: number;
    let kAnnotation: number;
    const cards = {} as Record<Letter, Card>;

    async function request<T>(
      path: string,
      who: Who,
      method = "GET",
      body?: unknown,
      status = 200,
    ): Promise<T> {
      const response = await t.app.request(`/api${path}`, {
        method,
        headers: {
          ...who,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(
        response.status,
        `${method} ${path}: ${await response.clone().text()}`,
      ).toBe(status);
      return status === 204
        ? (undefined as T)
        : (response.json() as Promise<T>);
    }

    const pathOf = (card: Card) =>
      `/projects/${card.project.slug}/issues/${card.number}`;
    const projectPath = (project: Project) =>
      `/projects/${project.slug}/insights/activity`;
    const personPath = (actor: Actor, byId = false) =>
      `/users/${byId ? actor.user.id : actor.user.login}/activity`;
    const identity = (card: Card) => `${card.project.id}/${card.id}`;
    const itemIdentity = (card: ActivityCard) =>
      `${card.project.id}/${card.issue_id}`;

    async function member(project: Project, actor: Actor, role: string) {
      await request(
        `/projects/${project.slug}/members/${actor.user.id}`,
        admin,
        "PUT",
        { role },
        204,
      );
    }

    async function createProject(slug: string, name: string): Promise<Project> {
      const row = await request<{ id: number }>(
        "/projects",
        admin,
        "POST",
        { slug, name },
        201,
      );
      const db = await t.ctx.router.forProject({
        id: row.id,
        slug,
        database_url: null,
      });
      return { id: row.id, slug, name, db };
    }

    async function createCard(
      project: Project,
      title: string,
      body = SECRET,
    ): Promise<Card> {
      const row = await request<{ id: number; number: number }>(
        `/projects/${project.slug}/issues`,
        alice.headers,
        "POST",
        { title, body },
        201,
      );
      return { ...row, project };
    }

    const patch = (card: Card, body: unknown, who = alice.headers) =>
      request(pathOf(card), who, "PATCH", body);
    const say = (
      card: Card,
      body: string,
      who = alice.headers,
      component?: unknown,
    ) =>
      request<{ id: number }>(
        `${pathOf(card)}/comments`,
        who,
        "POST",
        { body, component },
        201,
      );
    const editComment = (
      card: Card,
      id: number,
      body: string,
      who = alice.headers,
    ) => request(`${pathOf(card)}/comments/${id}`, who, "PATCH", { body });
    const hide = (card: Card, ids: number[]) =>
      request(`${pathOf(card)}/comments/hide`, alice.headers, "POST", {
        comment_ids: ids,
        hidden: true,
      });

    /**
     * Exercise the real writer first, then retime only its newly inserted rows.
     * Parameterized timestamptz casts preserve six digits; JS Date cannot express
     * F's final microsecond. Scope includes both ends of automatic cross-card work.
     */
    async function at<T>(
      stamp: string,
      action: () => Promise<T>,
      scope = [P, Q, R],
    ): Promise<T> {
      const marks = [];
      for (const project of scope) {
        for (const table of [comments, issueEvents, revisions]) {
          const [row] = await project.db
            .select({ id: max(table.id) })
            .from(table)
            .where(eq(table.projectId, project.id));
          marks.push({ project, table, id: row?.id ?? 0 });
        }
      }
      const result = await action();
      for (const { project, table, id } of marks) {
        await project.db
          .update(table)
          .set({ createdAt: sql`${stamp}::timestamptz` })
          .where(and(eq(table.projectId, project.id), gt(table.id, id)));
      }
      return result;
    }

    async function calendar(
      path: string,
      day: string | null = DAY,
      limit = 100,
      after?: string,
      tz = TZ,
      year = 2026,
    ) {
      const params = new URLSearchParams({
        from: `${year}-01-01`,
        to: `${year + 1}-01-01`,
        tz,
        limit: String(limit),
      });
      if (day !== null) params.set("day", day);
      if (after !== undefined) params.set("after", after);
      const response = await t.app.request(`/api${path}?${params}`, {
        headers: viewer.headers,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const raw: unknown = await response.json();
      // Validate the wire contract, but inspect the ORIGINAL object: Zod strips
      // unknown keys and would otherwise hide accidental extra body fields.
      expect(ActivityCalendarResponse.safeParse(raw).success).toBe(true);
      const body = raw as ActivityCalendarResponse;
      expect(body.from).toBe(`${year}-01-01`);
      expect(body.to).toBe(`${year + 1}-01-01`);
      expect(body.timezone).toBe(tz);
      expect(Date.parse(body.read_started_at)).toBeLessThanOrEqual(
        Date.parse(body.read_finished_at),
      );
      expect(JSON.stringify(raw)).not.toContain(SECRET);
      expect(JSON.stringify(raw)).not.toContain(R.slug);
      expect(JSON.stringify(raw)).not.toContain(R.name);
      for (const item of body.selection?.items ?? []) {
        expect(Object.keys(item).sort()).toEqual([
          "issue_id",
          "last_active_at",
          "number",
          "project",
          "status",
          "title",
          "url",
        ]);
        expect(Object.keys(item.project).sort()).toEqual([
          "id",
          "issue_prefix",
          "name",
          "slug",
        ]);
        expect(item.url).toBe(
          `/projects/${item.project.slug}/issues/${item.number}`,
        );
        expect(item.project.id).not.toBe(R.id);
      }
      return body;
    }

    /** Every page, its day cell and the exhausted unique identities face the oracle. */
    async function exhaust(
      path: string,
      expected: Card[],
      day = DAY,
      limit = 100,
      tz = TZ,
    ) {
      const items: ActivityCard[] = [];
      const cursors = new Set<string>();
      let after: string | undefined;
      let firstDays: ActivityCalendarResponse["days"] | undefined;
      for (let page = 0; page <= expected.length; page++) {
        const body = await calendar(path, day, limit, after, tz);
        expect(body.days).toHaveLength(365);
        expect(body.days.find((cell) => cell.date === day)).toEqual({
          date: day,
          state: "recorded",
          count: expected.length,
        });
        if (firstDays === undefined) firstDays = body.days;
        else expect(body.days).toEqual(firstDays);
        const selected = body.selection;
        expect(selected).not.toBeNull();
        if (!selected) throw new Error("selected day was lost");
        expect(selected.date).toBe(day);
        expect(selected.total).toBe(expected.length);
        expect(selected.items).toHaveLength(
          Math.min(limit, expected.length - items.length),
        );
        items.push(...selected.items);
        expect(selected.has_more).toBe(items.length < expected.length);
        if (!selected.has_more) {
          expect(selected.next_cursor).toBeNull();
          expect(items.map(itemIdentity)).toEqual(expected.map(identity));
          expect(new Set(items.map(itemIdentity)).size).toBe(expected.length);
          return items;
        }
        expect(typeof selected.next_cursor).toBe("string");
        if (!selected.next_cursor) throw new Error("missing continuation");
        expect(cursors.has(selected.next_cursor)).toBe(false);
        cursors.add(selected.next_cursor);
        after = selected.next_cursor;
      }
      throw new Error(
        "pagination did not terminate at the hand-calculated cardinality",
      );
    }

    beforeAll(async () => {
      // Only Date is frozen: database/HTTP scheduling and timeout timers stay real.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(NOW));
      t = await makeTestApp(placement);
      admin = { cookie: await t.login() };
      viewer = await addUserWithToken(t.ctx, "viewer-v");
      alice = await addUserWithToken(t.ctx, "alice");
      bob = await addUserWithToken(t.ctx, "bob");
      bot = await addUserWithToken(t.ctx, "bot", {
        kind: "machine",
        ownerId: alice.user.id,
      });
      P = await createProject("calendar-p", "P");
      Q = await createProject("calendar-q", "Q");
      R = await createProject(
        "calendar-r-private",
        "R private title must not leak",
      );
      for (const project of [P, Q, R]) {
        await member(project, alice, "admin");
        await member(project, bob, "writer");
      }
      for (const project of [P, Q]) await member(project, viewer, "reader");
      await member(P, bot, "writer");

      // P and Q are consecutive projects and occupy different buckets as well as
      // different dedicated databases. Create A/C FIRST in their respective DBs.
      cards.A = await createCard(P, "A");
      cards.C = await createCard(Q, "C");
      cards.D = await createCard(R, "D");
      for (const letter of ["B", "E", "F", "G", "H", "I", "K"] as const) {
        cards[letter] = await createCard(P, letter);
      }
      const sourceJ = await createCard(Q, "J");
      cComment = (await say(cards.C, `${SECRET}: Bob's original`, bob.headers))
        .id;
      const dQuestion = (await say(cards.D, SECRET, bob.headers, QUESTION)).id;
      kQuestion = (await say(cards.K, SECRET, bob.headers, QUESTION)).id;
      await request(`${pathOf(cards.K)}/spec/push`, bob.headers, "POST", {
        files: SPEC_FILES,
      });
      const review = await request<{ comment_ids: number[] }>(
        `${pathOf(cards.K)}/spec/reviews`,
        alice.headers,
        "POST",
        {
          version: 1,
          verdict: "request_changes",
          comments: [
            {
              anchor: {
                path: "design.md",
                version: 1,
                line_start: 1,
                line_end: 1,
              },
              body: SECRET,
            },
          ],
        },
        201,
      );
      kAnnotation = review.comment_ids[0] as number;
      expect(kAnnotation).toBeGreaterThan(0);
      await request(`${pathOf(cards.E)}/blocked-by`, alice.headers, "POST", {
        ref: `#${cards.A.number}`,
      });
      // H holds a canonical reference. Re-saving its token form must normalize to
      // the existing body, not become a content revision or fresh activity.
      await patch(cards.H, { body: `${SECRET} #${cards.E.number}` });
      const statuses = await request<Status[]>(
        `/projects/${P.slug}/statuses`,
        admin,
      );
      const closedStatus = statuses.find(
        (status) => status.category === "closed",
      );
      const openStatus = statuses.find((status) => status.category === "open");
      if (!closedStatus)
        throw new Error("fixture requires a seeded closed status");
      closed = closedStatus;
      if (!openStatus) throw new Error("fixture requires a seeded open status");
      open = openStatus;

      await t.ctx.router
        .system()
        .update(users)
        .set({ createdAt: new Date(BORN) });
      await t.ctx.router
        .system()
        .update(projects)
        .set({ createdAt: new Date(BORN) });
      for (const project of [P, Q, R]) {
        await project.db
          .update(issues)
          .set({ createdAt: new Date(BORN), updatedAt: new Date(BASE) })
          .where(eq(issues.projectId, project.id));
        for (const table of [comments, issueEvents, revisions]) {
          await project.db
            .update(table)
            .set({ createdAt: sql`${BASE}::timestamptz` })
            .where(eq(table.projectId, project.id));
        }
      }

      await at("2026-09-18T01:00:00.000000Z", () =>
        say(cards.A, `${SECRET}: first #${cards.E.number}`),
      );
      await at("2026-09-18T02:00:00.000000Z", () =>
        say(cards.A, `${SECRET}: second`),
      );
      await at("2026-09-18T03:00:00.000000Z", () =>
        patch(cards.A, { body: `${SECRET}: edited` }),
      );
      // Also causes E's automatic block_cleared, which must never count E.
      await at("2026-09-18T04:00:00.000000Z", () =>
        patch(cards.A, { status_id: closed.id }, bob.headers),
      );
      // B ties A in the PROJECT order, testing the issue-id tiebreak explicitly.
      await at("2026-09-18T04:00:00.000000Z", async () => {
        const form = new FormData();
        form.set(
          "file",
          new File([SECRET], "bot-proof.txt", { type: "text/plain" }),
        );
        form.set("issue_number", String(cards.B.number));
        const response = await t.app.request(
          `/api/projects/${P.slug}/attachments`,
          { method: "POST", headers: bot.headers, body: form },
        );
        expect(response.status, await response.clone().text()).toBe(201);
      });
      // C ties ALICE's A revision; project identity breaks this tie across DBs.
      await at("2026-09-18T03:00:00.000000Z", () =>
        editComment(cards.C, cComment, `${SECRET}: Alice edited Bob`),
      );
      await at("2026-09-18T05:00:00.000000Z", () =>
        request(
          `${pathOf(cards.D)}/comments/${dQuestion}/answers`,
          alice.headers,
          "POST",
          {
            answers: [{ key: "choice", selected: [0] }],
          },
          201,
        ),
      );
      await request(
        `${pathOf(cards.E)}/read`,
        alice.headers,
        "PUT",
        { up_to: "2026-09-18T06:00:00.000Z" },
        204,
      );
      await at(F_AT, () => patch(cards.F, { body: `${SECRET}: F revision` }));
      await at(G_AT, () => say(cards.G, `${SECRET}: G midnight`));
      await at("2026-09-18T07:00:00.000000Z", () =>
        patch(cards.H, { body: `${SECRET} #${cards.E.number}` }),
      );
      await P.db
        .update(issues)
        .set({ updatedAt: new Date("2026-09-18T07:00:00Z") })
        .where(eq(issues.id, cards.H.id));
      const label = await request<{ id: number }>(
        `/projects/${P.slug}/labels`,
        admin,
        "POST",
        { name: "oracle", color: "#123456" },
        201,
      );
      await at("2026-09-18T08:00:00.000000Z", () =>
        patch(cards.I, { label_ids: [label.id] }),
      );
      await at("2026-09-18T09:00:00.000000Z", () =>
        request(pathOf(cards.I), alice.headers, "DELETE", undefined, 204),
      );
      await at("2026-09-18T10:00:00.000000Z", async () => {
        await say(sourceJ, `${SECRET}: imported comment`);
        await patch(sourceJ, { body: `${SECRET}: imported revision` });
      });
      // Do NOT retime the whole move: its copied comments/revisions must retain
      // their original occurrence times and the writer's real import manifest.
      const moved = await request<{ moved_to: { number: number } }>(
        `${pathOf(sourceJ)}/move`,
        alice.headers,
        "POST",
        { to_project: P.slug },
      );
      const targetJ = await request<{ id: number; number: number }>(
        `/projects/${P.slug}/issues/${moved.moved_to.number}`,
        alice.headers,
      );
      cards.J = { ...targetJ, project: P };
      for (const project of [P, Q]) {
        for (const type of ["moved_in", "moved_out"] as const) {
          await project.db
            .update(issueEvents)
            .set({ createdAt: sql`'2026-09-18T11:00:00Z'::timestamptz` })
            .where(
              and(
                eq(issueEvents.projectId, project.id),
                eq(issueEvents.type, type),
              ),
            );
        }
      }
      await at("2026-09-18T12:00:00.000000Z", () =>
        hide(cards.K, [kQuestion, kAnnotation]),
      );
    }, 120_000);

    afterAll(async () => {
      try {
        await t?.cleanup();
      } finally {
        vi.useRealTimers();
      }
    });

    it("pins the adversarial fixture, real writers, and cross-database identity collision", async () => {
      expect(viewer.user.isInstanceAdmin).toBe(false);
      expect(bot.user.ownerId).toBe(alice.user.id);
      expect(cards.A.number).toBe(1);
      expect(cards.C.number).toBe(1);
      if (placement !== "shared") {
        expect(P.db).not.toBe(Q.db);
        expect(cards.A.id).toBe(1);
        expect(cards.C.id).toBe(1);
      } else {
        expect(P.db).toBe(Q.db);
        expect(cards.A.id).not.toBe(cards.C.id);
      }
      const [original] = await Q.db
        .select()
        .from(comments)
        .where(eq(comments.id, cComment));
      expect(original?.authorId).toBe(bob.user.id);
      const cEdits = await Q.db
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.projectId, Q.id),
            eq(revisions.subjectType, "comment"),
            eq(revisions.subjectId, cComment),
          ),
        );
      expect(cEdits).toHaveLength(1);
      expect(cEdits[0]?.actorId).toBe(alice.user.id);
      const eEvents = await P.db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, cards.E.id));
      expect(eEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining(["referenced", "block_cleared"]),
      );
      const kEvents = await P.db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, cards.K.id));
      expect(kEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "question_answered",
            payload: expect.objectContaining({ via: "hide" }),
          }),
          expect.objectContaining({
            type: "spec_comments_resolved",
            payload: expect.objectContaining({ via: "hide" }),
          }),
        ]),
      );
      const imported = await P.db
        .select()
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, cards.J.id),
            eq(issueEvents.type, "moved_in"),
          ),
        );
      expect(imported).toHaveLength(1);
      expect(imported[0]?.payload).toMatchObject({
        activity_imported_max_ids: { v: 1 },
      });
      expect(
        await P.db
          .select()
          .from(comments)
          .where(eq(comments.issueId, cards.J.id)),
      ).toHaveLength(1);
      expect(
        await P.db
          .select()
          .from(revisions)
          .where(
            and(
              eq(revisions.projectId, P.id),
              eq(revisions.subjectType, "issue_body"),
              eq(revisions.subjectId, cards.J.id),
            ),
          ),
      ).toHaveLength(1);
      const hRevisions = await P.db
        .select()
        .from(revisions)
        .where(
          and(
            eq(revisions.projectId, P.id),
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, cards.H.id),
          ),
        );
      expect(hRevisions).toHaveLength(1); // only baseline canonicalization, no D edit
      expect(hRevisions[0]?.createdAt.toISOString()).toBe(
        "2026-09-01T00:00:00.000Z",
      );
    });

    it.each([1, 2, 100])(
      "exhausts the independent P/alice/bot/bob day oracles at limit=%i",
      async (limit) => {
        const p = await exhaust(
          projectPath(P),
          [cards.F, cards.A, cards.B],
          DAY,
          limit,
        );
        expect(p.map((item) => item.last_active_at)).toEqual([
          F_AT,
          "2026-09-18T04:00:00.000000Z",
          "2026-09-18T04:00:00.000000Z",
        ]);
        const a = await exhaust(
          personPath(alice),
          [cards.F, cards.A, cards.C],
          DAY,
          limit,
        );
        expect(a.map((item) => item.last_active_at)).toEqual([
          F_AT,
          "2026-09-18T03:00:00.000000Z",
          "2026-09-18T03:00:00.000000Z",
        ]);
        await exhaust(personPath(bot), [cards.B], DAY, limit);
        await exhaust(personPath(bob), [cards.A], DAY, limit);
        await exhaust(projectPath(Q), [cards.C], DAY, limit);
        await exhaust(projectPath(P), [cards.G], NEXT_DAY, limit);
        await exhaust(personPath(alice), [cards.G], NEXT_DAY, limit);
        await exhaust(personPath(bot), [], NEXT_DAY, limit);
        await exhaust(projectPath(P), [], "2026-09-17", limit);
        await exhaust(personPath(alice), [], "2026-09-17", limit);
      },
    );

    it("separates F/G at Shanghai midnight without losing microseconds; UTC includes both", async () => {
      const shanghai = await exhaust(personPath(alice, true), [
        cards.F,
        cards.A,
        cards.C,
      ]);
      expect(shanghai[0]?.last_active_at).toBe(F_AT);
      const tomorrow = await exhaust(personPath(alice), [cards.G], NEXT_DAY);
      expect(tomorrow[0]?.last_active_at).toBe(G_AT);
      await exhaust(
        personPath(alice),
        [cards.G, cards.F, cards.A, cards.C],
        DAY,
        1,
        "UTC",
      );
      await exhaust(
        projectPath(P),
        [cards.G, cards.F, cards.A, cards.B],
        DAY,
        2,
        "UTC",
      );
      const canonical = await exhaust(`/projects/${P.id}/insights/activity`, [
        cards.F,
        cards.A,
        cards.B,
      ]);
      expect(canonical[1]).toMatchObject({
        project: { id: P.id, slug: P.slug, name: P.name, issue_prefix: null },
        number: cards.A.number,
        title: "A",
        status: closed,
        url: `/projects/${P.slug}/issues/${cards.A.number}`,
      });
    });

    it("keeps the selected day and cursor unchanged after new unreadable R evidence", async () => {
      const before = await calendar(personPath(alice), DAY, 1);
      await at("2026-09-18T15:59:59.999999Z", () =>
        say(cards.D, `${SECRET}: additional private activity`),
      );
      const after = await calendar(personPath(alice), DAY, 1);
      expect(after.days).toEqual(before.days);
      expect(after.selection).toEqual(before.selection);
      const cursor = before.selection?.next_cursor;
      expect(cursor).toBeTruthy();
      const continued = await calendar(
        personPath(alice),
        DAY,
        1,
        cursor ?? undefined,
      );
      expect(continued.selection?.items.map(itemIdentity)).toEqual([
        identity(cards.A),
      ]);
      await exhaust(personPath(alice), [cards.F, cards.A, cards.C]);
    });

    it("preserves D after a later A revision and displays the current title/status", async () => {
      const first = await calendar(personPath(alice), DAY, 1);
      await at("2026-09-19T02:00:00.000000Z", () =>
        patch(cards.A, {
          body: `${SECRET}: edited on a later day`,
          title: "A current title",
          status_id: open.id,
        }),
      );
      const result = await exhaust(personPath(alice), [
        cards.F,
        cards.A,
        cards.C,
      ]);
      expect(result[1]).toMatchObject({
        title: "A current title",
        status: open,
        last_active_at: "2026-09-18T03:00:00.000000Z",
      });
      const continued = await calendar(
        personPath(alice),
        DAY,
        1,
        first.selection?.next_cursor ?? undefined,
      );
      expect(continued.selection?.items[0]).toMatchObject({
        title: "A current title",
        issue_id: cards.A.id,
      });
      await exhaust(personPath(alice), [cards.A, cards.G], NEXT_DAY);
    });

    it.skipIf(placement !== "dedicated")(
      "restarts pagination when same-id evidence switches projects at unchanged counts and timestamps",
      async ({ onTestFinished }) => {
        // A separate subject keeps the expected set independent of the A-K oracle.
        // Dedicated databases allocate the same issue ID in both readable projects.
        const subject = await addUserWithToken(t.ctx, "identity-subject");
        const left = await createProject("identity-left", "Identity left");
        const right = await createProject("identity-right", "Identity right");
        for (const project of [left, right]) {
          await member(project, alice, "admin");
          await member(project, subject, "writer");
          await member(project, viewer, "reader");
          // Keep later A-K checks independent of these new readable projects.
          onTestFinished(async () => {
            await request(
              `/projects/${project.slug}/members/${viewer.user.id}`,
              admin,
              "DELETE",
              undefined,
              204,
            );
          });
        }
        await t.ctx.router
          .system()
          .update(users)
          .set({ createdAt: new Date(BORN) })
          .where(eq(users.id, subject.user.id));
        // Keep the anchor first in BOTH digest orders (project/issue and issue
        // only), so omitted project IDs cannot hide behind reordered hash input.
        const anchor = await createCard(left, "Stable first page");
        await createCard(right, "Unselected allocation anchor");
        const leftCard = await createCard(left, "Left twin");
        const rightCard = await createCard(right, "Right twin");
        expect(left.db).not.toBe(right.db);
        expect(left.id).toBeLessThan(right.id);
        expect(leftCard.id).toBe(rightCard.id);
        expect(anchor.id).toBeLessThan(leftCard.id);
        for (const project of [left, right]) {
          await project.db
            .update(issues)
            .set({ createdAt: new Date(BORN) })
            .where(eq(issues.projectId, project.id));
        }
        const selectedAt = "2026-09-18T10:00:00.123456Z";
        const leftComment = await at(
          selectedAt,
          () => say(leftCard, "Left evidence", subject.headers),
          [left],
        );
        const rightComment = await at(
          selectedAt,
          () => say(rightCard, "Right evidence", subject.headers),
          [right],
        );
        await at(F_AT, () => say(anchor, "Anchor evidence", subject.headers), [
          left,
        ]);
        const path = personPath(subject);
        // With both twins selected, neither counts nor pagination may collapse
        // the two permanent identities to their shared local issue ID.
        await exhaust(path, [anchor, leftCard, rightCard], DAY, 1);

        async function retime(card: Card, commentId: number, stamp: string) {
          const changed = await card.project.db
            .update(comments)
            .set({ createdAt: sql`${stamp}::timestamptz` })
            .where(
              and(
                eq(comments.projectId, card.project.id),
                eq(comments.issueId, card.id),
                eq(comments.id, commentId),
              ),
            )
            .returning({ id: comments.id });
          expect(changed).toEqual([{ id: commentId }]);
        }
        function cursorOf(body: ActivityCalendarResponse) {
          const raw = body.selection?.next_cursor;
          if (!raw) throw new Error("expected identity fixture continuation");
          // Inspect the server's wire envelope without reproducing its digest.
          const envelope = JSON.parse(
            Buffer.from(raw, "base64url").toString("utf8"),
          ) as { scope_hash: string; set_hash: string; last: unknown };
          return { raw, envelope };
        }
        await retime(rightCard, rightComment.id, BASE);
        for (const [source, destination, sourceComment, destinationComment] of [
          [leftCard, rightCard, leftComment.id, rightComment.id],
          [rightCard, leftCard, rightComment.id, leftComment.id],
        ] as const) {
          const beforeItems = await exhaust(path, [anchor, source]);
          expect(beforeItems.map((item) => item.last_active_at)).toEqual([
            F_AT,
            selectedAt,
          ]);
          const before = await calendar(path, DAY, 1);
          expect(before.selection?.items.map(itemIdentity)).toEqual([
            identity(anchor),
          ]);
          const cursor = cursorOf(before);
          const unchanged = await calendar(path, DAY, 1, cursor.raw);
          expect(unchanged.selection).toMatchObject({
            total: 2,
            has_more: false,
            next_cursor: null,
          });
          expect(unchanged.selection?.items.map(itemIdentity)).toEqual([
            identity(source),
          ]);

          // Alice's title edit changes the displayed card, but adds no evidence
          // to this subject's selected set. The original cursor must still work.
          const title = `${source.project.name} renamed`;
          await patch(source, { title });
          const renamed = await calendar(path, DAY, 1);
          expect(renamed.selection?.next_cursor).toBe(cursor.raw);
          const continued = await calendar(path, DAY, 1, cursor.raw);
          expect(continued.selection).toMatchObject({
            total: 2,
            has_more: false,
            next_cursor: null,
          });
          expect(continued.selection?.items).toEqual([
            expect.objectContaining({
              issue_id: source.id,
              project: expect.objectContaining({ id: source.project.id }),
              title,
              last_active_at: selectedAt,
            }),
          ]);

          // Swap which twin contributes evidence, keeping the first page, the
          // readable scope, the total and every selected timestamp unchanged.
          await retime(source, sourceComment, BASE);
          await retime(destination, destinationComment, selectedAt);
          const afterItems = await exhaust(path, [anchor, destination], DAY, 1);
          expect(
            afterItems.map((item) => [item.issue_id, item.last_active_at]),
          ).toEqual(
            beforeItems.map((item) => [item.issue_id, item.last_active_at]),
          );
          expect(afterItems.map(itemIdentity)).not.toEqual(
            beforeItems.map(itemIdentity),
          );
          const fresh = await calendar(path, DAY, 1);
          expect(fresh.days).toEqual(before.days);
          expect(fresh.selection?.total).toBe(2);
          expect(fresh.selection?.items).toEqual(before.selection?.items);
          const params = new URLSearchParams({
            from: "2026-01-01",
            to: "2027-01-01",
            tz: TZ,
            day: DAY,
            limit: "1",
            after: cursor.raw,
          });
          const conflict = await request<unknown>(
            `${path}?${params}`,
            viewer.headers,
            "GET",
            undefined,
            409,
          );
          expect(conflict).toMatchObject({
            error: {
              code: "conflict",
              details: { reason: "activity_changed", restart: true },
            },
          });
          const replacement = cursorOf(fresh);
          expect(replacement.envelope.scope_hash).toBe(
            cursor.envelope.scope_hash,
          );
          expect(replacement.envelope.last).toEqual(cursor.envelope.last);
          expect(replacement.envelope.set_hash).not.toBe(
            cursor.envelope.set_hash,
          );
        }
      },
      120_000,
    );

    it("restores I's old label evidence, but restoration adds no activity on its own day", async () => {
      const before = await calendar(personPath(alice), NEXT_DAY);
      await at("2026-09-19T06:00:00.000000Z", () =>
        request(`${pathOf(cards.I)}/restore`, alice.headers, "POST"),
      );
      try {
        for (const limit of [1, 2, 100]) {
          await exhaust(
            projectPath(P),
            [cards.F, cards.I, cards.A, cards.B],
            DAY,
            limit,
          );
          await exhaust(
            personPath(alice),
            [cards.F, cards.I, cards.A, cards.C],
            DAY,
            limit,
          );
        }
        const after = await calendar(personPath(alice), NEXT_DAY);
        expect(after.days.find((day) => day.date === NEXT_DAY)).toEqual(
          before.days.find((day) => day.date === NEXT_DAY),
        );
        expect(after.selection).toEqual(before.selection);
        await exhaust(projectPath(P), [cards.A, cards.G], NEXT_DAY);
        const restored = await P.db
          .select()
          .from(issueEvents)
          .where(
            and(
              eq(issueEvents.issueId, cards.I.id),
              eq(issueEvents.type, "restored"),
            ),
          );
        expect(restored).toHaveLength(1);
      } finally {
        await at("2026-09-19T07:00:00.000000Z", () =>
          request(pathOf(cards.I), alice.headers, "DELETE", undefined, 204),
        );
      }
    });

    it("classifies isolated real writes, no-ops, explicit decline, resolution and surviving evidence after comment deletion", async () => {
      const W = await createProject("calendar-writers", "Writer integrations");
      await member(W, viewer, "reader");
      await member(W, alice, "admin");
      await member(W, bob, "writer");
      await t.ctx.router
        .system()
        .update(projects)
        .set({ createdAt: new Date(BORN) })
        .where(eq(projects.id, W.id));
      const bodyCard = await at(BASE, () => createCard(W, "body only"), [W]);
      const commentCard = await at(BASE, () => createCard(W, "comment only"), [
        W,
      ]);
      const noopCard = await at(
        BASE,
        () =>
          createCard(W, "normalized no-op", `${SECRET} #${bodyCard.number}`),
        [W],
      );
      const specCard = await at(BASE, () => createCard(W, "spec"), [W]);
      const answerCard = await at(
        BASE,
        () => createCard(W, "explicit decline"),
        [W],
      );
      const blocked = await at(BASE, () => createCard(W, "blocked"), [W]);
      const blocker = await at(BASE, () => createCard(W, "blocker"), [W]);
      await W.db
        .update(issues)
        .set({ createdAt: new Date(BORN) })
        .where(eq(issues.projectId, W.id));
      const oldComment = await at(
        BASE,
        () => say(commentCard, `${SECRET} #${bodyCard.number}`, bob.headers),
        [W],
      );
      const question = await at(
        BASE,
        () => say(answerCard, SECRET, bob.headers, QUESTION),
        [W],
      );
      await at(
        BASE,
        () =>
          request(`${pathOf(specCard)}/spec/push`, bob.headers, "POST", {
            files: SPEC_FILES,
          }),
        [W],
      );

      await at("2026-09-02T01:00:00.000000Z", async () => {
        await patch(noopCard, { body: `${SECRET} #${bodyCard.number}` });
        await editComment(
          commentCard,
          oldComment.id,
          `${SECRET} #${bodyCard.number}`,
        );
        const same = await request<{ unchanged: boolean; version: number }>(
          `${pathOf(specCard)}/spec/push`,
          alice.headers,
          "POST",
          { files: SPEC_FILES },
        );
        expect(same).toMatchObject({ unchanged: true, version: 1 });
      }, [W]);
      await exhaust(projectPath(W), [], "2026-09-02");
      await exhaust(personPath(alice), [], "2026-09-02");
      expect(
        await W.db
          .select()
          .from(revisions)
          .where(eq(revisions.projectId, W.id)),
      ).toEqual([]);

      await at(
        "2026-09-03T01:00:00.000000Z",
        () => patch(bodyCard, { body: `${SECRET}: body-only edit` }),
        [W],
      );
      await exhaust(projectPath(W), [bodyCard], "2026-09-03");
      await exhaust(personPath(alice), [bodyCard], "2026-09-03");
      await at(
        "2026-09-04T01:00:00.000000Z",
        () =>
          editComment(
            commentCard,
            oldComment.id,
            `${SECRET}: comment-only edit`,
          ),
        [W],
      );
      await exhaust(projectPath(W), [commentCard], "2026-09-04");
      await exhaust(personPath(alice), [commentCard], "2026-09-04");
      await exhaust(personPath(bob), [], "2026-09-04");

      await at(
        "2026-09-05T01:00:00.000000Z",
        () =>
          request(`${pathOf(specCard)}/spec/push`, bob.headers, "POST", {
            files: [
              { path: "design.md", body: `${SECRET}\nmeaningful new line\n` },
            ],
          }),
        [W],
      );
      await exhaust(projectPath(W), [specCard], "2026-09-05");
      await exhaust(personPath(bob), [specCard], "2026-09-05");
      await exhaust(personPath(alice), [], "2026-09-05");

      await at(
        "2026-09-06T01:00:00.000000Z",
        () =>
          request(
            `${pathOf(answerCard)}/comments/${question.id}/answers`,
            alice.headers,
            "POST",
            {
              answers: [{ key: "choice", selected: [], declined: true }],
            },
            201,
          ),
        [W],
      );
      const review = await at(
        "2026-09-06T02:00:00.000000Z",
        () =>
          request<{ summary_comment_id: number; comment_ids: number[] }>(
            `${pathOf(specCard)}/spec/reviews`,
            alice.headers,
            "POST",
            {
              version: 2,
              verdict: "request_changes",
              body: SECRET,
              comments: [
                {
                  anchor: {
                    path: "design.md",
                    version: 2,
                    line_start: 1,
                    line_end: 1,
                  },
                  body: SECRET,
                },
              ],
            },
            201,
          ),
        [W],
      );
      await exhaust(projectPath(W), [specCard, answerCard], "2026-09-06", 1);
      await exhaust(personPath(alice), [specCard, answerCard], "2026-09-06", 1);
      const answered = await W.db
        .select()
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, answerCard.id),
            eq(issueEvents.type, "question_answered"),
          ),
        );
      expect(answered).toHaveLength(1);
      expect(answered[0]?.payload).toMatchObject({
        via: "answer",
        answers: [expect.objectContaining({ declined: true })],
      });

      await at(
        "2026-09-07T01:00:00.000000Z",
        () =>
          request(
            `${pathOf(specCard)}/spec/comments/resolve`,
            alice.headers,
            "POST",
            { comment_ids: review.comment_ids },
          ),
        [W],
      );
      await exhaust(projectPath(W), [specCard], "2026-09-07");
      await exhaust(personPath(alice), [specCard], "2026-09-07");

      const relation = await at(
        "2026-09-08T01:00:00.000000Z",
        () =>
          request<{ blocked_by: { edge_id: number }[] }>(
            `${pathOf(blocked)}/blocked-by`,
            alice.headers,
            "POST",
            { ref: `#${blocker.number}` },
          ),
        [W],
      );
      const edge = relation.blocked_by[0]?.edge_id;
      expect(edge).toBeGreaterThan(0);
      await exhaust(projectPath(W), [blocked, blocker], "2026-09-08", 1);
      await exhaust(personPath(alice), [blocked, blocker], "2026-09-08", 1);
      await at(
        "2026-09-09T01:00:00.000000Z",
        () =>
          request(`${pathOf(blocked)}/blocked-by`, alice.headers, "POST", {
            ref: `#${blocker.number}`,
          }),
        [W],
      );
      await exhaust(projectPath(W), [], "2026-09-09");
      await at(
        "2026-09-09T02:00:00.000000Z",
        () =>
          request(
            `${pathOf(blocked)}/blocked-by/${edge}`,
            alice.headers,
            "DELETE",
            undefined,
            204,
          ),
        [W],
      );
      await exhaust(projectPath(W), [blocked, blocker], "2026-09-09");
      await exhaust(personPath(alice), [blocked, blocker], "2026-09-09");

      await at(
        BASE,
        () =>
          request(`${pathOf(blocked)}/blocked-by`, alice.headers, "POST", {
            ref: `#${blocker.number}`,
          }),
        [W],
      );
      const wStatuses = await request<Status[]>(
        `/projects/${W.slug}/statuses`,
        admin,
      );
      const wClosed = wStatuses.find((status) => status.category === "closed");
      if (!wClosed) throw new Error("writer fixture requires a closed status");
      await at(
        "2026-09-10T01:00:00.000000Z",
        () => patch(blocker, { status_id: wClosed.id }, bob.headers),
        [W],
      );
      await exhaust(projectPath(W), [blocker], "2026-09-10");
      await exhaust(personPath(bob), [blocker], "2026-09-10");
      await exhaust(personPath(alice), [], "2026-09-10");

      const hidden = await at(
        "2026-09-11T01:00:00.000000Z",
        () => say(noopCard, SECRET),
        [W],
      );
      await at(
        "2026-09-12T01:00:00.000000Z",
        () => hide(noopCard, [hidden.id]),
        [W],
      );
      await exhaust(projectPath(W), [noopCard], "2026-09-11");
      await exhaust(personPath(alice), [noopCard], "2026-09-11");
      await exhaust(projectPath(W), [], "2026-09-12");
      await exhaust(personPath(alice), [], "2026-09-12");

      // Delete every comment supporting the answer/review, plus the only source
      // for commentCard's revision. Existing events survive; comment evidence does
      // not. Deletion itself creates no activity on the deletion day.
      await at("2026-09-14T01:00:00.000000Z", async () => {
        for (const [card, id] of [
          [answerCard, question.id],
          [commentCard, oldComment.id],
          [specCard, review.summary_comment_id],
          ...review.comment_ids.map((id) => [specCard, id] as const),
        ] as const) {
          await request(
            `${pathOf(card)}/comments/${id}`,
            alice.headers,
            "DELETE",
            undefined,
            204,
          );
        }
      }, [W]);
      await exhaust(projectPath(W), [], "2026-09-14");
      await exhaust(personPath(alice), [], "2026-09-14");
      await exhaust(projectPath(W), [], "2026-09-04");
      await exhaust(personPath(alice), [], "2026-09-04");
      await exhaust(projectPath(W), [specCard, answerCard], "2026-09-06", 1);
      await exhaust(personPath(alice), [specCard, answerCard], "2026-09-06", 1);
      await exhaust(projectPath(W), [specCard], "2026-09-07");
      await exhaust(projectPath(P), [cards.F, cards.A, cards.B]);
      await exhaust(personPath(alice), [cards.F, cards.A, cards.C]);
    }, 120_000);

    it("uses exact local-day bounds for Kolkata, both New York DST transitions, Apia and leap years", async () => {
      const T = await createProject(
        "calendar-timezones",
        "Timezone boundaries",
      );
      await member(T, viewer, "reader");
      await member(T, alice, "admin");
      await t.ctx.router
        .system()
        .update(projects)
        .set({ createdAt: new Date(BORN) })
        .where(eq(projects.id, T.id));
      const beforeStart = await at(BASE, () => createCard(T, "before start"), [
        T,
      ]);
      const atStart = await at(BASE, () => createCard(T, "at start"), [T]);
      const beforeEnd = await at(BASE, () => createCard(T, "before end"), [T]);
      const atEnd = await at(BASE, () => createCard(T, "at end"), [T]);
      await T.db
        .update(issues)
        .set({ createdAt: new Date(BORN) })
        .where(eq(issues.projectId, T.id));
      // November must be in the past. Freeze only this scenario's cutoff later;
      // writer timestamps remain explicitly controlled, not wall-clock guesses.
      vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
      try {
        const cases = [
          {
            tz: "UTC",
            day: "2026-01-15",
            previous: "2026-01-14",
            next: "2026-01-16",
            stamps: [
              "2026-01-14T23:59:59.999999Z",
              "2026-01-15T00:00:00.000000Z",
              "2026-01-15T23:59:59.999999Z",
              "2026-01-16T00:00:00.000000Z",
            ],
          },
          {
            tz: "Asia/Kolkata",
            day: "2026-02-01",
            previous: "2026-01-31",
            next: "2026-02-02",
            stamps: [
              "2026-01-31T18:29:59.999999Z",
              "2026-01-31T18:30:00.000000Z",
              "2026-02-01T18:29:59.999999Z",
              "2026-02-01T18:30:00.000000Z",
            ],
          },
          {
            tz: "America/New_York",
            day: "2026-03-08",
            previous: "2026-03-07",
            next: "2026-03-09",
            stamps: [
              "2026-03-08T04:59:59.999999Z",
              "2026-03-08T05:00:00.000000Z",
              "2026-03-09T03:59:59.999999Z",
              "2026-03-09T04:00:00.000000Z",
            ],
          },
          {
            tz: "America/New_York",
            day: "2026-11-01",
            previous: "2026-10-31",
            next: "2026-11-02",
            stamps: [
              "2026-11-01T03:59:59.999999Z",
              "2026-11-01T04:00:00.000000Z",
              "2026-11-02T04:59:59.999999Z",
              "2026-11-02T05:00:00.000000Z",
            ],
          },
        ] as const;
        for (const example of cases) {
          for (const [index, card] of [
            beforeStart,
            atStart,
            beforeEnd,
            atEnd,
          ].entries()) {
            const stamp = example.stamps[index];
            if (!stamp) throw new Error("boundary fixture is incomplete");
            await at(
              stamp,
              () => patch(card, { body: `${SECRET}: ${example.day}/${index}` }),
              [T],
            );
          }
          for (const path of [projectPath(T), personPath(alice)]) {
            for (const limit of [1, 2, 100]) {
              const selected = await exhaust(
                path,
                [beforeEnd, atStart],
                example.day,
                limit,
                example.tz,
              );
              expect(selected.map((item) => item.last_active_at)).toEqual([
                example.stamps[2],
                example.stamps[1],
              ]);
              await exhaust(
                path,
                [beforeStart],
                example.previous,
                limit,
                example.tz,
              );
              await exhaust(path, [atEnd], example.next, limit, example.tz);
            }
          }
        }
        for (const path of [projectPath(T), personPath(alice)]) {
          const apia = await calendar(
            path,
            null,
            100,
            undefined,
            "Pacific/Apia",
            2011,
          );
          expect(apia.selection).toBeNull();
          expect(apia.days).toHaveLength(365);
          expect(apia.days.find((day) => day.date === "2011-12-30")).toEqual({
            date: "2011-12-30",
            state: "not_applicable",
            count: null,
          });
          expect(apia.days.find((day) => day.date === "2011-12-29")).toEqual({
            date: "2011-12-29",
            state: "recorded",
            count: 0,
          });
          expect(apia.days.find((day) => day.date === "2011-12-31")).toEqual({
            date: "2011-12-31",
            state: "recorded",
            count: 0,
          });
          const rejected = await request<{ error: { code: string } }>(
            `${path}?from=2011-01-01&to=2012-01-01&tz=Pacific%2FApia&day=2011-12-30`,
            viewer.headers,
            "GET",
            undefined,
            422,
          );
          expect(rejected.error.code).toBe("validation_failed");
          const leap = await calendar(
            path,
            "2024-02-29",
            100,
            undefined,
            "UTC",
            2024,
          );
          expect(leap.days).toHaveLength(366);
          expect(new Set(leap.days.map((day) => day.date)).size).toBe(366);
          expect(leap.days[0]?.date).toBe("2024-01-01");
          expect(leap.days.at(-1)?.date).toBe("2024-12-31");
          expect(leap.days.find((day) => day.date === "2024-02-29")).toEqual({
            date: "2024-02-29",
            state: "recorded",
            count: 0,
          });
          expect(leap.selection).toEqual({
            date: "2024-02-29",
            total: 0,
            items: [],
            next_cursor: null,
            has_more: false,
          });
        }
      } finally {
        vi.setSystemTime(new Date(NOW));
      }
    }, 120_000);

    it("excludes all evidence moved from hidden R, counts only destination writes, and resets ownership on a round trip", async () => {
      const moveDay = "2026-09-15";
      const sameInstant = "2026-09-15T01:00:00.123456Z";

      async function relocate(card: Card, destination: Project, stamp: string) {
        const moved = await request<{ moved_to: { number: number } }>(
          `${pathOf(card)}/move`,
          alice.headers,
          "POST",
          { to_project: destination.slug },
        );
        const row = await request<{ id: number; number: number }>(
          `/projects/${destination.slug}/issues/${moved.moved_to.number}`,
          alice.headers,
        );
        const [arrival] = await destination.db
          .select()
          .from(issueEvents)
          .where(
            and(
              eq(issueEvents.projectId, destination.id),
              eq(issueEvents.issueId, row.id),
              eq(issueEvents.type, "moved_in"),
            ),
          )
          .orderBy(desc(issueEvents.id))
          .limit(1);
        if (!arrival) throw new Error("real move did not persist its arrival");
        await destination.db
          .update(issueEvents)
          .set({ createdAt: sql`${stamp}::timestamptz` })
          .where(eq(issueEvents.id, arrival.id));
        return {
          card: { id: row.id, number: row.number, project: destination },
          arrival,
        };
      }

      const landed: Card[] = [];
      for (const kind of ["event", "comment", "revision"] as const) {
        const source = await at(
          BASE,
          () => createCard(R, `hidden move ${kind}`),
          [R],
        );
        await R.db
          .update(issues)
          .set({ createdAt: new Date(BORN) })
          .where(eq(issues.id, source.id));
        await at(sameInstant, async () => {
          await patch(source, {
            title: `hidden move ${kind} revised`,
            body: `${SECRET}: imported body`,
          });
          const comment = await say(source, `${SECRET}: imported comment`);
          await editComment(
            source,
            comment.id,
            `${SECRET}: imported comment revision`,
          );
        }, [R]);
        const sourceEvents = await R.db
          .select()
          .from(issueEvents)
          .where(eq(issueEvents.issueId, source.id));
        expect(sourceEvents.map((event) => event.type)).toContain(
          "title_changed",
        );
        const sourceComments = await R.db
          .select()
          .from(comments)
          .where(eq(comments.issueId, source.id));
        expect(sourceComments).toHaveLength(1);
        await request(pathOf(source), viewer.headers, "GET", undefined, 404);
        const moved = await relocate(source, P, sameInstant);
        landed.push(moved.card);
        expect(moved.arrival.payload).toMatchObject({
          activity_imported_max_ids: {
            v: 1,
            events: expect.any(Number),
            comments: expect.any(Number),
            revisions: expect.any(Number),
          },
        });
        const copiedComments = await P.db
          .select()
          .from(comments)
          .where(eq(comments.issueId, moved.card.id));
        expect(copiedComments).toHaveLength(1);
        const copiedCommentId = copiedComments[0]?.id;
        if (!copiedCommentId) throw new Error("move lost its copied comment");
        const copiedBodyRevisions = await P.db
          .select()
          .from(revisions)
          .where(
            and(
              eq(revisions.projectId, P.id),
              eq(revisions.subjectType, "issue_body"),
              eq(revisions.subjectId, moved.card.id),
            ),
          );
        const copiedCommentRevisions = await P.db
          .select()
          .from(revisions)
          .where(
            and(
              eq(revisions.projectId, P.id),
              eq(revisions.subjectType, "comment"),
              eq(revisions.subjectId, copiedCommentId),
            ),
          );
        expect(copiedBodyRevisions).toHaveLength(1);
        expect(copiedCommentRevisions).toHaveLength(1);
        // Before ANY target write, all three imported sources are present but
        // both endpoints must still return the independent empty-day oracle.
        await exhaust(projectPath(P), [], moveDay);
        await exhaust(personPath(alice), [], moveDay);
      }

      const eventCard = landed[0];
      const commentCard = landed[1];
      const revisionCard = landed[2];
      if (!eventCard || !commentCard || !revisionCard)
        throw new Error("missing move destinations");
      // These occur at exactly the imported records' microsecond. Three distinct
      // cards independently prove all three source-local ID boundaries.
      await at(
        sameInstant,
        () => patch(eventCard, { title: "destination event" }),
        [P],
      );
      await exhaust(projectPath(P), [eventCard], moveDay);
      await at(
        sameInstant,
        () => say(commentCard, `${SECRET}: destination comment`),
        [P],
      );
      await exhaust(projectPath(P), [eventCard, commentCard], moveDay, 1);
      await at(
        sameInstant,
        () => patch(revisionCard, { body: `${SECRET}: destination revision` }),
        [P],
      );
      for (const limit of [1, 2, 100]) {
        for (const path of [projectPath(P), personPath(alice)]) {
          const items = await exhaust(
            path,
            [eventCard, commentCard, revisionCard],
            moveDay,
            limit,
          );
          expect(items.map((item) => item.last_active_at)).toEqual([
            sameInstant,
            sameInstant,
            sameInstant,
          ]);
        }
      }

      const away = await relocate(
        revisionCard,
        R,
        "2026-09-15T02:00:00.000000Z",
      );
      await exhaust(projectPath(P), [eventCard, commentCard], moveDay);
      await exhaust(personPath(alice), [eventCard, commentCard], moveDay);
      await at("2026-09-15T03:00:00.000000Z", async () => {
        await patch(away.card, {
          title: "hidden return journey",
          body: `${SECRET}: hidden second body edit`,
        });
        await say(away.card, `${SECRET}: hidden second comment`);
      }, [R]);
      const returned = await relocate(
        away.card,
        P,
        "2026-09-15T04:00:00.000000Z",
      );
      expect(returned.card.number).toBe(revisionCard.number);
      expect(returned.card.id).toBe(revisionCard.id);
      // The first stay in P is now imported history too. Its former destination
      // revision must not survive as current P ownership evidence.
      for (const limit of [1, 2, 100]) {
        await exhaust(projectPath(P), [eventCard, commentCard], moveDay, limit);
        await exhaust(
          personPath(alice),
          [eventCard, commentCard],
          moveDay,
          limit,
        );
      }
      await at(
        "2026-09-15T04:00:00.000001Z",
        () => patch(returned.card, { body: `${SECRET}: current ownership` }),
        [P],
      );
      await exhaust(
        projectPath(P),
        [returned.card, eventCard, commentCard],
        moveDay,
        1,
      );
      await exhaust(
        personPath(alice),
        [returned.card, eventCard, commentCard],
        moveDay,
        1,
      );

      // Emulate an actual pre-watermark move by removing only its new manifest.
      // Keep the real token, id_map, destination and done record for legacy
      // resolution. The completion timestamp is controlled at SQL precision.
      const legacyDay = "2026-09-16";
      const finishedAt = "2026-09-16T02:00:00.123456Z";
      const legacySource = await at(
        BASE,
        () => createCard(R, "legacy hidden move"),
        [R],
      );
      await R.db
        .update(issues)
        .set({ createdAt: new Date(BORN) })
        .where(eq(issues.id, legacySource.id));
      await at("2026-09-16T01:00:00.000000Z", async () => {
        await patch(legacySource, {
          title: "legacy source event",
          body: `${SECRET}: legacy source body`,
        });
        const comment = await say(
          legacySource,
          `${SECRET}: legacy source comment`,
        );
        await editComment(
          legacySource,
          comment.id,
          `${SECRET}: legacy source comment revision`,
        );
      }, [R]);
      const legacy = await relocate(legacySource, P, finishedAt);
      const legacyPayload = legacy.arrival.payload as {
        move_token: string;
        id_map: unknown;
      };
      expect(typeof legacyPayload.move_token).toBe("string");
      await P.db
        .update(issueEvents)
        .set({
          payload: sql`${issueEvents.payload} - 'activity_imported_max_ids'`,
        })
        .where(eq(issueEvents.id, legacy.arrival.id));
      const completed = await t.ctx.router
        .system()
        .update(issueMoves)
        .set({ finishedAt: sql`${finishedAt}::timestamptz` })
        .where(
          and(
            eq(issueMoves.moveToken, legacyPayload.move_token),
            eq(issueMoves.state, "done"),
            eq(issueMoves.toProjectId, P.id),
            eq(issueMoves.toNumber, legacy.card.number),
          ),
        )
        .returning({ id: issueMoves.id });
      expect(completed).toHaveLength(1);
      await exhaust(projectPath(P), [], legacyDay);
      await exhaust(personPath(alice), [], legacyDay);
      await at(
        finishedAt,
        () => patch(legacy.card, { body: `${SECRET}: exactly completed` }),
        [P],
      );
      await exhaust(projectPath(P), [], legacyDay);
      await exhaust(personPath(alice), [], legacyDay);
      await at(
        "2026-09-16T02:00:00.123457Z",
        () => patch(legacy.card, { body: `${SECRET}: after completion` }),
        [P],
      );
      for (const limit of [1, 2, 100]) {
        const selected = await exhaust(
          projectPath(P),
          [legacy.card],
          legacyDay,
          limit,
        );
        expect(selected[0]?.last_active_at).toBe("2026-09-16T02:00:00.123457Z");
        await exhaust(personPath(alice), [legacy.card], legacyDay, limit);
      }
      await t.ctx.router
        .system()
        .update(issueMoves)
        .set({ finishedAt: null })
        .where(eq(issueMoves.moveToken, legacyPayload.move_token));
      await exhaust(projectPath(P), [], legacyDay);
      await exhaust(personPath(alice), [], legacyDay);
      // Missing legacy completion suppresses revisions, while independently
      // classifiable new comments and events still work after the move.
      await at(
        "2026-09-16T03:00:00.000000Z",
        () => say(legacy.card, `${SECRET}: new legacy comment`, bob.headers),
        [P],
      );
      await exhaust(personPath(bob), [legacy.card], legacyDay);
      await exhaust(personPath(alice), [], legacyDay);
      await at(
        "2026-09-16T04:00:00.000000Z",
        () => patch(legacy.card, { title: "new legacy event" }),
        [P],
      );
      await exhaust(projectPath(P), [legacy.card], legacyDay);
      await exhaust(personPath(alice), [legacy.card], legacyDay);
      await P.db
        .update(issueEvents)
        .set({ payload: sql`${issueEvents.payload} - 'id_map'` })
        .where(eq(issueEvents.id, legacy.arrival.id));
      await exhaust(personPath(bob), [], legacyDay);
      await exhaust(personPath(alice), [legacy.card], legacyDay);
    }, 120_000);
  },
);
