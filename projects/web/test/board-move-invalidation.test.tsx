import {
  QueryClientProvider,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Issue, IssueListItem, Status } from "@todou/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardColumnQuery, useBoardMove } from "../src/api/board.ts";
import { issuesEntry } from "../src/api/issues-cache.ts";
import { api } from "../src/api/queries.ts";
import { testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const status = (id: number): Status => ({
  id,
  name: `s${id}`,
  category: "open",
  color: "#000000",
  position: id,
  is_default: false,
});

const card = (number: number, s: Status): IssueListItem => ({
  id: number * 10,
  number,
  title: `issue ${number}`,
  body_preview: null,
  status: s,
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-11T00:00:00Z",
  updated_at: "2026-08-11T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const STATUSES = [status(1), status(2), status(3), status(4)];

/**
 * A board of four live columns, card 7 in the first, plus a counts entry
 * nobody is watching — the list page's, left behind in the cache.
 */
function setup(update: () => Promise<Issue>) {
  const client = testQueryClient();
  const fetched: number[] = [];
  vi.spyOn(api, "listIssues").mockImplementation(async (_slug, query) => {
    const raw = query?.status;
    const id = Array.isArray(raw) ? Number(raw[0]) : 0;
    fetched.push(id);
    return { items: [], next_cursor: null };
  });
  vi.spyOn(api, "updateIssue").mockImplementation(update);
  for (const s of STATUSES) {
    client.setQueryData(boardColumnQuery("p", s.id).queryKey, {
      items: s.id === 1 ? [card(7, s)] : [],
      next_cursor: null,
    });
  }
  const counts = issuesEntry(["issues", "p", "counts"], {
    kind: "counts",
    filter: {},
  });
  client.setQueryData(counts.queryKey, { counts: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      useQueries({
        queries: STATUSES.map((s) => ({
          ...boardColumnQuery("p", s.id),
          staleTime: Number.POSITIVE_INFINITY,
        })),
      });
      return useBoardMove();
    },
    { wrapper },
  );
  // The counts entry is only ever read on another page; observing it once and
  // letting go makes it the inactive entry that page leaves behind.
  renderHook(
    () =>
      useQuery({
        ...counts,
        queryFn: async () => ({ counts: [] }),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    { wrapper },
  ).unmount();
  return { client, fetched, view, countsKey: counts.queryKey };
}

const move = { slug: "p", issueNumber: 7, fromStatusId: 1 };

describe("a board move's refetch (T-691)", () => {
  it("re-reads the column the card landed in and no other", async () => {
    const { client, fetched, view, countsKey } = setup(async () => ({
      ...card(7, STATUSES[2]),
      body: "",
    }));
    await act(async () => {
      await view.result.current.mutateAsync({ ...move, toStatus: STATUSES[2] });
    });
    await waitFor(() => expect(fetched).toEqual([3]));
    // Not on screen, so not fetched — but its next mount has to.
    expect(client.getQueryState(countsKey)?.isInvalidated).toBe(true);
  });

  it("re-reads every column when the move failed", async () => {
    const { fetched, view } = setup(async () => {
      throw new Error("nope");
    });
    await act(async () => {
      await view.result.current
        .mutateAsync({ ...move, toStatus: STATUSES[2] })
        .catch(() => {});
    });
    await waitFor(() => expect(fetched.sort()).toEqual([1, 2, 3, 4]));
  });
});
