import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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
  MemberRole,
  Project,
  Status,
  UserRef,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardPage } from "../src/pages/board.tsx";
import { testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const author: UserRef = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const status = (id: number, name: string): Status => ({
  id,
  name,
  category: name === "Done" ? "closed" : "open",
  color: "#123456",
  position: id,
  is_default: id === 1,
});
const todo = status(1, "Todo");
const next = status(2, "Next");
const done = status(3, "Done");
const statuses = [todo, next, done];

function item(number: number, s: Status): IssueListItem {
  return {
    id: number * 10,
    number,
    title: `card ${number}`,
    status: s,
    author,
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
 * A project that remembers status moves, and records every PATCH and every
 * column read, so a test can tell what one drop cost.
 */
function statefulServer() {
  const cards = new Map<number, Status>([
    [21, todo],
    [22, todo],
    [51, next],
    [52, next],
    [61, done],
  ]);
  const patches: { number: number; status_id: number }[] = [];
  const columnReads: number[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input), "http://test");
    const patch = url.pathname.match(/\/issues\/(\d+)$/);
    if (patch && init?.method === "PATCH") {
      const number = Number(patch[1]);
      const body = JSON.parse(String(init.body)) as { status_id: number };
      patches.push({ number, status_id: body.status_id });
      const moved = statuses.find((s) => s.id === body.status_id) as Status;
      cards.set(number, moved);
      return json({ ...item(number, moved), body: "" });
    }
    if (url.pathname.endsWith("/issues")) {
      const statusId = Number(url.searchParams.get("status"));
      columnReads.push(statusId);
      const page: IssueListPage = {
        items: [...cards]
          .filter(([, s]) => s.id === statusId)
          .map(([number, s]) => item(number, s)),
        next_cursor: null,
      };
      return json(page);
    }
    if (url.pathname.endsWith("/watchers")) return json({ issues: {} });
    return json({}, 404);
  }) as typeof fetch;
  return { fetch: fetchImpl, patches, columnReads };
}

function mountBoard(
  server: { fetch: typeof fetch },
  { role = "writer" as MemberRole } = {},
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
  client.setQueryData(["project", "alpha"], project);
  client.setQueryData(["statuses", "alpha"], statuses);
  client.setQueryData(["labels", "alpha"], []);
  client.setQueryData(["members", "alpha"], []);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const boardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "board",
    component: () => (
      <Suspense fallback={<div>loading board</div>}>
        <BoardPage />
      </Suspense>
    ),
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        projectRoute.addChildren([boardRoute, issueRoute]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/projects/alpha/board"],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const box = (number: number) =>
  screen.getByLabelText(`select #${number}`) as HTMLInputElement;

const columnBox = (name: string) =>
  screen.getByLabelText(`select every issue in ${name}`) as HTMLInputElement;

const checked = () =>
  [
    ...document.querySelectorAll<HTMLInputElement>(
      "[data-return-id] > [data-card-select] input[type=checkbox]",
    ),
  ]
    .filter((input) => input.checked)
    .map((input) => input.getAttribute("aria-label"));

const column = (name: string) =>
  screen.getByTestId(`column-${name}`) as HTMLElement;

const cardIn = (name: string) =>
  [...column(name).querySelectorAll("a")].map((a) => a.textContent);

const shellOf = (number: number) =>
  box(number).closest("[data-return-id]") as HTMLElement;

/**
 * happy-dom lays nothing out, so every droppable would sit at the origin and
 * dnd-kit could not tell one column from another. Columns get 300px-wide
 * slots left to right, and a card the top of its column.
 */
function layOutColumns() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const testid =
        this.closest("[data-testid^='column-']")?.getAttribute("data-testid") ??
        "";
      const index = statuses.findIndex((s) => `column-${s.name}` === testid);
      const isColumn = this.getAttribute("data-testid") === testid;
      const x = Math.max(index, 0) * 300;
      const rect = isColumn
        ? { x, y: 0, width: 288, height: 800 }
        : { x, y: 50, width: 288, height: 60 };
      return {
        ...rect,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON: () => rect,
      } as DOMRect;
    },
  );
}

const pointer = {
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
  buttons: 1,
  clientX: 10,
  clientY: 60,
};

async function pickUp(number: number) {
  const title = screen.getByRole("link", { name: `card ${number}` });
  fireEvent.pointerDown(title, pointer);
  fireEvent.pointerMove(document, { ...pointer, clientX: 30 });
  await waitFor(() => {
    expect(
      screen.getAllByRole("link", { name: `card ${number}` }),
    ).toHaveLength(2);
  });
}

