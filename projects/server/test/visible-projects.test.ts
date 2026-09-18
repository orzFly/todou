import { beforeEach, describe, expect, it, vi } from "vitest";
import { slugHistory } from "../src/db/system-schema.ts";
import { accessibleProjectRows } from "../src/services/access.ts";
import { visibleProjects } from "../src/services/cross-references.ts";
import { redactEventPayloads } from "../src/services/timeline.ts";

vi.mock("../src/services/access.ts", () => ({
  accessibleProjectRows: vi.fn(),
}));

const accessibleRows = vi.mocked(accessibleProjectRows);

function fakeContext(history: { slug: string }[]) {
  const where = vi.fn().mockResolvedValue(history);
  const from = vi.fn((table: unknown) => {
    expect(table).toBe(slugHistory);
    return { where };
  });
  const select = vi.fn(() => ({ from }));
  const system = vi.fn(() => ({ select }));
  return {
    ctx: { router: { system } },
    select,
    from,
    where,
    system,
  };
}

describe("visibleProjects current slugs (T-419)", () => {
  beforeEach(() => {
    accessibleRows.mockReset();
  });

  it("keeps current slugs by stable id and historical slugs separately", async () => {
    accessibleRows.mockResolvedValue([
      { id: 1, slug: "alpha-next" },
      { id: 2, slug: "alpha" },
    ] as never);
    const query = fakeContext([{ slug: "alpha" }, { slug: "alpha-old" }]);

    const visible = await visibleProjects(query.ctx as never, {} as never);

    expect(visible.ids).toEqual(new Set([1, 2]));
    expect(visible.slugs.sort()).toEqual(["alpha", "alpha-next", "alpha-old"]);
    expect(visible.currentSlugs).toEqual(
      new Map([
        [1, "alpha-next"],
        [2, "alpha"],
      ]),
    );
    expect(accessibleRows).toHaveBeenCalledOnce();
    expect(query.system).toHaveBeenCalledOnce();
    expect(query.select).toHaveBeenCalledOnce();
    expect(query.from).toHaveBeenCalledOnce();
    expect(query.where).toHaveBeenCalledOnce();
  });

  it("returns all three collections empty without another system query", async () => {
    accessibleRows.mockResolvedValue([]);
    const query = fakeContext([]);

    const visible = await visibleProjects(query.ctx as never, {} as never);

    expect(visible).toEqual({
      ids: new Set(),
      slugs: [],
      currentSlugs: new Map(),
    });
    expect(accessibleRows).toHaveBeenCalledOnce();
    expect(query.system).not.toHaveBeenCalled();
    expect(query.select).not.toHaveBeenCalled();
  });

  it.each([1, 20])(
    "names %i events with only the existing visibility query sequence",
    async (size) => {
      accessibleRows.mockResolvedValue([{ id: 1, slug: "acme" }] as never);
      const query = fakeContext([{ slug: "old-acme" }]);
      const visible = await visibleProjects(query.ctx as never, {} as never);
      const items = Array.from({ length: size }, (_, i) => ({
        type: "event" as const,
        id: i + 1,
        event_type: "block_removed" as const,
        actor: {
          id: 1,
          login: "user",
          display_name: "User",
          kind: "human" as const,
          avatar_url: null,
          owner: null,
        },
        payload: {
          edge_id: i + 1,
          role: "blocked",
          other_project_id: 1,
          other_number: i + 1,
        },
        created_at: "2026-08-11T12:00:00Z",
        agent_context: null,
      }));
      const out = redactEventPayloads(items, visible);
      expect(out).toMatchObject(
        Array.from({ length: size }, () => ({
          payload: { other_project: "acme" },
        })),
      );
      expect(accessibleRows).toHaveBeenCalledOnce();
      expect(query.system).toHaveBeenCalledOnce();
      expect(query.select).toHaveBeenCalledOnce();
      expect(query.from).toHaveBeenCalledOnce();
      expect(query.where).toHaveBeenCalledOnce();
    },
  );
});

describe("block payload read-time enrichment (T-419)", () => {
  const event = (
    event_type: "block_added" | "block_cleared",
    payload: Record<string, unknown>,
  ) => ({
    type: "event" as const,
    id: 7,
    event_type,
    payload,
    actor: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human" as const,
      avatar_url: null,
      owner: null,
    },
    agent_context: null,
    created_at: "2026-08-11T12:00:00Z",
  });
  const edge = event("block_added", {
    edge_id: 9,
    role: "blocked",
    other_project_id: 1,
    other_number: 366,
    other_project: "old-slug",
  });
  const cleared = event("block_cleared", {
    edge_id: 9,
    blocker_project_id: 1,
    blocker_number: 366,
    blocker_project: "old-slug",
  });

  it("overwrites historical slugs by id without changing the stored objects", () => {
    const before = structuredClone([edge, cleared]);
    const visible = {
      ids: new Set([1]),
      slugs: ["old-slug"],
      currentSlugs: new Map([[1, "acme"]]),
    };
    const out = redactEventPayloads([edge, cleared], visible);
    expect(out.map((item) => item.payload)).toMatchObject([
      { other_project_id: 1, other_number: 366, other_project: "acme" },
      { blocker_project_id: 1, blocker_number: 366, blocker_project: "acme" },
    ]);
    expect([edge, cleared]).toEqual(before);
    expect(out.map((item) => item.id)).toEqual([7, 7]);
  });

  it("clears injected slugs alongside the private address, keeping the event rows", () => {
    const visible = {
      ids: new Set<number>(),
      slugs: [],
      currentSlugs: new Map<number, string>(),
    };
    const out = redactEventPayloads([edge, cleared], visible);
    expect(out.map((item) => item.payload)).toMatchObject([
      {
        edge_id: 9,
        role: "blocked",
        other_project_id: null,
        other_number: null,
        other_project: null,
      },
      {
        edge_id: 9,
        blocker_project_id: null,
        blocker_number: null,
        blocker_project: null,
      },
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps a numeric address if the visible ID has no current slug entry", () => {
    const visible = {
      ids: new Set([1]),
      slugs: [],
      currentSlugs: new Map<number, string>(),
    };
    expect(redactEventPayloads([edge], visible)[0]?.payload).toMatchObject({
      other_project_id: 1,
      other_number: 366,
      other_project: null,
    });
  });
});
