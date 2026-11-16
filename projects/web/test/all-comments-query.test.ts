import type { TimelineItem } from "@todou/shared";
import { selectHidable } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCommentsQuery } from "../src/api/timeline.ts";

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const ITEMS: TimelineItem[] = [
  {
    type: "comment",
    id: 42,
    author: user,
    body: "",
    component: {
      type: "questions",
      questions: [
        {
          key: "q1",
          multiple: false,
          question: "Ship it?",
          options: [{ label: "yes" }, { label: "no" }],
        },
      ],
    },
    created_at: "2026-08-11T00:00:00Z",
    edited_at: null,
    resolved_at: null,
    hidden_at: null,
    agent_context: null,
  },
  {
    type: "event",
    id: 9,
    event_type: "question_withdrawn",
    actor: user,
    payload: { comment_id: 42, reason: null },
    created_at: "2026-08-11T01:00:00Z",
    agent_context: null,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("allCommentsQuery (T-307)", () => {
  it("brings back what /hide-all needs to see a withdrawn question as settled", async () => {
    // Filters on `types` the way the server does, so what the query leaves
    // out of its list is what the selection never sees.
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = new URL(String(input), "http://stub.test");
      const types = url.searchParams.get("types")?.split(",");
      const items = ITEMS.filter(
        (item) =>
          types === undefined ||
          types.includes(item.type === "event" ? item.event_type : item.type),
      );
      return Response.json({
        items,
        prev_cursor: null,
        next_cursor: null,
        total_count: items.length,
      });
    });

    const query = allCommentsQuery("p", 19);
    const items = await (query.queryFn as () => Promise<TimelineItem[]>)();
    const selection = selectHidable(
      items,
      { by: "all", keep_last: 0 },
      { hidden: true },
    );
    expect(selection.pick).toEqual([42]);
    expect(selection.skip).toEqual([]);
  });
});