/** From wherever the pick-up left the pointer into column `index`. */
async function dropOn(index: number) {
  fireEvent.pointerMove(document, { ...pointer, clientX: 10 + index * 300 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  fireEvent.pointerUp(document, { ...pointer, clientX: 10 + index * 300 });
}

beforeEach(() => layOutColumns());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selecting cards on the board (T-708)", () => {
  it("selects across columns in screen order, and a whole column from its header", async () => {
    mountBoard(statefulServer());
    await screen.findByText("card 61");

    // Todo sits left of Next, so 22 → 51 is a range that crosses columns.
    fireEvent.click(box(22));
    fireEvent.click(box(51), { shiftKey: true });
    expect(checked()).toEqual(["select #22", "select #51"]);
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(columnBox("Todo").indeterminate).toBe(true);
    expect(columnBox("Next").indeterminate).toBe(true);
    expect(columnBox("Done").checked).toBe(false);

    fireEvent.click(columnBox("Todo"));
    expect(columnBox("Todo").checked).toBe(true);
    expect(checked()).toEqual(["select #21", "select #22", "select #51"]);
    // All of a column clears it again, and only it.
    fireEvent.click(columnBox("Todo"));
    expect(checked()).toEqual(["select #51"]);

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(checked()).toEqual([]);
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  it("sets one status on every selected card from the bar", async () => {
    const server = statefulServer();
    mountBoard(server);
    await screen.findByText("card 61");

    fireEvent.click(box(21));
    fireEvent.click(box(52));
    const trigger = screen.getByTestId("bulk-status-trigger");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Done" }));

    await waitFor(() =>
      expect(cardIn("Done")).toEqual(["card 21", "card 52", "card 61"]),
    );
    expect(server.patches).toEqual([
      { number: 21, status_id: done.id },
      { number: 52, status_id: done.id },
    ]);
    expect(checked()).toEqual([]);
  });

  it("marks the board as selecting while anything is selected (T-732)", async () => {
    mountBoard(statefulServer());
    await screen.findByText("card 61");
    const canvas = column("Todo").parentElement as HTMLElement;
    expect(canvas.hasAttribute("data-selecting")).toBe(false);

    fireEvent.click(box(21));
    expect(canvas.hasAttribute("data-selecting")).toBe(true);
    // The box sits on the card's corner, no longer on its meta row.
    expect(box(21).closest("[data-card-meta]")).toBeNull();

    fireEvent.click(screen.getByLabelText("Clear selection"));
    expect(canvas.hasAttribute("data-selecting")).toBe(false);
  });

  it("offers no checkboxes to a reporter", async () => {
    mountBoard(statefulServer(), { role: "reporter" });
    await screen.findByText("card 61");
    expect(document.querySelector("input[type=checkbox]")).toBeNull();
  });
});

describe("dragging a selection (T-708)", () => {
  it("carries every selected card and drops them as one move", async () => {
    const server = statefulServer();
    mountBoard(server);
    await screen.findByText("card 61");

    fireEvent.click(box(21));
    fireEvent.click(box(51));
    fireEvent.click(box(61));
    await pickUp(21);
    expect(screen.getByTestId("drag-count").textContent).toBe("3");
    // The cards riding along fade as the one picked up does.
    expect(shellOf(51).className).toContain("opacity-30");
    expect(shellOf(22).className).not.toContain("opacity-30");

    server.columnReads.length = 0;
    await dropOn(2);

    // 61 already sits in Done, so it is not moved.
    await waitFor(() =>
      expect(server.patches).toEqual([
        { number: 21, status_id: done.id },
        { number: 51, status_id: done.id },
      ]),
    );
    await waitFor(() =>
      expect(cardIn("Done")).toEqual(["card 21", "card 51", "card 61"]),
    );
    expect(cardIn("Todo")).toEqual(["card 22"]);
    expect(cardIn("Next")).toEqual(["card 52"]);
    expect(checked()).toEqual([]);
    // Only the column the cards landed in is read again (T-691).
    await waitFor(() => expect(server.columnReads).toEqual([done.id]));
  });

  it("moves an unselected card alone and leaves the selection standing", async () => {
    const server = statefulServer();
    mountBoard(server);
    await screen.findByText("card 61");

    fireEvent.click(box(21));
    fireEvent.click(box(51));
    await pickUp(22);
    expect(screen.queryByTestId("drag-count")).toBeNull();
    expect(shellOf(21).className).not.toContain("opacity-30");
    await dropOn(2);

    await waitFor(() =>
      expect(server.patches).toEqual([{ number: 22, status_id: done.id }]),
    );
    expect(checked()).toEqual(["select #21", "select #51"]);
  });

  it("drags a selection of one as a plain move", async () => {
    const server = statefulServer();
    mountBoard(server);
    await screen.findByText("card 61");

    fireEvent.click(box(21));
    await pickUp(21);
    expect(screen.queryByTestId("drag-count")).toBeNull();
    await dropOn(1);

    await waitFor(() =>
      expect(server.patches).toEqual([{ number: 21, status_id: next.id }]),
    );
  });
});
