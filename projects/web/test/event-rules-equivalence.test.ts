import { QueryClient } from "@tanstack/react-query";
import type {
  CrossChangeEvent,
  InboxRowState,
  IssueListCacheDescriptor,
  MeEvent,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CacheView,
  cachedIssueRow,
  coalesceBatch,
  entryWantsRefetch,
  type Invalidation,
  inboxAttentionDiffers,
  inboxInvalidations,
  inboxRowContentDiffers,
  invalidationsFor,
  meInvalidations,
  metadataEntryDiffers,
  type QueryKeyLike,
  statusCategories,
} from "../src/api/event-rules.ts";
import { issueListDescriptorOf } from "../src/api/issues-cache.ts";
import { applyInvalidation } from "../src/api/useUserEvents.ts";

const AT = "2026-09-07T10:00:00.000Z";
const LATER = "2026-09-07T11:00:00.000Z";
const attention: InboxRowState = {
  updated_at: AT,
  unread: true,
  unread_comments: 2,
  pending_spec_review: false,
  open_questions: 0,
  mentions_you: false,
};
const writer = {
  id: 1,
  login: "bot-one",
  display_name: "Bot One",
  kind: "machine" as const,
  avatar_url: null,
  owner: null,
};

type Entry = {
  name: string;
  key: QueryKeyLike;
  data: unknown;
  meta?: Record<string, unknown>;
};
type Effect = "active" | "none";

function fixtures(): Entry[] {
  const row = {
    number: 7,
    status: { id: 1 },
    labels: [{ id: 4 }],
    assignees: [{ id: 5 }],
    unread: true,
    unread_comments: 2,
  };
  const page = (
    name: string,
    data: unknown,
    descriptor?: IssueListCacheDescriptor,
  ): Entry => ({
    name,
    key: ["issues", "alpha", name],
    data,
    meta: descriptor === undefined ? undefined : { issueList: descriptor },
  });
  const complete = { items: [], next_cursor: null };
  const all: IssueListCacheDescriptor = { kind: "page", filter: {} };
  return [
    page("holding", { items: [row], next_cursor: null }, all),
    page("complete", complete, all),
    page("partial", { items: [], next_cursor: "next" }, all),
    page("counts", { counts: { 1: 1 } }, { kind: "counts", filter: {} }),
    page("unknown", complete),
    page("closed", complete, { kind: "page", filter: { category: "closed" } }),
    page("label", complete, { kind: "page", filter: { label: [9] } }),
    page("assignee", complete, { kind: "page", filter: { assignee: 9 } }),
    {
      name: "other-project",
      key: ["issues", "beta", "holding"],
      data: { items: [row], next_cursor: null },
      meta: { issueList: all },
    },
    {
      name: "statuses",
      key: ["statuses", "alpha"],
      data: [
        { id: 1, category: "open" },
        { id: 2, category: "closed" },
      ],
    },
    {
      name: "inbox",
      key: ["inbox"],
      data: {
        items: [{ number: 7, project: { slug: "alpha" }, ...attention }],
        truncated: false,
      },
    },
    {
      name: "metadata",
      key: ["issue-metadata", "alpha", 7],
      data: {
        entries: [
          { namespace: "agent", key: "phase", value: "ready", updated_at: AT },
        ],
      },
    },
  ];
}

const matchesPrefix = (key: QueryKeyLike, prefix: QueryKeyLike) =>
  prefix.every(
    (part, index) => JSON.stringify(part) === JSON.stringify(key[index]),
  );

/** Models worker-owned, structured-cloned server results without QueryClient. */
function workerView(entries: Entry[]): CacheView {
  return {
    getQueriesData: ({ queryKey }) =>
      entries
        .filter((entry) => matchesPrefix(entry.key, queryKey))
        .map((entry): [QueryKeyLike, unknown] => [entry.key, entry.data]),
    getQueryData: (key) =>
      entries.find((entry) => JSON.stringify(entry.key) === JSON.stringify(key))
        ?.data,
  };
}

