import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  IssueListItem,
  IssueListPage,
  Label,
  Member,
  Status,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import {
  toggledById,
  useIssueAssigneesMutation,
  useIssueLabelsMutation,
} from "../src/api/issues.ts";
import { api } from "../src/api/queries.ts";
import { IssueRow, IssueRowMeta } from "../src/components/issue/issue-row.tsx";
import { BoardCardContent, type CardEdit } from "../src/pages/board.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const status: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#000000",
  position: 1,
  is_default: false,
};

const member = (id: number, login: string): Member => ({
  user: {
    id,
    login,
    display_name: login,
    kind: "machine",
    avatar_url: null,
    owner: { id: 1, login: "user" },
  },
  role: "writer",
  created_at: "2026-10-22T00:00:00Z",
});
const MEMBERS = [member(2, "bot-one"), member(3, "newcomer")];

const LABELS: Label[] = [
  { id: 1, name: "area:web", color: "#3b82f6" },
  { id: 2, name: "kind:bug", color: "#ef4444" },
];

const issue: IssueListItem = {
  id: 10,
  number: 1,
  title: "issue 1",
  status,
  author: MEMBERS[0].user,
  assignees: [],
  labels: [],
  created_at: "2026-10-22T00:00:00Z",
  updated_at: "2026-10-22T00:00:00Z",
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
};

const page = (item: IssueListItem): IssueListPage =>
  ({ items: [item], next_cursor: null }) as unknown as IssueListPage;

/** A promise per call, settled by the test. */
function deferredUpdates() {
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const spy = vi.spyOn(api, "updateIssue").mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({
          resolve: () => resolve({} as never),
          reject,
        });
      }) as never,
  );
  return { spy, pending };
}

/**
 * What both surfaces do: read the row from the cache, toggle from what it
 * shows. Two clicks before any answer is the open-picker burst (T-533).
 */
function CachedRow({ kind }: { kind: "labels" | "assignees" }) {
  const column = useQuery({
    ...boardColumnQuery("p", 1),
    queryFn: () => new Promise<never>(() => {}),
  });
  const labels = useIssueLabelsMutation();
  const assignees = useIssueAssigneesMutation();
  const row = column.data?.items[0];
  if (!row) return null;
  return (
    <>
      <output>
        {kind === "labels"
          ? row.labels.map((l) => l.name).join(",")
          : row.assignees.map((u) => u.login).join(",")}
      </output>
      {[0, 1].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() =>
            kind === "labels"
              ? labels.mutate({
                  slug: "p",
                  issueNumber: row.number,
                  labels: toggledById(row.labels, LABELS[i]),
                })
              : assignees.mutate({
                  slug: "p",
                  issueNumber: row.number,
                  assignees: toggledById(row.assignees, MEMBERS[i].user),
                })
          }
        >
          toggle {i}
        </button>
      ))}
    </>
  );
}

function renderCachedRow(kind: "labels" | "assignees") {
  const client = testQueryClient();
  client.setQueryData(boardColumnQuery("p", 1).queryKey, page(issue));
  render(
    <QueryClientProvider client={client}>
      <CachedRow kind={kind} />
    </QueryClientProvider>,
  );
  return client;
}

