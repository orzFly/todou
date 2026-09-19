import type {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import type { Db } from "../src/db/driver.ts";
import { issueEvents, issues, statuses } from "../src/db/project-schema.ts";
import { projectMembers, projects, users } from "../src/db/system-schema.ts";
import {
  getProjectActivityCalendar,
  getUserActivityCalendar,
} from "../src/services/activity-calendar/index.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

type Account = { user: UserRow; headers: { authorization: string } };
type ProjectRow = typeof projects.$inferSelect;
type ErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

const DAY = "2024-02-29";
const QUERY = { year: "2024", tz: "UTC", day: DAY };
const SERVICE_QUERY: ActivityCalendarQuery = {
  year: 2024,
  tz: "UTC",
  day: DAY,
  limit: 50,
};
const BIRTH = new Date("2020-01-01T00:00:00.000Z");
const projectPath = (ref: string | number) =>
  `/api/projects/${ref}/insights/activity`;
const userPath = (ref: string | number) => `/api/users/${ref}/activity`;

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")?.split(/\s*,\s*/)).toEqual(
    expect.arrayContaining(["private", "no-store"]),
  );
}

async function calendar(response: Response): Promise<ActivityCalendarResponse> {
  expect(response.status).toBe(200);
  expectNoStore(response);
  return (await response.json()) as ActivityCalendarResponse;
}

async function error(
  response: Response,
  status: number,
  code: string,
): Promise<ErrorBody> {
  expect(response.status).toBe(status);
  expectNoStore(response);
  const body = (await response.json()) as ErrorBody;
  expect(body.error.code).toBe(code);
  return body;
}

// Project/number/title triples are an intentionally small public projection.
// Expected rows and totals below are handwritten from the six seeded events,
// never computed through a production classifier, cursor, or schema parser.
function expectSelection(
  body: ActivityCalendarResponse,
  total: number,
  expected: Array<[string, number, string]>,
): void {
  expect(body.year).toBe(2024);
  expect(body.timezone).toBe("UTC");
  expect(body.days).toHaveLength(366);
  expect(body.days.find((day) => day.date === DAY)).toEqual({
    date: DAY,
    state: "recorded",
    count: total,
  });
  expect(body.selection).toMatchObject({ date: DAY, total });
  expect(
    body.selection?.items.map((card) => [
      card.project.slug,
      card.number,
      card.title,
    ]),
  ).toEqual(expected);
}

function expectComplete(body: ActivityCalendarResponse): void {
  expect(body.selection).toMatchObject({ has_more: false, next_cursor: null });
}

const malformedQueries: Array<[string, string]> = [
  ["missing year", "tz=UTC"],
  ["missing timezone", "year=2024"],
  ["unknown field", "year=2024&tz=UTC&project=hidden"],
  ["unknown actor filter", "year=2024&tz=UTC&actor_id=1"],
  ["nonnumeric year", "year=nope&tz=UTC"],
  ["fractional year", "year=2024.5&tz=UTC"],
  ["zero year", "year=0&tz=UTC"],
  ["year beyond supported range", "year=9999&tz=UTC"],
  ["empty timezone", "year=2024&tz="],
  ["unknown database timezone", "year=2024&tz=Not%2FA_Zone"],
  ["oversized timezone", `year=2024&tz=${"x".repeat(101)}`],
  ["malformed date", "year=2024&tz=UTC&day=2024-2-29"],
  ["nonexistent date", "year=2024&tz=UTC&day=2024-02-30"],
  ["nonleap February 29", "year=2023&tz=UTC&day=2023-02-29"],
  ["day outside year", "year=2024&tz=UTC&day=2023-02-28"],
  ["zero limit", "year=2024&tz=UTC&limit=0"],
  ["excessive limit", "year=2024&tz=UTC&limit=101"],
  ["fractional limit", "year=2024&tz=UTC&limit=1.5"],
  ["nonnumeric limit", "year=2024&tz=UTC&limit=many"],
  ["cursor without day", "year=2024&tz=UTC&after=e30"],
  ["empty cursor", `year=2024&tz=UTC&day=${DAY}&after=`],
  ["non-base64 cursor", `year=2024&tz=UTC&day=${DAY}&after=%25%25%25`],
  ["cursor with wrong envelope", `year=2024&tz=UTC&day=${DAY}&after=e30`],
  ["oversized cursor", `year=2024&tz=UTC&day=${DAY}&after=${"a".repeat(8193)}`],
];

