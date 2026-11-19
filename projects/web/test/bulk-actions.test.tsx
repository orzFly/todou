import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  IssueListPage,
  Label,
  Member,
  Project,
  Status,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkActions } from "../src/components/issue/bulk-actions.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const todo: Status = {
  id: 2,
  name: "Todo",
  category: "open",
  color: "#123456",
  position: 1,
  is_default: true,
};
const bug: Label = { id: 7, name: "kind:bug", color: "#ef4444" };
const web: Label = { id: 8, name: "area:web", color: "#3b82f6" };
const alice: Member = {
  user: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  role: "writer",
  created_at: "2026-01-01T00:00:00Z",
};

function item(
  number: number,
  extra: Partial<IssueListItem> = {},
): IssueListItem {
  return {
    id: number,
    number,
    title: `card ${number}`,
    body_preview: null,
    status: todo,
    author: alice.user,
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
    ...extra,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Sent = { method: string; path: string; body: unknown };

function mount(
  rows: IssueListItem[],
  { created }: { created?: Label } = {},
): {
  sent: Sent[];
  pageKey: unknown[];
  client: ReturnType<typeof testQueryClient>;
} {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input), "http://test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/labels") && init?.method === "POST") {
      return json(created);
    }
    if (url.pathname.endsWith("/issues/read")) {
      return new Response(null, { status: 204 });
    }
    return json({ issues: [] });
  }) as typeof fetch);

  const project: Project = {
    id: 1,
    slug: "alpha",
    name: "Alpha",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: "admin",
  };
  const client = testQueryClient();
  client.setQueryData(["project", "alpha"], project);
  client.setQueryData(["labels", "alpha"], [bug, web]);
  client.setQueryData(["members", "alpha"], [alice]);
  const pageKey = ["issues", "alpha", { group: todo.id }];
  client.setQueryData<IssueListPage>(pageKey, {
    items: rows,
    next_cursor: null,
  });
  render(
    <QueryClientProvider client={client}>
      <BulkActions
        slug="alpha"
        statuses={[todo]}
        issueNumbers={rows.map((row) => row.number)}
      />
    </QueryClientProvider>,
  );
  return { sent, pageKey, client };
}

const bulks = (sent: Sent[]) =>
  sent.filter((s) => s.path.endsWith("/issues/bulk")).map((s) => s.body);
const option = (name: string) =>
  screen
    .getByRole("listbox")
    .querySelector(`[title="${name}"]`)
    ?.closest('[role="option"]') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BulkActions labels (T-775)", () => {
  it("shows a label on some cards as mixed, and adds it to all of them", async () => {
    const { sent, pageKey, client } = mount([
      item(1, { labels: [bug] }),
      item(2),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    expect(option("kind:bug").getAttribute("aria-checked")).toBe("mixed");
    expect(option("area:web").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(option("kind:bug"));
    await waitFor(() =>
      expect(bulks(sent)).toEqual([
        {
          numbers: [1, 2],
          commands: [{ type: "label_add", label_id: bug.id }],
        },
      ]),
    );
    // Optimistic, and the open picker follows it.
    const page = client.getQueryData<IssueListPage>(pageKey);
    expect(page?.items.map((i) => i.labels.map((l) => l.id))).toEqual([
      [bug.id],
      [bug.id],
    ]);
    expect(option("kind:bug").getAttribute("aria-checked")).toBe("true");
    // The picker stays open for the next one.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("takes a label every card carries off all of them", async () => {
    const { sent } = mount([
      item(1, { labels: [bug] }),
      item(2, { labels: [bug, web] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    expect(option("kind:bug").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(option("kind:bug"));
    await waitFor(() =>
      expect(bulks(sent)).toEqual([
        {
          numbers: [1, 2],
          commands: [{ type: "label_remove", label_id: bug.id }],
        },
      ]),
    );
  });

  it("puts a label created in place on every card", async () => {
    const fresh: Label = { id: 11, name: "fresh", color: "#000000" };
    const { sent } = mount([item(1), item(2)], { created: fresh });
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    fireEvent.change(screen.getByLabelText("filter labels"), {
      target: { value: "fresh" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Create “fresh”/ }));
    await waitFor(() =>
      expect(bulks(sent)).toEqual([
        {
          numbers: [1, 2],
          commands: [{ type: "label_add", label_id: fresh.id }],
        },
      ]),
    );
  });
});

describe("BulkActions assignees (T-775)", () => {
  it("assigns everyone when only some carry the person, unassigns when all do", async () => {
    const { sent } = mount([item(1, { assignees: [alice.user] }), item(2)]);
    fireEvent.click(screen.getByRole("button", { name: "Assignees" }));
    const row = () => screen.getByRole("option", { name: /Alice/ });
    expect(row().getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(row());
    await waitFor(() => expect(bulks(sent)).toHaveLength(1));
    expect(row().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(row());
    await waitFor(() =>
      expect(bulks(sent)).toEqual([
        { numbers: [1, 2], commands: [{ type: "assign", user_id: 1 }] },
        { numbers: [1, 2], commands: [{ type: "unassign", user_id: 1 }] },
      ]),
    );
  });
});

describe("BulkActions mark read (T-775)", () => {
  it("is off when nothing selected is unread", () => {
    mount([item(1), item(2)]);
    const button = screen.getByRole("button", { name: "Mark read" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("reads the selection in one request and clears the rows at once", async () => {
    const { sent, pageKey, client } = mount([
      item(1, { unread: true, unread_comments: 2 }),
      item(2),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() =>
      expect(sent.filter((s) => s.path.endsWith("/issues/read"))).toEqual([
        {
          method: "PUT",
          path: "/api/projects/alpha/issues/read",
          body: { numbers: [1, 2] },
        },
      ]),
    );
    const page = client.getQueryData<IssueListPage>(pageKey);
    expect(page?.items[0]?.unread).toBe(false);
  });
});