describe("row label/assignee writes are optimistic (T-533)", () => {
  it("a second assignee toggle before the first answers keeps the first", async () => {
    const { spy } = deferredUpdates();
    renderCachedRow("assignees");
    fireEvent.click(screen.getByText("toggle 0"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("toggle 1"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({ assignee_ids: [2, 3] });
    expect(screen.getByRole("status").textContent).toBe("bot-one,newcomer");
  });

  it("a second label toggle before the first answers keeps the first", async () => {
    const { spy } = deferredUpdates();
    renderCachedRow("labels");
    fireEvent.click(screen.getByText("toggle 0"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("toggle 1"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1]?.[2]).toEqual({ label_ids: [1, 2] });
  });

  it("puts the row back when the write is refused", async () => {
    const { spy, pending } = deferredUpdates();
    const client = renderCachedRow("assignees");
    fireEvent.click(screen.getByText("toggle 0"));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("bot-one");
    await act(async () => pending[0]?.reject(new Error("forbidden")));
    await waitFor(() =>
      expect(
        client.getQueryData<IssueListPage>(boardColumnQuery("p", 1).queryKey)
          ?.items[0]?.assignees,
      ).toEqual([]),
    );
  });
});

const edit = (canTriage: boolean): CardEdit => ({
  slug: "p",
  allLabels: LABELS,
  members: MEMBERS,
  canTriage,
});

describe("board card edit icons (T-533)", () => {
  it("offers both pickers outside the title link", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue} edit={edit(true)} />,
    );
    const title = await view.findByRole("link", { name: "issue 1" });
    expect(title.getAttribute("href")).toBe("/projects/p/issues/1");
    for (const name of ["Edit labels", "Edit assignees"]) {
      const button = view.getByRole("button", { name });
      expect(button.closest("a")).toBeNull();
    }
  });

  it("keeps a press on an icon from reaching the card's drag sensor", async () => {
    const onCardPointerDown = vi.fn();
    const view = renderWithProviders(
      <div onPointerDown={onCardPointerDown}>
        <BoardCardContent slug="p" issue={issue} edit={edit(true)} />
      </div>,
    );
    const button = await view.findByRole("button", { name: "Edit assignees" });
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    expect(onCardPointerDown).not.toHaveBeenCalled();
    // The menu still opened from that same press.
    await view.findByRole("menuitem", { name: /newcomer/ });
  });

  it("shows no icons to a viewer the server would refuse", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue} edit={edit(false)} />,
    );
    await view.findByText("issue 1");
    expect(view.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("leaves the drag overlay's copy without icons", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue} />,
    );
    await view.findByText("issue 1");
    expect(view.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });
});

describe("list row assignee picker (T-533)", () => {
  const renderMeta = (onToggleAssignee?: (id: number) => void) =>
    renderWithProviders(
      <ul>
        <IssueRow
          slug="p"
          issue={issue}
          meta={
            <IssueRowMeta
              issue={issue}
              statuses={[status]}
              allLabels={LABELS}
              members={MEMBERS}
              onStatus={() => {}}
              onToggleLabel={() => {}}
              onToggleAssignee={onToggleAssignee}
            />
          }
        />
      </ul>,
    );

  it("reports the picked member, from a button outside the title link", async () => {
    const onToggle = vi.fn();
    const view = renderMeta(onToggle);
    const button = await view.findByRole("button", { name: "Edit assignees" });
    expect(button.closest("a")).toBeNull();
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    fireEvent.click(await view.findByRole("menuitem", { name: /newcomer/ }));
    expect(onToggle).toHaveBeenCalledWith(3);
  });

  it("has no assignee picker without a handler", async () => {
    const view = renderMeta(undefined);
    await view.findByText("issue 1");
    expect(view.queryByRole("button", { name: "Edit assignees" })).toBeNull();
    expect(view.getByRole("button", { name: "Edit labels" })).toBeTruthy();
  });
});

/**
 * Both assignee groups are pushed to the right edge, so whatever follows the
 * last avatar moves every avatar inward by its own width. The geometry itself
 * is measured in a real browser on T-536; this pins the order that decides it.
 */
describe("the assignee icon leads the avatars (T-536)", () => {
  const assigned = { ...issue, assignees: [MEMBERS[1].user] };

  const expectLeads = (button: HTMLElement) => {
    const group = button.parentElement;
    expect(group?.childElementCount).toBe(2);
    expect(group?.firstElementChild).toBe(button);
  };

  it("on a list row", async () => {
    const view = renderWithProviders(
      <ul>
        <IssueRow
          slug="p"
          issue={assigned}
          meta={
            <IssueRowMeta
              issue={assigned}
              statuses={[status]}
              allLabels={LABELS}
              members={MEMBERS}
              onStatus={() => {}}
              onToggleLabel={() => {}}
              onToggleAssignee={() => {}}
            />
          }
        />
      </ul>,
    );
    expectLeads(await view.findByRole("button", { name: "Edit assignees" }));
  });

  it("on a board card", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={assigned} edit={edit(true)} />,
    );
    expectLeads(await view.findByRole("button", { name: "Edit assignees" }));
  });
});