describe.each(PLACEMENTS)(
  "activity calendar endpoint/access (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let viewer: Account;
    let subject: Account;
    let outsider: Account;
    let bot: Account;
    let instanceAdmin: Account;
    let a: ProjectRow;
    let b: ProjectRow;
    let c: ProjectRow;
    const oldSlug = "calendar-access-old";
    const adminHeaders = () => ({ cookie, "content-type": "application/json" });

    const get = (
      path: string,
      query: Record<string, string> = QUERY,
      headers: Record<string, string> = viewer.headers,
    ) => t.app.request(`${path}?${new URLSearchParams(query)}`, { headers });

    async function createProject(slug: string): Promise<ProjectRow> {
      const response = await t.app.request("/api/projects", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(response.status).toBe(201);
      const [row] = await t.ctx.router
        .system()
        .update(projects)
        .set({ createdAt: BIRTH })
        .where(eq(projects.slug, slug))
        .returning();
      if (!row) throw new Error("project fixture missing");
      return row;
    }

    async function addSeat(
      project: ProjectRow,
      account: Account,
    ): Promise<void> {
      await t.ctx.router
        .system()
        .insert(projectMembers)
        .values({
          projectId: project.id,
          userId: account.user.id,
          role: "reader",
        })
        .onConflictDoNothing();
    }

    async function removeSeat(
      project: ProjectRow,
      account: Account,
    ): Promise<void> {
      await t.ctx.router
        .system()
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, project.id),
            eq(projectMembers.userId, account.user.id),
          ),
        );
    }

    async function seedOpened(
      project: ProjectRow,
      number: number,
      title: string,
      actor: Account,
      hour: string,
    ): Promise<void> {
      const db = await t.ctx.router.forProject(project);
      const [status] = await db
        .select()
        .from(statuses)
        .where(
          and(eq(statuses.projectId, project.id), eq(statuses.name, "Todo")),
        );
      if (!status) throw new Error("Todo status fixture missing");
      const at = new Date(`${DAY}T${hour}:00:00.000Z`);
      const [issue] = await db
        .insert(issues)
        .values({
          projectId: project.id,
          number,
          title,
          statusId: status.id,
          authorId: actor.user.id,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!issue) throw new Error("issue fixture missing");
      await db.insert(issueEvents).values({
        projectId: project.id,
        issueId: issue.id,
        actorId: actor.user.id,
        type: "opened",
        payload: {},
        createdAt: at,
      });
    }

    // Mutate only after the real snapshot transaction has committed. In shared
    // placement the system and project DB are the same PGlite connection;
    // mutating inside the callback would deadlock instead of testing a recheck.
    function afterSnapshot(mutate: (projectId: number) => Promise<void>) {
      const original = t.ctx.router.forProject.bind(t.ctx.router);
      return vi
        .spyOn(t.ctx.router, "forProject")
        .mockImplementation(async (project) => {
          const db = await original(project);
          return new Proxy(db, {
            get(target, key) {
              if (key === "transaction") {
                return async (...args: Parameters<Db["transaction"]>) => {
                  const result = await target.transaction(...args);
                  await mutate(project.id);
                  return result;
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
    }

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      viewer = await addUserWithToken(t.ctx, "calendar-viewer");
      subject = await addUserWithToken(t.ctx, "calendar-subject");
      outsider = await addUserWithToken(t.ctx, "calendar-outsider");
      bot = await addUserWithToken(t.ctx, "calendar-bot", {
        kind: "machine",
        ownerId: viewer.user.id,
      });
      instanceAdmin = await addUserWithToken(t.ctx, "calendar-admin", {
        instanceAdmin: true,
      });
      await t.ctx.router
        .system()
        .update(users)
        .set({ createdAt: BIRTH })
        .where(
          inArray(users.id, [
            viewer.user.id,
            subject.user.id,
            outsider.user.id,
            bot.user.id,
            instanceAdmin.user.id,
          ]),
        );
      a = await createProject(oldSlug);
      b = await createProject("calendar-access-b");
      c = await createProject("calendar-access-c");
      const renamed = await t.app.request(`/api/projects/${oldSlug}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ slug: "calendar-access-a" }),
      });
      expect(renamed.status).toBe(200);
      a = { ...a, slug: "calendar-access-a" };
      await addSeat(a, viewer);
      await addSeat(b, viewer);
      await addSeat(a, subject);
      await addSeat(c, subject);

      // A and C share a target under dedicated-bucketed placement. B has
      // subject evidence despite no current subject membership. The bot has
      // no seats; its owner can resolve it through ownership alone.
      await seedOpened(a, 1, "Subject in A", subject, "10");
      await seedOpened(a, 2, "Viewer in A", viewer, "11");
      await seedOpened(b, 1, "Subject in B", subject, "12");
      await seedOpened(b, 2, "Bot in B", bot, "13");
      await seedOpened(c, 1, "Subject in hidden C", subject, "14");
      await seedOpened(c, 2, "Bot in hidden C", bot, "15");
    });

    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => t.cleanup());

    it("marks missing-auth401 as private/no-store before either calendar handler", async () => {
      const opened = vi.spyOn(t.ctx.router, "forProject");
      for (const path of [
        projectPath(a.slug),
        projectPath(oldSlug),
        userPath(subject.user.login),
        userPath(subject.user.id),
      ]) {
        const body = await error(
          await get(path, QUERY, {}),
          401,
          "unauthorized",
        );
        expect(body).toEqual({
          error: { code: "unauthorized", message: "authentication required" },
        });
      }
      expect(opened).not.toHaveBeenCalled();
    });

    it("marks nonexistent project canonical-resolution404 as private/no-store", async () => {
      const opened = vi.spyOn(t.ctx.router, "forProject");
      for (const ref of ["missing-calendar-project", "999999"]) {
        const response = await get(
          projectPath(ref),
          QUERY,
          instanceAdmin.headers,
        );
        const body = await error(response, 404, "not_found");
        expect(body).toEqual({
          error: { code: "not_found", message: "project not found" },
        });
        expect(response.headers.get("x-todou-canonical-slug")).toBeNull();
      }
      expect(opened).not.toHaveBeenCalled();
    });

    it("resolves project slug, numeric id and retired slug to canonical cards", async () => {
      for (const ref of [a.slug, String(a.id), oldSlug]) {
        const response = await get(projectPath(ref));
        const body = await calendar(response);
        expectSelection(body, 2, [
          ["calendar-access-a", 2, "Viewer in A"],
          ["calendar-access-a", 1, "Subject in A"],
        ]);
        expectComplete(body);
        expect(body.selection?.items.map((card) => card.url)).toEqual([
          "/projects/calendar-access-a/issues/2",
          "/projects/calendar-access-a/issues/1",
        ]);
        expect(body.selection?.items.map((card) => card.project.id)).toEqual([
          a.id,
          a.id,
        ]);
        if (ref === oldSlug) {
          expect(response.headers.get("x-todou-canonical-slug")).toBe(a.slug);
        }
      }
    });

    it("resolves user id/login and scopes subject evidence by the viewer's readable projects", async () => {
      for (const ref of [String(subject.user.id), subject.user.login]) {
        const body = await calendar(await get(userPath(ref)));
        expectSelection(body, 2, [
          ["calendar-access-b", 1, "Subject in B"],
          ["calendar-access-a", 1, "Subject in A"],
        ]);
        expectComplete(body);
      }
    });

    it("changes readable evidence with the viewer, while preserving the subject", async () => {
      const body = await calendar(
        await get(userPath(subject.user.login), QUERY, subject.headers),
      );
      expectSelection(body, 2, [
        ["calendar-access-c", 1, "Subject in hidden C"],
        ["calendar-access-a", 1, "Subject in A"],
      ]);
      expectComplete(body);
    });

    it("returns the same project404 for nonmembers and nonexistent projects, including aliases", async () => {
      for (const ref of [
        a.slug,
        String(a.id),
        oldSlug,
        "missing-calendar",
        "999999",
      ]) {
        const body = await error(
          await get(projectPath(ref), QUERY, outsider.headers),
          404,
          "not_found",
        );
        expect(body).toEqual({
          error: { code: "not_found", message: "project not found" },
        });
      }
    });

    it("returns the same subject404 for hidden id/login and nonexistent users", async () => {
      for (const ref of [
        String(subject.user.id),
        subject.user.login,
        "missing-calendar-user",
        "999999",
      ]) {
        const body = await error(
          await get(userPath(ref), QUERY, outsider.headers),
          404,
          "not_found",
        );
        expect(body).toEqual({
          error: { code: "not_found", message: "user not found" },
        });
      }
    });

    it("lets an owner see its bot without attributing bot activity to the owner", async () => {
      const machine = await calendar(await get(userPath(bot.user.login)));
      expectSelection(machine, 1, [["calendar-access-b", 2, "Bot in B"]]);
      expectComplete(machine);
      const owner = await calendar(await get(userPath(viewer.user.id)));
      expectSelection(owner, 1, [["calendar-access-a", 2, "Viewer in A"]]);
      expectComplete(owner);
      await error(
        await get(userPath(bot.user.id), QUERY, subject.headers),
        404,
        "not_found",
      );
    });

    it("lets an instance admin without seats see every project and hidden subject", async () => {
      const person = await calendar(
        await get(userPath(subject.user.login), QUERY, instanceAdmin.headers),
      );
      expectSelection(person, 3, [
        ["calendar-access-c", 1, "Subject in hidden C"],
        ["calendar-access-b", 1, "Subject in B"],
        ["calendar-access-a", 1, "Subject in A"],
      ]);
      expectComplete(person);
      const project = await calendar(
        await get(projectPath(c.id), QUERY, instanceAdmin.headers),
      );
      expectSelection(project, 2, [
        ["calendar-access-c", 2, "Bot in hidden C"],
        ["calendar-access-c", 1, "Subject in hidden C"],
      ]);
      expectComplete(project);
      const hidden = await calendar(
        await get(userPath(outsider.user.login), QUERY, instanceAdmin.headers),
      );
      expectSelection(hidden, 0, []);
      expectComplete(hidden);
    });

    it("groups malformed known events after the snapshot without logging intentional exclusions or payloads", async () => {
      const db = await t.ctx.router.forProject(a);
      const cards = await db
        .select()
        .from(issues)
        .where(eq(issues.projectId, a.id))
        .orderBy(issues.number);
      const first = cards[0];
      const second = cards[1];
      if (!first || !second)
        throw new Error("diagnostic card fixtures missing");
      const secret = "fixture-private-event-payload";
      const diagnosticDay = "2024-03-01";
      const declined = {
        comment_id: 999999,
        answers: [{ key: "choice", selected: [], other: null, declined: true }],
      };
      const inserted = await db
        .insert(issueEvents)
        .values([
          {
            projectId: a.id,
            issueId: first.id,
            actorId: subject.user.id,
            type: "opened",
            payload: { body: secret },
            createdAt: new Date("2024-03-01T10:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: second.id,
            actorId: subject.user.id,
            type: "opened",
            payload: [secret],
            createdAt: new Date("2024-03-01T11:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: first.id,
            actorId: subject.user.id,
            type: "title_changed",
            payload: { from: secret, to: 42 },
            createdAt: new Date("2024-03-01T12:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: first.id,
            actorId: subject.user.id,
            type: "question_answered",
            payload: { ...declined, via: "hide" },
            createdAt: new Date("2024-03-01T13:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: second.id,
            actorId: subject.user.id,
            type: "question_answered",
            payload: declined,
            createdAt: new Date("2024-03-01T14:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: first.id,
            actorId: subject.user.id,
            type: "status_changed",
            payload: {
              from: { id: first.statusId, name: "Todo" },
              to: { id: first.statusId, name: "Todo" },
            },
            createdAt: new Date("2024-03-01T15:00:00.000Z"),
          },
          {
            projectId: a.id,
            issueId: first.id,
            actorId: subject.user.id,
            type: "spec_comments_resolved",
            payload: { comment_ids: [999999], paths: [], via: "hide" },
            createdAt: new Date("2024-03-01T16:00:00.000Z"),
          },
        ])
        .returning({ id: issueEvents.id });
      let snapshotFinished = false;
      const warningAfterSnapshot: boolean[] = [];
      const barrier = afterSnapshot(async (projectId) => {
        if (projectId === a.id) snapshotFinished = true;
      });
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {
        warningAfterSnapshot.push(snapshotFinished);
      });
      try {
        for (const path of [
          projectPath(a.slug),
          userPath(subject.user.login),
        ]) {
          snapshotFinished = false;
          warningAfterSnapshot.length = 0;
          warned.mockClear();
          const response = await get(path, { ...QUERY, day: diagnosticDay });
          const body = await calendar(response);
          expect(body.days.find((day) => day.date === diagnosticDay)).toEqual({
            date: diagnosticDay,
            state: "recorded",
            count: 0,
          });
          expect(body.selection).toEqual({
            date: diagnosticDay,
            total: 0,
            items: [],
            has_more: false,
            next_cursor: null,
          });
          expect(warned.mock.calls).toEqual([
            [
              "activity calendar: malformed event payloads",
              {
                project_id: a.id,
                events: [
                  { type: "opened", count: 2 },
                  { type: "title_changed", count: 1 },
                ],
              },
            ],
          ]);
          expect(warningAfterSnapshot).toEqual([true]);
          expect(JSON.stringify(warned.mock.calls)).not.toContain(secret);
          expect(JSON.stringify(body)).not.toContain(secret);
        }
      } finally {
        barrier.mockRestore();
        warned.mockRestore();
        await db.delete(issueEvents).where(
          inArray(
            issueEvents.id,
            inserted.map((row) => row.id),
          ),
        );
      }
    });

    it.each(malformedQueries)(
      "uses schema422 for %s on both calendar endpoints",
      async (_name, query) => {
        for (const path of [
          projectPath(a.slug),
          userPath(subject.user.login),
        ]) {
          await error(
            await t.app.request(`${path}?${query}`, {
              headers: viewer.headers,
            }),
            422,
            "validation_failed",
          );
        }
      },
    );

    it("keeps burn schema and timezone failures at400", async () => {
      for (const query of [
        "from=not-a-date&to=2024-03-01T00%3A00%3A00Z&grain=1d&tz=UTC",
        "from=2024-02-28T00%3A00%3A00Z&to=2024-03-01T00%3A00%3A00Z&grain=1d&tz=Not%2FA_Zone",
      ]) {
        const response = await t.app.request(
          `/api/projects/${a.slug}/insights/burn?${query}`,
          { headers: viewer.headers },
        );
        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorBody).error.code).toBe(
          "validation_failed",
        );
      }
    });

    it("returns every zero day of an empty historic year with no selection", async () => {
      for (const path of [projectPath(a.slug), userPath(subject.user.login)]) {
        const body = await calendar(
          await get(path, { year: "2023", tz: "UTC" }),
        );
        expect(body.year).toBe(2023);
        expect(body.timezone).toBe("UTC");
        expect(body.selection).toBeNull();
        expect(body.days).toHaveLength(365);
        expect(body.days[0]).toEqual({
          date: "2023-01-01",
          state: "recorded",
          count: 0,
        });
        expect(body.days.at(-1)).toEqual({
          date: "2023-12-31",
          state: "recorded",
          count: 0,
        });
        expect(
          body.days.every((day) => day.state === "recorded" && day.count === 0),
        ).toBe(true);
      }
    });

    it("returns an empty selected day when all projects are unreadable", async () => {
      const opened = vi.spyOn(t.ctx.router, "forProject");
      const body = await calendar(
        await get(userPath(outsider.user.id), QUERY, outsider.headers),
      );
      expectSelection(body, 0, []);
      expectComplete(body);
      expect(
        body.days.every((day) => day.state === "recorded" && day.count === 0),
      ).toBe(true);
      expect(opened).not.toHaveBeenCalled();
      await error(
        await get(
          userPath(outsider.user.id),
          { ...QUERY, tz: "Not/A_Zone" },
          outsider.headers,
        ),
        422,
        "validation_failed",
      );
    });

    it("resumes project and user pages through equivalent numeric aliases", async () => {
      for (const [firstPath, secondPath, firstRow, secondRow] of [
        [
          projectPath(oldSlug),
          projectPath(a.id),
          ["calendar-access-a", 2, "Viewer in A"],
          ["calendar-access-a", 1, "Subject in A"],
        ],
        [
          userPath(subject.user.login),
          userPath(subject.user.id),
          ["calendar-access-b", 1, "Subject in B"],
          ["calendar-access-a", 1, "Subject in A"],
        ],
      ] as Array<
        [string, string, [string, number, string], [string, number, string]]
      >) {
        const first = await calendar(
          await get(firstPath, { ...QUERY, limit: "1" }),
        );
        expectSelection(first, 2, [firstRow]);
        expect(first.selection?.has_more).toBe(true);
        const cursor = first.selection?.next_cursor;
        expect(cursor).toEqual(expect.any(String));
        if (!cursor) throw new Error("expected continuation cursor");
        const second = await calendar(
          await get(secondPath, { ...QUERY, limit: "1", after: cursor }),
        );
        expectSelection(second, 2, [secondRow]);
        expectComplete(second);
      }
    });

    it("binds a real cursor to viewer, subject, endpoint, day, timezone and limit", async () => {
      const first = await calendar(
        await get(userPath(subject.user.id), { ...QUERY, limit: "1" }),
      );
      expectSelection(first, 2, [["calendar-access-b", 1, "Subject in B"]]);
      const after = first.selection?.next_cursor;
      if (!after) throw new Error("expected continuation cursor");
      const query = { ...QUERY, limit: "1", after };
      for (const [path, parameters, headers] of [
        [userPath(subject.user.id), query, instanceAdmin.headers],
        [userPath(viewer.user.id), query, viewer.headers],
        [projectPath(a.id), query, viewer.headers],
        [
          userPath(subject.user.id),
          { ...query, day: "2024-02-28" },
          viewer.headers,
        ],
        [
          userPath(subject.user.id),
          { ...query, tz: "Europe/London" },
          viewer.headers,
        ],
        [userPath(subject.user.id), { ...query, limit: "2" }, viewer.headers],
      ] as Array<[string, Record<string, string>, Record<string, string>]>) {
        await error(
          await get(path, parameters, headers),
          422,
          "validation_failed",
        );
      }
    });

    it("returns restart409 after scope revocation between pages and never reopens the revoked project", async () => {
      const first = await calendar(
        await get(userPath(subject.user.id), { ...QUERY, limit: "1" }),
      );
      expectSelection(first, 2, [["calendar-access-b", 1, "Subject in B"]]);
      expect(first.selection?.has_more).toBe(true);
      const after = first.selection?.next_cursor;
      if (!after) throw new Error("expected continuation cursor");
      await removeSeat(b, viewer);
      const opened = vi.spyOn(t.ctx.router, "forProject");
      try {
        const body = await error(
          await get(userPath(subject.user.id), { ...QUERY, limit: "1", after }),
          409,
          "conflict",
        );
        expect(body.error.details).toEqual({
          reason: "activity_changed",
          restart: true,
        });
        expect(opened.mock.calls.map(([project]) => project.id)).not.toContain(
          b.id,
        );
        const restarted = await calendar(await get(userPath(subject.user.id)));
        expectSelection(restarted, 1, [
          ["calendar-access-a", 1, "Subject in A"],
        ]);
        expectComplete(restarted);
      } finally {
        opened.mockRestore();
        await addSeat(b, viewer);
      }
    });

    it("retries once when readable scope changes after a completed snapshot", async () => {
      let snapshots = 0;
      const barrier = afterSnapshot(async (projectId) => {
        if (projectId === a.id && ++snapshots === 1)
          await removeSeat(b, viewer);
      });
      try {
        const body = await calendar(await get(userPath(subject.user.id)));
        expectSelection(body, 1, [["calendar-access-a", 1, "Subject in A"]]);
        expectComplete(body);
        expect(snapshots).toBe(2);
      } finally {
        barrier.mockRestore();
        await addSeat(b, viewer);
      }
    });

    it("returns restart409 if scope changes again on the retry", async () => {
      let snapshots = 0;
      const barrier = afterSnapshot(async (projectId) => {
        if (projectId !== a.id) return;
        snapshots++;
        if (snapshots === 1) await removeSeat(b, viewer);
        else await addSeat(b, viewer);
      });
      try {
        const body = await error(
          await get(userPath(subject.user.id)),
          409,
          "conflict",
        );
        expect(body.error.details).toEqual({
          reason: "activity_changed",
          restart: true,
        });
        expect(snapshots).toBe(2);
      } finally {
        barrier.mockRestore();
        await addSeat(b, viewer);
      }
    });

    it("rechecks project access after a completed snapshot", async () => {
      let revoked = false;
      const barrier = afterSnapshot(async (projectId) => {
        if (projectId === a.id && !revoked) {
          revoked = true;
          await removeSeat(a, viewer);
        }
      });
      try {
        const body = await error(
          await get(projectPath(oldSlug)),
          404,
          "not_found",
        );
        expect(revoked).toBe(true);
        expect(body).toEqual({
          error: { code: "not_found", message: "project not found" },
        });
      } finally {
        barrier.mockRestore();
        await addSeat(a, viewer);
      }
    });

    it("rechecks subject visibility after the snapshot even when viewer scope stays unchanged", async () => {
      let hidden = false;
      const barrier = afterSnapshot(async (projectId) => {
        if (projectId === a.id && !hidden) {
          hidden = true;
          await removeSeat(a, subject);
        }
      });
      try {
        const body = await error(
          await get(userPath(subject.user.id)),
          404,
          "not_found",
        );
        expect(hidden).toBe(true);
        expect(body).toEqual({
          error: { code: "not_found", message: "user not found" },
        });
      } finally {
        barrier.mockRestore();
        await addSeat(a, subject);
      }
    });

    it.each(["project", "user"] as const)(
      "propagates %s database-open failures and maps them to500",
      async (scope) => {
        const failure = new Error("calendar fixture database unavailable");
        const opened = vi
          .spyOn(t.ctx.router, "forProject")
          .mockRejectedValue(failure);
        const service =
          scope === "project"
            ? getProjectActivityCalendar
            : getUserActivityCalendar;
        const ref = scope === "project" ? a.slug : subject.user.login;
        await expect(
          service(t.ctx, viewer.user, ref, SERVICE_QUERY),
        ).rejects.toBe(failure);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        const response = await get(
          scope === "project" ? projectPath(ref) : userPath(ref),
        );
        const body = await error(response, 500, "internal");
        expect(body).toEqual({
          error: { code: "internal", message: "internal server error" },
        });
        expect(logged).toHaveBeenCalledWith("unhandled error", failure);
        expect(opened).toHaveBeenCalled();
      },
    );

    it("propagates snapshot SQL failures without returning a partial user calendar", async () => {
      const failure = new Error("calendar fixture snapshot failed");
      const original = t.ctx.router.forProject.bind(t.ctx.router);
      let failedTransactions = 0;
      vi.spyOn(t.ctx.router, "forProject").mockImplementation(
        async (project) => {
          const db = await original(project);
          if (project.id !== b.id) return db;
          return new Proxy(db, {
            get(target, key) {
              if (key === "transaction") {
                const transaction: Db["transaction"] = (callback, config) =>
                  target.transaction(
                    (tx) =>
                      callback(
                        new Proxy(tx, {
                          get(snapshot, property) {
                            if (property === "execute") {
                              return async () => {
                                failedTransactions++;
                                throw failure;
                              };
                            }
                            const value = Reflect.get(snapshot, property);
                            return typeof value === "function"
                              ? value.bind(snapshot)
                              : value;
                          },
                        }),
                      ),
                    config,
                  );
                return transaction;
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      );
      await expect(
        getUserActivityCalendar(
          t.ctx,
          viewer.user,
          subject.user.login,
          SERVICE_QUERY,
        ),
      ).rejects.toBe(failure);
      expect(failedTransactions).toBe(1);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const body = await error(
        await get(userPath(subject.user.id)),
        500,
        "internal",
      );
      expect(body).toEqual({
        error: { code: "internal", message: "internal server error" },
      });
      expect(logged).toHaveBeenCalledWith("unhandled error", failure);
      expect(failedTransactions).toBe(2);
    });
  },
);
