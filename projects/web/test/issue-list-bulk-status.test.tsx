import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  IssueBulkCommand,
  IssueBulkInput,
  IssueCounts,
  IssueListItem,
  IssueListPage,
  Me,
  Member,
  MemberRole,
  Project,
  Status,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueSearchSchema, useBulkIssueMutation } from "../src/api/issues.ts";
import { AppShell } from "../src/components/shell.tsx";
import { ProjectIssueListPage } from "../src/pages/issue-list.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
const { toast } = await import("sonner");

const me: Me = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2026-01-01T00:00:00Z",
};

const members: Member[] = [
  {
    user: {
      id: me.id,
      login: me.login,
      display_name: me.display_name,
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
  },
];

const todo: Status = {
  id: 2,
  name: "Todo",
  category: "open",
  color: "#123456",
  position: 1,
  is_default: true,
};
const next: Status = {
  id: 5,
  name: "Next",
  category: "open",
  color: "#f59e0b",
  position: 4,
  is_default: false,
};
const done: Status = {
  id: 9,
  name: "Done",
  category: "closed",
  color: "#22c55e",
  position: 6,
  is_default: false,
};
const statuses = [todo, next, done];

function item(id: number, status: Status): IssueListItem {
  return {
    id,
    number: id,
    title: `card ${id}`,
    status,
    author: members[0].user,
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
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A project that remembers status moves, so the refetch after a bulk move
 * shows what the server actually did. `refuse` names cards the bulk endpoint
 * cannot find, which fails the whole request, as the real one does.
 */
function statefulServer(refuse: number[] = []) {
  const cards = new Map<number, Status>([
    [51, next],
    [52, next],
    [21, todo],
    [22, todo],
  ]);
  const bulks: { numbers: number[]; commands: IssueBulkCommand[] }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input), "http://test");
    if (url.pathname.endsWith("/issues/bulk") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as IssueBulkInput;
      bulks.push(body);
      const missing = body.numbers.filter((n) => refuse.includes(n));
      if (missing.length > 0) {
        return json(
          {
            error: {
              code: "not_found",
              message: `issues not found: ${missing.join(", ")}`,
            },
          },
          404,
        );
      }
      for (const command of body.commands) {
        if (command.type !== "status") continue;
        for (const n of body.numbers) {
          cards.set(
            n,
            statuses.find((s) => s.id === command.status_id) as Status,
          );
        }
      }
      return json({
        issues: body.numbers.map((n) => item(n, cards.get(n) as Status)),
      });
    }
    if (url.pathname.endsWith("/issues/counts")) {
      const counts: IssueCounts = { open: 0, closed: 0, by_status: {} };
      for (const status of cards.values()) {
        counts.by_status[String(status.id)] =
          (counts.by_status[String(status.id)] ?? 0) + 1;
        if (status.category === "open") counts.open += 1;
        else counts.closed += 1;
      }
      return json(counts);
    }
    if (url.pathname.endsWith("/issues")) {
      const statusId = url.searchParams.get("status");
      const page: IssueListPage = {
        items: [...cards]
          .filter(([, s]) =>
            statusId === null
              ? s.category === "open"
              : String(s.id) === statusId,
          )
          .map(([number, s]) => item(number, s)),
        next_cursor: null,
      };
      return json(page);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, bulks, cards };
}

function mountList(
  server: { fetch: typeof fetch },
  { role = "writer" as MemberRole, initialEntry = "/projects/alpha" } = {},
) {
  vi.stubGlobal("fetch", server.fetch);
  const project: Project = {
    id: 1,
    slug: "alpha",
    name: "Alpha",
    description: "",
    created_at: "2026-01-01T00:00:00Z",
    viewer_role: role,
  };
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  client.setQueryData(["me"], me);
  client.setQueryData(["project", "alpha"], project);
  client.setQueryData(["statuses", "alpha"], statuses);
  client.setQueryData(["labels", "alpha"], []);
  // The Trash link reads admin off the member list, not off viewer_role.
  client.setQueryData(
    ["members", "alpha"],
    members.map((m) => ({ ...m, role })),
  );

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
    component: () => (
      <AppShell me={me}>
        <Outlet />
      </AppShell>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: () => <Outlet />,
  });
  const listRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "/",
    validateSearch: (search: Record<string, unknown>) =>
      issueSearchSchema.parse(search),
    component: function ListShim() {
      const search = listRoute.useSearch();
      return <ProjectIssueListPage slug="alpha" search={search} />;
    },
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => <div>a card</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([listRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const box = (ref: number) =>
  screen.getByLabelText(`select #${ref}`) as HTMLInputElement;

const checked = () =>
  [...document.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")]
    .filter((input) => input.checked)
    .map((input) => input.getAttribute("aria-label"));

async function chooseStatus(name: string) {
  const trigger = screen.getByTestId("bulk-status-trigger");
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const option = await screen.findByRole("menuitem", { name });
  fireEvent.click(option);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
});

describe("selecting issues on the list (T-707)", () => {
  it("selects across groups, in screen order, with select-all and shift-click", async () => {
    mountList(statefulServer());
    await screen.findByText("card 22");

    // Next sorts above Todo, so 52 → 21 is a range that crosses groups.
    fireEvent.click(box(52));
    fireEvent.click(box(21), { shiftKey: true });
    expect(checked()).toEqual(["select #52", "select #21"]);
    expect(screen.getByText("2 selected")).toBeTruthy();

    const all = screen.getByLabelText("select all issues") as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(checked()).toEqual([
      "select #51",
      "select #52",
      "select #21",
      "select #22",
    ]);

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(checked()).toEqual([]);
    expect(screen.queryByTestId("bulk-status-trigger")).toBeNull();
  });

  it("moves every selected card, and the moved ones leave the open list", async () => {
    const server = statefulServer();
    mountList(server);
    await screen.findByText("card 22");

    fireEvent.click(box(51));
    fireEvent.click(box(21));
    await chooseStatus("Done");

    // One request for the whole selection, in screen order.
    await waitFor(() =>
      expect(server.bulks).toEqual([
        {
          numbers: [51, 21],
          commands: [{ type: "status", status_id: done.id }],
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByText("card 51")).toBeNull());
    expect(screen.queryByText("card 21")).toBeNull();
    expect(screen.getByText("card 52")).toBeTruthy();
    // The selection is spent with the move.
    expect(checked()).toEqual([]);
  });

  it("leaves every card where it was when the batch is refused, and says so", async () => {
    const server = statefulServer([21]);
    mountList(server);
    await screen.findByText("card 22");

    fireEvent.click(box(51));
    fireEvent.click(box(21));
    await chooseStatus("Done");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not update issues: issues not found: 21",
      ),
    );
    await waitFor(() => expect(screen.getByText("card 51")).toBeTruthy());
    expect(screen.getByText("card 21")).toBeTruthy();
  });

  it("selects on the flat list too", async () => {
    mountList(statefulServer(), {
      initialEntry: "/projects/alpha?group=none",
    });
    await screen.findByText("card 22");
    fireEvent.click(screen.getByLabelText("select all issues"));
    expect(checked()).toHaveLength(4);
  });

  it("keeps no column for the boxes, and marks the list while selecting (T-732)", async () => {
    const { unmount } = mountList(statefulServer());
    await screen.findByText("card 22");
    const selectable = [...document.querySelectorAll("ul")].map(
      (ul) => ul.className,
    );
    const selecting = () => document.querySelector("[data-selecting]");
    expect(selecting()).toBeNull();
    fireEvent.click(box(21));
    expect(selecting()?.contains(box(21))).toBe(true);
    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(selecting()).toBeNull();
    unmount();

    mountList(statefulServer(), { role: "reporter" });
    await screen.findByText("card 22");
    expect(selectable).toEqual(
      [...document.querySelectorAll("ul")].map((ul) => ul.className),
    );
  });

  it("selects a whole group from its header's dot (T-768)", async () => {
    mountList(statefulServer());
    await screen.findByText("card 22");
    const group = (name: string) =>
      screen.getByLabelText(
        `select every issue in ${name}`,
      ) as HTMLInputElement;

    fireEvent.click(box(21));
    expect(group("Todo").indeterminate).toBe(true);
    expect(group("Next").indeterminate).toBe(false);
    expect(group("Next").checked).toBe(false);

    fireEvent.click(group("Todo"));
    expect(checked()).toEqual(["select #21", "select #22"]);
    expect(group("Todo").checked).toBe(true);
    expect(group("Todo").indeterminate).toBe(false);

    fireEvent.click(group("Next"));
    expect(checked()).toHaveLength(4);
    expect(
      (screen.getByLabelText("select all issues") as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.click(group("Todo"));
    expect(checked()).toEqual(["select #51", "select #52"]);
  });

  it("gives the toolbar row to the selection while anything is selected (T-778)", async () => {
    mountList(statefulServer(), { role: "admin" });
    await screen.findByText("card 22");
    const projectActions = () => [
      screen.queryByLabelText("Mark this project as read"),
      screen.queryByLabelText("Mute alpha"),
      screen.queryByRole("link", { name: "Trash" }),
    ];
    expect(projectActions().every(Boolean)).toBe(true);

    fireEvent.click(box(21));
    expect(projectActions()).toEqual([null, null, null]);
    expect(screen.getByTestId("bulk-status-trigger")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(projectActions().every(Boolean)).toBe(true);
  });

  it("offers no selection below issue.triage", async () => {
    mountList(statefulServer(), { role: "reporter" });
    await screen.findByText("card 22");
    expect(screen.queryByLabelText("select all issues")).toBeNull();
    expect(screen.queryByLabelText("select every issue in Todo")).toBeNull();
    expect(document.querySelector("li input[type=checkbox]")).toBeNull();
  });
});

describe("useBulkIssueMutation", () => {
  it("rolls the whole move back while the refetch is out", async () => {
    let releaseRefetch: () => void = () => {};
    const refetchHeld = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    vi.stubGlobal("fetch", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input), "http://test");
      if (url.pathname.endsWith("/issues/bulk") && init?.method === "POST") {
        return json(
          { error: { code: "not_found", message: "issues not found: 21" } },
          404,
        );
      }
      await refetchHeld;
      return json({}, 404);
    }) as typeof fetch);

    const client = testQueryClient();
    const nextKey = ["issues", "alpha", { group: next.id }];
    const todoKey = ["issues", "alpha", { group: todo.id }];
    const doneKey = ["issues", "alpha", { group: done.id }];
    client.setQueryData(nextKey, {
      items: [item(51, next), item(52, next)],
      next_cursor: null,
    });
    client.setQueryData(todoKey, {
      items: [item(21, todo)],
      next_cursor: null,
    });
    client.setQueryData(doneKey, { items: [], next_cursor: null });

    const hook = renderHook(() => useBulkIssueMutation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() =>
      hook.result.current.mutate({
        slug: "alpha",
        issueNumbers: [51, 21],
        change: { kind: "status", status: done },
      }),
    );
    await waitFor(() => expect(hook.result.current.isError).toBe(true));

    const numbers = (key: unknown[]) =>
      client.getQueryData<IssueListPage>(key)?.items.map((i) => i.number);
    expect(numbers(nextKey)).toEqual([51, 52]);
    expect(numbers(todoKey)).toEqual([21]);
    expect(numbers(doneKey)).toEqual([]);
    releaseRefetch();
  });
});
