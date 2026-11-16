import { TodouClient } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  type ActivityCardRef,
  resolveActivityCards,
} from "../src/activity-cards.ts";
import { type Captured, fakeFetch, type Route } from "./harness.ts";

/**
 * T-286's fetching half. Every assertion here is about the *requests*, not
 * only the answer: the module catches every failure by design, so a route
 * table this code never matches would have every card come back missing —
 * and a test that only read the returned lookup would pass just as happily
 * with no requests sent at all.
 */

const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

/** `todou` is id 2 and the project being read; `acme` is id 7. */
const spelling = {
  refPrefix: "T",
  projectId: 2,
  slugOfProject: (id: unknown) =>
    id === 2 ? "todou" : id === 7 ? "acme" : null,
};

const opened = (project: string, number: number): ActivityCardRef => ({
  ...spelling,
  project,
  number,
  item: {
    type: "event",
    id: number * 10,
    event_type: "opened",
    actor,
    payload: {},
    created_at: "2026-08-11T12:00:00.000Z",
    agent_context: null,
  },
});

const referenced = (
  project: string,
  number: number,
  payload: Record<string, unknown>,
): ActivityCardRef => ({
  ...spelling,
  project,
  number,
  item: {
    type: "event",
    id: 900 + number,
    event_type: "referenced",
    actor,
    payload,
    created_at: "2026-08-11T12:00:00.000Z",
    agent_context: null,
  },
});

const commented = (project: string, number: number): ActivityCardRef => ({
  ...spelling,
  project,
  number,
  item: {
    type: "comment",
    id: 757,
    author: actor,
    body: "hello",
    component: null,
    created_at: "2026-08-11T12:00:00.000Z",
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
  },
});

const card = (number: number, title: string, body = "") => ({
  number,
  title,
  body,
});

function stub(routes: Route[]) {
  const { fetchImpl, calls } = fakeFetch(routes);
  return { client: new TodouClient({ fetch: fetchImpl }), calls };
}

/** The `numbers=` list of every issue-list request, in order. */
const listed = (calls: Captured[], slug: string): string[] =>
  calls
    .filter(
      (c) =>
        new URL(c.url, "http://stub.test").pathname ===
        `/api/projects/${slug}/issues`,
    )
    .map(
      (c) =>
        new URL(c.url, "http://stub.test").searchParams.get("numbers") ?? "",
    );

const singles = (calls: Captured[]): string[] =>
  calls
    .map((c) => new URL(c.url, "http://stub.test").pathname)
    .filter((p) => /^\/api\/projects\/[^/]+\/issues\/\d+$/.test(p));

describe("resolveActivityCards", () => {
  it("reads an opened card whole and the reference targets as one list", async () => {
    const { client, calls } = stub([
      [
        "GET",
        "/api/projects/todou/issues/146",
        card(146, "读不到项目时给一条无差别提示", "第一行\n第二行"),
      ],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [card(281, "评论 collapse"), card(30, "另一张")] },
      ],
    ]);
    const { cardOf } = await resolveActivityCards(client, [
      opened("todou", 146),
      referenced("todou", 30, { by_project_id: 2, by_issue: 281 }),
      referenced("todou", 30, { by_project_id: 2, by_issue: 30 }),
      commented("todou", 7),
    ]);

    expect(cardOf("todou", 146)).toEqual({
      title: "读不到项目时给一条无差别提示",
      body: "第一行\n第二行",
    });
    expect(cardOf("todou", 281)?.title).toBe("评论 collapse");
    // One request for both targets, and no single-card read for either: the
    // list endpoint exists precisely to batch-resolve #N references.
    expect(listed(calls, "todou")).toEqual(["281,30"]);
    expect(singles(calls)).toEqual(["/api/projects/todou/issues/146"]);
  });

  it("sends nothing at all for a batch that mentions no other card", async () => {
    const { client, calls } = stub([]);
    const { cardOf } = await resolveActivityCards(client, [
      commented("todou", 7),
      // A project id nobody can name: there is no slug to ask under, so the
      // line degrades to `by 99/7` and this costs no request.
      referenced("todou", 7, { by_project_id: 99, by_issue: 4 }),
    ]);
    expect(cardOf("todou", 7)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("chunks past the list endpoint's 100-number cap", async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1);
    const { client, calls } = stub([
      [
        "GET",
        "/api/projects/todou/issues",
        (_init: RequestInit, url: URL) => ({
          items: (url.searchParams.get("numbers") ?? "")
            .split(",")
            .map((n) => card(Number(n), `card ${n}`)),
        }),
      ],
    ]);
    const { cardOf } = await resolveActivityCards(
      client,
      numbers.map((n) =>
        referenced("todou", 7, { by_project_id: 2, by_issue: n }),
      ),
    );

    const requests = listed(calls, "todou");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.split(",")).toHaveLength(100);
    expect(requests[1]).toBe("101");
    expect(cardOf("todou", 101)?.title).toBe("card 101");
  });

  it("groups by project, one list request each", async () => {
    const { client, calls } = stub([
      ["GET", "/api/projects/todou/issues", { items: [card(281, "本项目")] }],
      ["GET", "/api/projects/acme/issues", { items: [card(31, "隔壁")] }],
    ]);
    const { cardOf } = await resolveActivityCards(client, [
      referenced("todou", 30, { by_project_id: 2, by_issue: 281 }),
      referenced("todou", 30, { by_project_id: 7, by_issue: 31 }),
      // Pre-T-266 payloads name the project by slug; same group as above.
      referenced("todou", 30, { by_project: "acme", by_issue: 31 }),
    ]);
    expect(cardOf("todou", 281)?.title).toBe("本项目");
    expect(cardOf("acme", 31)?.title).toBe("隔壁");
    expect(listed(calls, "todou")).toEqual(["281"]);
    expect(listed(calls, "acme")).toEqual(["31"]);
  });

  it("skips a card the whole-card read already covers", async () => {
    const { client, calls } = stub([
      ["GET", "/api/projects/todou/issues/146", card(146, "自己", "正文")],
    ]);
    const { cardOf } = await resolveActivityCards(client, [
      opened("todou", 146),
      referenced("todou", 30, { by_project_id: 2, by_issue: 146 }),
    ]);
    expect(cardOf("todou", 146)?.body).toBe("正文");
    // No list request survives: its only number was read whole already, and
    // an empty `numbers=` would have asked for the project's newest cards.
    expect(listed(calls, "todou")).toEqual([]);
  });

  /**
   * The reason nothing here throws: these reads happen inside a drain that
   * `retryTransient` wraps, so one 404 on a trashed card would spend the
   * retry budget of a watch that is meant to stay up for hours.
   */
  it("survives a 404 and a dead connection, losing only those cards", async () => {
    const { client } = stub([
      ["GET", "/api/projects/todou/issues/146", { __status: 404 }],
      [
        "GET",
        "/api/projects/todou/issues",
        () => {
          throw new Error("ECONNRESET");
        },
      ],
      ["GET", "/api/projects/acme/issues", { items: [card(31, "隔壁")] }],
    ]);
    const { cardOf } = await resolveActivityCards(client, [
      opened("todou", 146),
      referenced("todou", 30, { by_project_id: 2, by_issue: 281 }),
      referenced("todou", 30, { by_project_id: 7, by_issue: 31 }),
    ]);
    expect(cardOf("todou", 146)).toBeUndefined();
    expect(cardOf("todou", 281)).toBeUndefined();
    // The read that worked still counts — one failure is not the batch's.
    expect(cardOf("acme", 31)?.title).toBe("隔壁");
  });
});