function record(effects: Record<string, Effect>, name: string, effect: Effect) {
  if (effects[name] !== "active") effects[name] = effect;
}

/** Independent execution adapter: shared rules choose effects on worker data. */
function workerEffects(entries: Entry[], batch: Invalidation[], gate: Effect) {
  const view = workerView(entries);
  const effects: Record<string, Effect> = {};
  for (const { key, scope } of batch) {
    for (const entry of entries.filter((candidate) =>
      matchesPrefix(candidate.key, key),
    )) {
      if (scope === "refetch") {
        record(effects, entry.name, gate);
      } else if ("inboxRows" in scope) {
        const attentionChanged = scope.inboxRows.some((v) =>
          inboxAttentionDiffers(entry.data, v.project, v.number, v.row),
        );
        if (attentionChanged) record(effects, entry.name, gate);
        else if (
          scope.inboxRows.some((v) =>
            inboxRowContentDiffers(entry.data, v.project, v.number, v.row),
          )
        ) {
          record(effects, entry.name, "none");
        }
      } else if ("metadataRows" in scope) {
        if (
          scope.metadataRows.some((change) =>
            metadataEntryDiffers(entry.data, change),
          )
        ) {
          record(effects, entry.name, gate);
        }
      } else {
        const context = {
          cached: (number: number) => cachedIssueRow(view, key, number),
          categoryOf: statusCategories(
            view,
            typeof key[1] === "string" ? key[1] : "",
          ),
        };
        if (
          scope.issueRows.some((verdict) =>
            entryWantsRefetch(
              verdict,
              issueListDescriptorOf(entry.meta),
              entry.data,
              context,
            ),
          )
        ) {
          record(effects, entry.name, gate);
        }
      }
    }
  }
  return effects;
}

function pageEffects(entries: Entry[], batch: Invalidation[], gate: Effect) {
  const client = new QueryClient();
  // Compile-time compatibility is part of the extraction's legacy contract.
  const view: CacheView = client;
  const effects: Record<string, Effect> = {};
  for (const entry of entries) {
    client
      .getQueryCache()
      .build(client, { queryKey: entry.key, meta: entry.meta });
    client.setQueryData(entry.key, entry.data);
  }
  const invalidate = vi
    .spyOn(client, "invalidateQueries")
    .mockImplementation((filters = {}) => {
      for (const query of client.getQueryCache().findAll(filters)) {
        const entry = entries.find(
          (candidate) =>
            JSON.stringify(candidate.key) === JSON.stringify(query.queryKey),
        );
        if (entry)
          record(
            effects,
            entry.name,
            filters.refetchType === "none" ? "none" : "active",
          );
      }
      return Promise.resolve();
    });
  try {
    expect(cachedIssueRow(view, ["issues", "alpha"], 7)).toEqual(
      cachedIssueRow(workerView(entries), ["issues", "alpha"], 7),
    );
    for (const invalidation of batch)
      applyInvalidation(client, invalidation, gate);
    return effects;
  } finally {
    invalidate.mockRestore();
    client.clear();
  }
}

function compare(
  entries: Entry[],
  invalidations: Invalidation[],
  expected: Record<string, Effect>,
) {
  // No fixture has a search-reference query; skip those asynchronous executors.
  const batch = coalesceBatch(invalidations).filter((inv) =>
    entries.some((entry) => matchesPrefix(entry.key, inv.key)),
  );
  for (const gate of ["active", "none"] as const) {
    const gated = Object.fromEntries(
      Object.entries(expected).map(([name, effect]) => [
        name,
        gate === "none" ? "none" : effect,
      ]),
    );
    const worker = workerEffects(
      structuredClone(entries),
      structuredClone(batch),
      gate,
    );
    const page = pageEffects(entries, batch, gate);
    expect(worker).toEqual(gated);
    expect(page).toEqual(gated);
    expect(worker).toEqual(page);
  }
}

