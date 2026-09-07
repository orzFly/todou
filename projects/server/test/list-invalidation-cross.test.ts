import type { IssueListFilter } from "@todou/shared";
import { admitsRow } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * `admitsRow` (client side) and `issueFilterConditions` (SQL) are two
 * implementations of one semantics, and this is the only thing pinning them
 * together: generate filter/card combinations, ask the real list endpoint who
 * is in, ask `admitsRow` about each card, and require the same answer. Adding
 * a filter dimension to the list without teaching `admitsRow` about it fails
 * here before it can silently skip a page that should have refetched.
 *
 * Trashed cards are deliberately absent from the corpus: liveness is not one
 * of `admitsRow`'s dimensions, because a card entering or leaving the trash
 * publishes `{kind:"gone"}` or a fresh `fields` rather than asking anyone to
 * derive it.
 */
describe("admitsRow agrees with the list SQL (T-279)", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "cross";
  const headers = () => ({ "content-type": "application/json", cookie });

  type Card = {
    number: number;
    status_id: number;
    label_ids: number[];
    assignee_ids: number[];
  };

  const cards: Card[] = [];
  let statusIds: number[] = [];
  const labelIds: number[] = [];
  let assigneeIds: number[] = [];
  let categoryById = new Map<number, "open" | "closed">();

  const categoryOf = (id: number) => categoryById.get(id);

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const project = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Cross" }),
    });
    expect(project.status).toBe(201);

    const statuses: Array<{ id: number; category: "open" | "closed" }> =
      await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: headers(),
        }),
      );
    categoryById = new Map(statuses.map((s) => [s.id, s.category]));
    // Both categories have to be represented, or every `category` filter in
    // the sweep below would be answered by the same trivial partition.
    expect(new Set(statuses.map((s) => s.category))).toEqual(
      new Set(["open", "closed"]),
    );
    const open = statuses.filter((s) => s.category === "open").map((s) => s.id);
    const closed = statuses
      .filter((s) => s.category === "closed")
      .map((s) => s.id);
    statusIds = [open[0] as number, open[1] as number, closed[0] as number];

    for (const name of ["alpha", "beta"]) {
      const label = await json(
        await t.app.request(`/api/projects/${slug}/labels`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ name, color: "#123456" }),
        }),
      );
      labelIds.push(label.id);
    }

    const other = await addUserWithToken(t.ctx, "cross-other");
    const member = await t.app.request(
      `/api/projects/${slug}/members/${other.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
    assigneeIds = [me.id, other.user.id];

    // Every dimension varied against every other, including the empty set on
    // each: a corpus where labels and assignees moved together could not
    // catch a rule that reads the wrong one.
    const spec: Array<Omit<Card, "number">> = [
      { status_id: statusIds[0] as number, label_ids: [], assignee_ids: [] },
      {
        status_id: statusIds[0] as number,
        label_ids: [labelIds[0] as number],
        assignee_ids: [assigneeIds[0] as number],
      },
      {
        status_id: statusIds[0] as number,
        label_ids: [labelIds[1] as number],
        assignee_ids: [assigneeIds[1] as number],
      },
      {
        status_id: statusIds[1] as number,
        label_ids: labelIds.slice(),
        assignee_ids: [],
      },
      {
        status_id: statusIds[1] as number,
        label_ids: [],
        assignee_ids: assigneeIds.slice(),
      },
      {
        status_id: statusIds[2] as number,
        label_ids: [labelIds[0] as number],
        assignee_ids: [assigneeIds[1] as number],
      },
      {
        status_id: statusIds[2] as number,
        label_ids: [labelIds[1] as number],
        assignee_ids: [assigneeIds[0] as number],
      },
      { status_id: statusIds[2] as number, label_ids: [], assignee_ids: [] },
    ];

    for (const [i, card] of spec.entries()) {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          title: `cross ${i}`,
          status_id: card.status_id,
          label_ids: card.label_ids,
          assignee_ids: card.assignee_ids,
        }),
      });
      expect(res.status).toBe(201);
      cards.push({ ...card, number: (await json(res)).number });
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  /** Who the server says is in this filter's result set. */
  const membersOf = async (filter: IssueListFilter): Promise<Set<number>> => {
    const params = new URLSearchParams({ limit: "100" });
    if (filter.status) params.set("status", filter.status.join(","));
    if (filter.label) params.set("label", filter.label.join(","));
    if (filter.assignee) params.set("assignee", String(filter.assignee));
    if (filter.category) params.set("category", filter.category);
    const res = await t.app.request(
      `/api/projects/${slug}/issues?${params.toString()}`,
      { headers: headers() },
    );
    expect(res.status).toBe(200);
    const page = await json(res);
    // A truncated page would make "absent" mean "on the next page" and the
    // comparison below would read as a disagreement.
    expect(page.next_cursor).toBeNull();
    return new Set(page.items.map((i: { number: number }) => i.number));
  };

  it("gives the same answer as the server for every filter combination", async () => {
    const statusChoices = [
      undefined,
      [statusIds[0] as number],
      [statusIds[0] as number, statusIds[2] as number],
    ];
    const labelChoices = [
      undefined,
      [labelIds[0] as number],
      [labelIds[0] as number, labelIds[1] as number],
    ];
    const assigneeChoices = [undefined, assigneeIds[0], assigneeIds[1]];
    const categoryChoices = [undefined, "open" as const, "closed" as const];

    const disagreements: string[] = [];
    let comparisons = 0;
    for (const status of statusChoices) {
      for (const label of labelChoices) {
        for (const assignee of assigneeChoices) {
          for (const category of categoryChoices) {
            const filter: IssueListFilter = {
              ...(status ? { status } : {}),
              ...(label ? { label } : {}),
              ...(assignee ? { assignee } : {}),
              ...(category ? { category } : {}),
            };
            const members = await membersOf(filter);
            for (const card of cards) {
              const verdict = admitsRow(
                filter,
                {
                  kind: "fields",
                  status_id: card.status_id,
                  label_ids: card.label_ids,
                  assignee_ids: card.assignee_ids,
                },
                undefined,
                categoryOf,
              );
              comparisons += 1;
              // "unknown" counts as a disagreement: with every field in hand
              // and a complete status map there is nothing left to not know,
              // so an unknown here means a dimension went unhandled.
              if (verdict !== members.has(card.number)) {
                disagreements.push(
                  `${JSON.stringify(filter)} × #${card.number} ` +
                    `(status ${card.status_id}, labels [${card.label_ids}], ` +
                    `assignees [${card.assignee_ids}]): ` +
                    `admitsRow ${JSON.stringify(verdict)}, ` +
                    `server ${members.has(card.number)}`,
                );
              }
            }
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    expect(comparisons).toBe(
      statusChoices.length *
        labelChoices.length *
        assigneeChoices.length *
        categoryChoices.length *
        cards.length,
    );
  });

  it("uses a cached set for a dimension the verdict left out", async () => {
    // The omission case, which the sweep above cannot reach because it always
    // supplies both sets: a save that touched only the status says nothing
    // about labels, and the client's own copy of the row is what fills it in.
    const card = cards.find((c) => c.label_ids.length > 0) as Card;
    const filter: IssueListFilter = { label: [card.label_ids[0] as number] };
    const members = await membersOf(filter);
    expect(members.has(card.number)).toBe(true);
    expect(
      admitsRow(
        filter,
        { kind: "fields", status_id: card.status_id },
        { label_ids: card.label_ids },
        categoryOf,
      ),
    ).toBe(true);
    // …and without it there is nothing to judge on, which costs a refetch
    // rather than a wrong skip.
    expect(
      admitsRow(filter, { kind: "fields", status_id: card.status_id }),
    ).toBe("unknown");
  });
});