/** T-697: an assignment payload stores a login and nothing else. */
describe("resolveActivityCards names", () => {
  const assigned = (
    project: string,
    eventType: "assigned" | "opened",
    payload: Record<string, unknown>,
  ): ActivityCardRef => ({
    ...spelling,
    project,
    number: 30,
    item: {
      type: "event",
      id: 300,
      event_type: eventType,
      actor,
      payload,
      created_at: "2026-08-11T12:00:00.000Z",
      agent_context: null,
    },
  });

  const member = (login: string, display_name: string) => ({
    user: { ...actor, login, display_name },
    role: "writer",
  });

  const membersRead = (calls: Captured[]): string[] =>
    calls
      .map((c) => new URL(c.url, "http://stub.test").pathname)
      .filter((p) => p.endsWith("/members"));

  it("reads each project's members once for the logins its payloads carry", async () => {
    const { client, calls } = stub([
      [
        "GET",
        "/api/projects/todou/members",
        [member("bot-one", "Bot One"), member("newcomer", " ")],
      ],
      ["GET", "/api/projects/acme/members", [member("alice", "Alice")]],
    ]);
    const { nameOf } = await resolveActivityCards(client, [
      assigned("todou", "assigned", { user: { id: 3, login: "bot-one" } }),
      assigned("todou", "assigned", { user: { id: 4, login: "newcomer" } }),
      assigned("acme", "opened", {
        status: { id: 1, name: "Todo" },
        labels: [],
        assignees: [{ id: 9, login: "alice" }],
      }),
    ]);
    expect(nameOf("todou", "bot-one")).toBe("Bot One");
    // A blank display name is no name: the line keeps the bare login.
    expect(nameOf("todou", "newcomer")).toBeUndefined();
    expect(nameOf("acme", "alice")).toBe("Alice");
    expect(membersRead(calls).sort()).toEqual([
      "/api/projects/acme/members",
      "/api/projects/todou/members",
    ]);
  });

  it("reads no members for a batch that names nobody by login", async () => {
    const { client, calls } = stub([]);
    const { nameOf } = await resolveActivityCards(client, [
      commented("todou", 7),
      assigned("todou", "opened", {
        status: { id: 1, name: "Todo" },
        labels: [],
        assignees: [],
      }),
    ]);
    expect(nameOf("todou", "user")).toBeUndefined();
    expect(membersRead(calls)).toEqual([]);
  });

  it("survives a members read that fails", async () => {
    const { client } = stub([
      ["GET", "/api/projects/todou/members", { __status: 403 }],
    ]);
    const { nameOf } = await resolveActivityCards(client, [
      assigned("todou", "assigned", { user: { id: 3, login: "bot-one" } }),
    ]);
    expect(nameOf("todou", "bot-one")).toBeUndefined();
  });
});