const change = (overrides: Partial<CrossChangeEvent>): CrossChangeEvent => ({
  project: "alpha",
  entity: "issue",
  action: "updated",
  id: 7,
  issue_number: 7,
  inbox_row: attention,
  ...overrides,
});
const batchFor = (event: CrossChangeEvent) => [
  ...invalidationsFor(event, event.project),
  ...inboxInvalidations(event),
];
const active = (...names: string[]): Record<string, Effect> =>
  Object.fromEntries(names.map((name) => [name, "active"]));

describe("page and worker invalidation rule equivalence", () => {
  it.each([
    {
      name: "unrelated issue pointer",
      event: change({ entity: "attachment", issue_number: 8 }),
      expected: {},
    },
    {
      name: "contains leaves absent rows and counts alone",
      event: change({ entity: "comment" }),
      expected: active("holding", "unknown"),
    },
    {
      name: "activity distinguishes complete and incomplete pages",
      event: change({ list_row: { kind: "activity" } }),
      expected: active("holding", "partial", "unknown"),
    },
    {
      name: "gone invalidates membership counts",
      event: change({ list_row: { kind: "gone" } }),
      expected: active("holding", "counts", "unknown"),
    },
    {
      name: "unchanged status uses cached labels and assignees",
      event: change({ list_row: { kind: "fields", status_id: 1 } }),
      expected: active("holding", "complete", "partial", "unknown"),
    },
    {
      name: "changed status affects counts and closed membership",
      event: change({ list_row: { kind: "fields", status_id: 2 } }),
      expected: active(
        "holding",
        "complete",
        "partial",
        "counts",
        "unknown",
        "closed",
      ),
    },
    {
      name: "inbox attention changes refetch",
      event: change({
        entity: "spec",
        inbox_row: { ...attention, unread_comments: 3 },
      }),
      expected: active("inbox"),
    },
    {
      name: "inbox content changes only mark stale",
      event: change({
        entity: "spec",
        inbox_row: { ...attention, updated_at: LATER },
      }),
      expected: { inbox: "none" as const },
    },
    {
      name: "equal inbox replay does nothing",
      event: change({ entity: "spec" }),
      expected: {},
    },
    {
      name: "metadata echo does nothing",
      event: change({
        entity: "metadata",
        metadata: {
          namespace: "agent",
          key: "phase",
          value: "ready",
          updated_at: AT,
          updated_by: writer,
        },
      }),
      expected: {},
    },
    {
      name: "metadata deletion refetches",
      event: change({
        entity: "metadata",
        metadata: {
          namespace: "agent",
          key: "phase",
          value: null,
          updated_at: LATER,
          updated_by: writer,
        },
      }),
      expected: active("metadata"),
    },
  ])("$name", ({ event, expected }) => {
    compare(fixtures(), batchFor(event), expected);
  });

  it("read positions refresh only unread rows and changed inbox attention", () => {
    const event: MeEvent = {
      kind: "issue_read",
      project: "alpha",
      issue_number: 7,
      inbox_row: null,
    };
    compare(
      fixtures(),
      meInvalidations(event),
      active("holding", "unknown", "inbox"),
    );
  });

  it("evicted row/status inputs conservatively refetch unknown membership", () => {
    const entries = fixtures().filter(
      (entry) => entry.name !== "holding" && entry.name !== "statuses",
    );
    compare(
      entries,
      batchFor(change({ list_row: { kind: "fields", status_id: 1 } })),
      active(
        "complete",
        "partial",
        "counts",
        "unknown",
        "closed",
        "label",
        "assignee",
      ),
    );
  });

  it("coalesced attention changes outrank content-only staleness", () => {
    const content = change({
      entity: "spec",
      inbox_row: { ...attention, updated_at: LATER },
    });
    const unread = change({
      entity: "spec",
      inbox_row: { ...attention, unread_comments: 3 },
    });
    compare(
      fixtures(),
      [...batchFor(content), ...batchFor(unread), ...batchFor(content)],
      active("inbox"),
    );
  });
});
