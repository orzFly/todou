import type { ChangeEvent } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  issueEvents,
  issueMetadata,
  issues,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

/**
 * Metadata: the table, the three routes, and the four silence properties
 * (T-282).
 */
describe("issue metadata", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "meta";

  /** The admin who owns the project, acting through the session cookie. */
  let owner: Who;
  let reader: Who;
  let writer: Who;
  let outsider: Who;
  /** Whose inbox and unread markers must not move when metadata is written. */
  let bystander: Who;

  let card = 0;
  let projectId = 0;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json", ...who } : who),
        ...init?.headers,
      },
    });

  const write = (number: number, who: Who, entries: unknown[]) =>
    req(`/projects/${slug}/issues/${number}/metadata`, who, {
      method: "PATCH",
      body: JSON.stringify({ entries }),
    });

  const read = (number: number, who: Who, namespace: string) =>
    req(
      `/projects/${slug}/issues/${number}/metadata?namespace=${encodeURIComponent(namespace)}`,
      who,
    );

  /** The entries of one namespace as `key → value`, for compact assertions. */
  const valuesOf = async (
    number: number,
    who: Who,
    namespace: string,
  ): Promise<Record<string, string>> => {
    const res = await read(number, who, namespace);
    expect(res.status).toBe(200);
    const body = await json(res);
    return Object.fromEntries(
      body.entries.map((e: { key: string; value: string }) => [e.key, e.value]),
    );
  };

  const newCard = async (title: string): Promise<number> => {
    const created = await req(`/projects/${slug}/issues`, owner, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(created.status).toBe(201);
    return (await json(created)).number as number;
  };

  const addMember = async (login: string, role: string): Promise<Who> => {
    const added = await addUserWithToken(t.ctx, login);
    const res = await req(`/projects/${slug}/members/${added.user.id}`, owner, {
      method: "PUT",
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
    return added.headers;
  };

  /**
   * How many statements the project database ran while `body` did its work.
   * Every drizzle query goes through the session's `prepareQuery`, so one
   * wrapper there sees the builders, the transactions and the raw
   * `execute`s alike.
   */
  const countQueries = async (body: () => unknown) => {
    const { db } = await issueRow(card);
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the driver
    const session = (db as any).session;
    const original = session.prepareQuery.bind(session);
    let count = 0;
    session.prepareQuery = (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
    try {
      await body();
    } finally {
      session.prepareQuery = original;
    }
    return count;
  };

  /** Every change event published while `body` runs. */
  const eventsDuring = async (body: () => Promise<void>) => {
    const seen: ChangeEvent[] = [];
    const off = t.ctx.bus.subscribe((_projectId, event) => {
      seen.push(event);
    });
    try {
      await body();
    } finally {
      off();
    }
    return seen;
  };

  const issueRow = async (number: number) => {
    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: projectId,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
    const row = rows[0];
    if (!row) throw new Error("issue row missing");
    return { db, row };
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    owner = { cookie };
    const created = await req("/projects", owner, {
      method: "POST",
      body: JSON.stringify({ slug, name: "Metadata" }),
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id as number;

    reader = await addMember("meta-reader", "reader");
    writer = await addMember("meta-writer", "writer");
    bystander = await addMember("meta-bystander", "writer");
    outsider = (await addUserWithToken(t.ctx, "meta-outsider")).headers;

    card = await newCard("the card metadata is written on");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("writing", () => {
    it("touches only the keys it lists, and answers with the whole namespace", async () => {
      const number = await newCard("selective writes");
      const first = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "brainstorm" },
        { namespace: "orch", key: "owner", value: "planner" },
      ]);
      expect(first.status).toBe(200);

      const second = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      expect(second.status).toBe(200);
      // The response is the namespace's full new state, so a caller never
      // has to GET after a write.
      expect(
        (await json(second)).entries.map(
          (e: { key: string; value: string }) => [e.key, e.value],
        ),
      ).toEqual([
        ["owner", "planner"],
        ["phase", "plan"],
      ]);
    });

    it("deletes with null and keeps the empty string as a value", async () => {
      const number = await newCard("null versus empty");
      await write(number, writer, [
        { namespace: "orch", key: "gone", value: "here" },
        { namespace: "orch", key: "blank", value: "" },
      ]);

      const after = await write(number, writer, [
        { namespace: "orch", key: "gone", value: null },
      ]);
      expect(after.status).toBe(200);
      expect(await valuesOf(number, writer, "orch")).toEqual({ blank: "" });
    });

    it("writes across namespaces in one request", async () => {
      const number = await newCard("two namespaces at once");
      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "impl" },
        { namespace: "ci", key: "last-run", value: "green" },
      ]);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(
        body.entries.map((e: { namespace: string; key: string }) => [
          e.namespace,
          e.key,
        ]),
      ).toEqual([
        ["ci", "last-run"],
        ["orch", "phase"],
      ]);
    });

    it("names the writer and the moment on every entry", async () => {
      const number = await newCard("provenance");
      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "spec" },
      ]);
      const [entry] = (await json(res)).entries;
      expect(entry.updated_by.login).toBe("meta-writer");
      expect(Date.parse(entry.updated_at)).not.toBeNaN();
    });

    it("rejects an empty entry list and a key named twice", async () => {
      // 422 is what this app answers a schema violation with, everywhere.
      const empty = await write(card, writer, []);
      expect(empty.status).toBe(422);

      const twice = await write(card, writer, [
        { namespace: "orch", key: "phase", value: "a" },
        { namespace: "orch", key: "phase", value: "b" },
      ]);
      expect(twice.status).toBe(422);
    });

    it("stores a value of exactly the byte limit", async () => {
      // Guards the index shape as much as the limit: `value` in the
      // reverse-lookup index would make this INSERT fail on the btree entry
      // size, long after anyone remembers why.
      const number = await newCard("a full-size value");
      const res = await write(number, writer, [
        { namespace: "big", key: "blob", value: "x".repeat(4096) },
      ]);
      expect(res.status).toBe(200);
      expect((await valuesOf(number, writer, "big")).blob).toHaveLength(4096);
    });
  });

  describe("a write that changes nothing", () => {
    it("leaves updated_at alone and publishes no event", async () => {
      const number = await newCard("replayed state");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const [before] = (await json(await read(number, writer, "orch"))).entries;

      const events = await eventsDuring(async () => {
        const again = await write(number, writer, [
          { namespace: "orch", key: "phase", value: "plan" },
        ]);
        expect(again.status).toBe(200);
      });

      const [after] = (await json(await read(number, writer, "orch"))).entries;
      expect(after.updated_at).toBe(before.updated_at);
      expect(events.filter((e) => e.entity === "metadata")).toEqual([]);
    });

    it("says nothing when a key that does not exist is deleted", async () => {
      const number = await newCard("deleting nothing");
      const events = await eventsDuring(async () => {
        const res = await write(number, writer, [
          { namespace: "orch", key: "never-was", value: null },
        ]);
        expect(res.status).toBe(200);
        expect((await json(res)).entries).toEqual([]);
      });
      expect(events.filter((e) => e.entity === "metadata")).toEqual([]);
    });
  });

  describe("if_match", () => {
    it("writes when the expected value is the stored one", async () => {
      const number = await newCard("cas hit");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const res = await write(number, writer, [
        {
          namespace: "orch",
          key: "phase",
          value: "impl",
          if_match: "plan",
        },
      ]);
      expect(res.status).toBe(200);
      expect(await valuesOf(number, writer, "orch")).toEqual({ phase: "impl" });
    });

    it("creates when the key is expected to be absent", async () => {
      const number = await newCard("cas absent");
      const res = await write(number, writer, [
        { namespace: "orch", key: "claim", value: "agent-1", if_match: null },
      ]);
      expect(res.status).toBe(200);

      const second = await write(number, writer, [
        { namespace: "orch", key: "claim", value: "agent-2", if_match: null },
      ]);
      expect(second.status).toBe(409);
      const body = await json(second);
      expect(body.error.code).toBe("metadata_precondition");
      expect(body.error.details.failed).toEqual([
        { namespace: "orch", key: "claim", current: "agent-1" },
      ]);
      // The loser of the race learns the winner without a second request.
      expect(await valuesOf(number, writer, "orch")).toEqual({
        claim: "agent-1",
      });
    });

    it("reports a null current value for a key that is not there", async () => {
      const number = await newCard("cas on a missing key");
      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
      ]);
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.failed).toEqual([
        { namespace: "orch", key: "phase", current: null },
      ]);
    });

    it("deletes only when the value still matches", async () => {
      const number = await newCard("cas delete");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const wrong = await write(number, writer, [
        { namespace: "orch", key: "phase", value: null, if_match: "impl" },
      ]);
      expect(wrong.status).toBe(409);
      expect(await valuesOf(number, writer, "orch")).toEqual({ phase: "plan" });

      const right = await write(number, writer, [
        { namespace: "orch", key: "phase", value: null, if_match: "plan" },
      ]);
      expect(right.status).toBe(200);
      expect(await valuesOf(number, writer, "orch")).toEqual({});
    });

    it("verifies without writing when the expectation equals the new value", async () => {
      const number = await newCard("cas no-op");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const [before] = (await json(await read(number, writer, "orch"))).entries;

      const events = await eventsDuring(async () => {
        const res = await write(number, writer, [
          {
            namespace: "orch",
            key: "phase",
            value: "plan",
            if_match: "plan",
          },
        ]);
        expect(res.status).toBe(200);
      });
      const [after] = (await json(await read(number, writer, "orch"))).entries;
      expect(after.updated_at).toBe(before.updated_at);
      expect(events.filter((e) => e.entity === "metadata")).toEqual([]);
    });

    it("stores nothing at all when one key of several fails", async () => {
      const number = await newCard("all or nothing");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "impl", if_match: "plan" },
        { namespace: "ci", key: "run", value: "green", if_match: "red" },
      ]);
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.failed).toEqual([
        { namespace: "ci", key: "run", current: null },
      ]);
      // The first entry would have succeeded on its own; the transaction
      // took it back with the second.
      expect(await valuesOf(number, writer, "orch")).toEqual({ phase: "plan" });
      expect(await valuesOf(number, writer, "ci")).toEqual({});
    });
  });

  describe("limits", () => {
    const rejected = async (entry: Record<string, unknown>) => {
      const res = await write(card, writer, [entry]);
      expect(res.status).toBe(422);
    };

    it("rejects namespaces and keys outside the character set", async () => {
      await rejected({ namespace: "Orch", key: "phase", value: "x" });
      await rejected({ namespace: "orch", key: "Phase", value: "x" });
      await rejected({ namespace: "-orch", key: "phase", value: "x" });
      await rejected({ namespace: "orch", key: "phase-", value: "x" });
      await rejected({ namespace: "or/ch", key: "phase", value: "x" });
      await rejected({ namespace: "", key: "phase", value: "x" });
      await rejected({ namespace: "o".repeat(64), key: "phase", value: "x" });
      await rejected({ namespace: "orch", key: "k".repeat(129), value: "x" });
    });

    it("measures the value in bytes, not characters", async () => {
      // 1366 CJK characters are 4098 bytes and would pass a character check
      // by a wide margin.
      await rejected({
        namespace: "orch",
        key: "note",
        value: "字".repeat(1366),
      });
      const fits = await write(card, writer, [
        { namespace: "orch", key: "note", value: "字".repeat(1365) },
      ]);
      expect(fits.status).toBe(200);
    });

    it("caps namespaces per issue and keys per namespace", async () => {
      const number = await newCard("quotas");
      const nine = Array.from({ length: 9 }, (_, i) => ({
        namespace: `ns${i}`,
        key: "k",
        value: "v",
      }));
      const tooMany = await write(number, writer, nine);
      expect(tooMany.status).toBe(422);
      expect((await json(tooMany)).error.details).toEqual({
        limit: "namespaces_per_issue",
        max: 8,
      });
      // Nothing landed, so the card is still empty.
      expect(await valuesOf(number, writer, "*")).toEqual({});

      const thirtyThree = Array.from({ length: 33 }, (_, i) => ({
        namespace: "wide",
        key: `k${i}`,
        value: "v",
      }));
      const tooWide = await write(number, writer, thirtyThree);
      expect(tooWide.status).toBe(422);
      expect((await json(tooWide)).error.details).toEqual({
        limit: "keys_per_namespace",
        max: 32,
      });
    });
  });

  describe("reading", () => {
    it("requires a namespace and understands the star", async () => {
      const number = await newCard("selectors");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
        { namespace: "ci", key: "run", value: "green" },
      ]);

      const bare = await req(
        `/projects/${slug}/issues/${number}/metadata`,
        writer,
      );
      expect(bare.status).toBe(422);

      expect(Object.keys(await valuesOf(number, writer, "orch"))).toEqual([
        "phase",
      ]);
      expect(
        Object.keys(await valuesOf(number, writer, "orch,ci")).sort(),
      ).toEqual(["phase", "run"]);
      expect(Object.keys(await valuesOf(number, writer, "*")).sort()).toEqual([
        "phase",
        "run",
      ]);
      // A namespace nobody wrote to is absent, not empty.
      expect(await valuesOf(number, writer, "nothing-here")).toEqual({});
    });

    it("lists namespaces with their size and newest write", async () => {
      const number = await newCard("namespace summary");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
        { namespace: "ci", key: "run", value: "green" },
      ]);
      await write(number, writer, [
        { namespace: "orch", key: "owner", value: "planner" },
      ]);

      const res = await req(
        `/projects/${slug}/issues/${number}/metadata/namespaces`,
        writer,
      );
      expect(res.status).toBe(200);
      const { namespaces } = await json(res);
      expect(namespaces.map((n: { namespace: string }) => n.namespace)).toEqual(
        ["ci", "orch"],
      );
      const orch = namespaces.find(
        (n: { namespace: string }) => n.namespace === "orch",
      );
      const ci = namespaces.find(
        (n: { namespace: string }) => n.namespace === "ci",
      );
      expect(orch.keys).toBe(2);
      expect(ci.keys).toBe(1);
      // The group's newest write, not its oldest: `owner` arrived second.
      expect(Date.parse(orch.updated_at)).toBeGreaterThanOrEqual(
        Date.parse(ci.updated_at),
      );
      // Values are not part of this answer.
      expect(orch.value).toBeUndefined();
    });
  });

  describe("fetched alongside the card", () => {
    it("tells 'nobody asked' apart from 'nothing there'", async () => {
      const number = await newCard("bundled on a card");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);

      const silent = await json(
        await req(`/projects/${slug}/issues/${number}`, writer),
      );
      expect("metadata" in silent).toBe(false);

      const empty = await json(
        await req(`/projects/${slug}/issues/${number}?metadata=ci`, writer),
      );
      expect(empty.metadata).toEqual([]);

      const asked = await json(
        await req(`/projects/${slug}/issues/${number}?metadata=orch`, writer),
      );
      // Byte for byte what the standalone endpoint answers, so a client may
      // use either without learning two shapes.
      expect(asked.metadata).toEqual(
        (await json(await read(number, writer, "orch"))).entries,
      );
    });

    it("carries the same field on a list row", async () => {
      const number = await newCard("bundled on a list row");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "impl" },
      ]);
      const [item] = (
        await json(
          await req(
            `/projects/${slug}/issues?numbers=${number}&metadata=orch`,
            writer,
          ),
        )
      ).items;
      expect(item.metadata.map((e: { value: string }) => e.value)).toEqual([
        "impl",
      ]);

      const [silent] = (
        await json(
          await req(`/projects/${slug}/issues?numbers=${number}`, writer),
        )
      ).items;
      expect("metadata" in silent).toBe(false);
    });

    it("leaves the write paths' responses alone", async () => {
      const number = await newCard("writes answer without it");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const patched = await json(
        await req(`/projects/${slug}/issues/${number}`, owner, {
          method: "PATCH",
          body: JSON.stringify({ title: "renamed" }),
        }),
      );
      // Nobody wants metadata back from an edit, and returning it would only
      // make every write response fatter.
      expect("metadata" in patched).toBe(false);
    });

    it("costs one query for a whole page, not one per card", async () => {
      const numbers: number[] = [];
      for (const i of [0, 1, 2, 3, 4]) {
        const number = await newCard(`page card ${i}`);
        await write(number, writer, [
          { namespace: "orch", key: "phase", value: `p${i}` },
        ]);
        numbers.push(number);
      }
      const list = `/projects/${slug}/issues?numbers=${numbers.join(",")}`;

      const plain = await countQueries(() => req(list, writer));
      const withMetadata = await countQueries(() =>
        req(`${list}&metadata=orch`, writer),
      );
      // Counted rather than timed: what has to hold is that the cost does
      // not grow with the page, and a stopwatch cannot say that.
      expect(withMetadata - plain).toBe(1);
    });
  });

  describe("who may read and write", () => {
    it("lets a reader read but not write", async () => {
      const number = await newCard("reader rights");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      expect(await valuesOf(number, reader, "orch")).toEqual({ phase: "plan" });

      const res = await write(number, reader, [
        { namespace: "orch", key: "phase", value: "impl" },
      ]);
      expect(res.status).toBe(403);
    });

    it("lets a writer write on a card somebody else opened", async () => {
      // The whole point: an orchestrator writes to other people's cards.
      const res = await write(card, writer, [
        { namespace: "orch", key: "seen", value: "yes" },
      ]);
      expect(res.status).toBe(200);
    });

    it("tells a non-member nothing", async () => {
      expect((await read(card, outsider, "orch")).status).toBe(404);
      expect(
        (
          await write(card, outsider, [
            { namespace: "orch", key: "phase", value: "x" },
          ])
        ).status,
      ).toBe(404);
    });
  });

  describe("the trash and the move window", () => {
    it("freezes writes to a trashed card and still answers reads", async () => {
      const number = await newCard("in the trash");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const trashed = await req(`/projects/${slug}/issues/${number}`, owner, {
        method: "DELETE",
      });
      expect(trashed.status).toBe(204);

      const blocked = await write(number, owner, [
        { namespace: "orch", key: "phase", value: "impl" },
      ]);
      expect(blocked.status).toBe(409);
      // The admin can see the trash, so reading keeps working there.
      expect(await valuesOf(number, owner, "orch")).toEqual({ phase: "plan" });
    });

    it("freezes writes while the card is being copied elsewhere", async () => {
      const number = await newCard("mid-move");
      const { db, row } = await issueRow(number);
      await db
        .update(issues)
        .set({ movingSince: new Date() })
        .where(eq(issues.id, row.id));

      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "impl" },
      ]);
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("issue_moving");

      await db
        .update(issues)
        .set({ movingSince: null })
        .where(eq(issues.id, row.id));
    });

    it("carries the metadata to the new project and redirects the old address", async () => {
      const elsewhere = `${slug}-elsewhere`;
      const madeB = await req("/projects", owner, {
        method: "POST",
        body: JSON.stringify({ slug: elsewhere, name: "Elsewhere" }),
      });
      expect(madeB.status).toBe(201);

      const number = await newCard("goes elsewhere");
      await write(number, owner, [
        { namespace: "orch", key: "phase", value: "plan" },
        { namespace: "ci", key: "run", value: "green" },
      ]);
      const moved = await req(
        `/projects/${slug}/issues/${number}/move`,
        owner,
        { method: "POST", body: JSON.stringify({ to_project: elsewhere }) },
      );
      expect(moved.status).toBe(200);
      const there = (await json(moved)).moved_to.number as number;

      const arrived = await req(
        `/projects/${elsewhere}/issues/${there}/metadata?namespace=*`,
        owner,
      );
      expect(arrived.status).toBe(200);
      expect(
        (await json(arrived)).entries.map(
          (e: { namespace: string; key: string; value: string }) => [
            e.namespace,
            e.key,
            e.value,
          ],
        ),
      ).toEqual([
        ["ci", "run", "green"],
        ["orch", "phase", "plan"],
      ]);

      // The old address behaves like every other subresource of a moved card
      // (T-245): a read is redirected, a write is refused with the
      // destination named, because whether it still means to happen is the
      // caller's decision.
      expect((await read(number, owner, "orch")).status).toBe(301);
      const refused = await write(number, owner, [
        { namespace: "orch", key: "phase", value: "impl" },
      ]);
      expect(refused.status).toBe(409);
      expect((await json(refused)).error.code).toBe("issue_moved");

      // Nothing was left behind under the tombstone.
      const { db, row } = await issueRow(number);
      expect(
        await db
          .select()
          .from(issueMetadata)
          .where(eq(issueMetadata.issueId, row.id)),
      ).toEqual([]);
    });
  });

  describe("silence", () => {
    it("leaves the card, its timeline and other readers untouched", async () => {
      const number = await newCard("a quiet write");
      // The bystander reads the card first, so anything the write did to
      // their unread state would show up as a change from a known baseline.
      expect(
        (await req(`/projects/${slug}/issues/${number}`, bystander)).status,
      ).toBe(200);
      const marked = await req(
        `/projects/${slug}/issues/${number}/read`,
        bystander,
        { method: "PUT", body: JSON.stringify({}) },
      );
      expect(marked.status).toBe(204);

      const listRow = async () => {
        const res = await req(
          `/projects/${slug}/issues?numbers=${number}`,
          bystander,
        );
        const [item] = (await json(res)).items;
        return item as { unread: boolean; unread_comments: number };
      };
      const inboxHolds = async () => {
        const res = await req("/me/inbox", bystander);
        expect(res.status).toBe(200);
        return (await json(res)).items.some(
          (item: { number: number }) => item.number === number,
        );
      };

      const beforeRow = await listRow();
      const beforeInbox = await inboxHolds();
      const { db, row } = await issueRow(number);
      const beforeUpdatedAt = row.updatedAt.toISOString();

      const res = await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      expect(res.status).toBe(200);

      const { row: after } = await issueRow(number);
      expect(after.updatedAt.toISOString()).toBe(beforeUpdatedAt);

      const timeline = await db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, row.id));
      expect(timeline.map((e) => e.type)).toEqual(["opened"]);

      expect(await listRow()).toEqual(beforeRow);
      expect(await inboxHolds()).toBe(beforeInbox);
    });

    it("publishes one metadata event per changed key and nothing else", async () => {
      const number = await newCard("event shape");
      const events = await eventsDuring(async () => {
        const res = await write(number, writer, [
          { namespace: "orch", key: "phase", value: "plan" },
          { namespace: "orch", key: "owner", value: "planner" },
        ]);
        expect(res.status).toBe(200);
      });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.entity === "metadata")).toBe(true);
      const [first] = events;
      expect(first?.issue_number).toBe(number);
      expect(first?.action).toBe("created");
      expect(first?.metadata).toMatchObject({
        namespace: "orch",
        key: "phase",
        value: "plan",
      });
      expect(first?.metadata?.updated_by.login).toBe("meta-writer");

      const deletion = await eventsDuring(async () => {
        await write(number, writer, [
          { namespace: "orch", key: "phase", value: null },
        ]);
      });
      expect(deletion).toHaveLength(1);
      expect(deletion[0]?.action).toBe("deleted");
      expect(deletion[0]?.metadata?.value).toBeNull();
    });

    it("calls an overwrite an update", async () => {
      const number = await newCard("update action");
      await write(number, writer, [
        { namespace: "orch", key: "phase", value: "plan" },
      ]);
      const events = await eventsDuring(async () => {
        await write(number, writer, [
          { namespace: "orch", key: "phase", value: "impl" },
        ]);
      });
      expect(events.map((e) => e.action)).toEqual(["updated"]);
    });
  });
});
