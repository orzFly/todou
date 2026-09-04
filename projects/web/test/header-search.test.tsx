import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  Me,
  Project,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { projectQuery, projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { AppShell } from "../src/components/shell.tsx";
import { testQueryClient } from "./render.tsx";

/**
 * The viewport happy-dom answers `matchMedia` from. Tailwind is not loaded
 * here, so nothing in this file can be told apart by its classes — which
 * half of the header is mounted is exactly what `useMediaQuery` decides, and
 * that is what these cases read.
 */
const happyDom = globalThis as unknown as {
  happyDOM: { setViewport: (viewport: { width?: number }) => void };
};

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

const status = {
  id: 1,
  name: "Next",
  category: "open" as const,
  color: "#3b82f6",
  position: 1,
  is_default: false,
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status,
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-30T08:00:00Z",
  updated_at: "2026-08-30T08:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
});

/** Everything the header reads before it can render, plus one card to jump to. */
function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  const project: Project = {
    id: 1,
    slug: "todou",
    name: "Todou",
    description: "",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  client.setQueryData(projectQuery("todou").queryKey, project);
  client.setQueryData(projectsQuery.queryKey, [project]);
  client.setQueryData(referenceConfigQuery("todou").queryKey, {
    format: { prefix: "T", history: [] },
    autolinks: [],
  });
  const directory: ReferenceDirectory = {
    since: "2020-01-01T00:00:00.000Z",
    entries: [],
    contested: [],
  };
  client.setQueryData(referenceDirectoryQuery.queryKey, directory);
  client.setQueryData(
    issueRefQuery("todou", 141).queryKey,
    refItem(141, "全文搜索"),
  );
  return client;
}

function renderShellAt(width: number) {
  happyDom.happyDOM.setViewport({ width });
  const client = seeded();
  const rootRoute = createRootRoute();
  const Shell = () => (
    <QueryClientProvider client={client}>
      <AppShell me={me}>x</AppShell>
    </QueryClientProvider>
  );
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: Shell,
    validateSearch: (s: Record<string, unknown>) => s,
  });
  const children = [
    "board",
    "settings",
    "issues/new",
    "issues/$number",
    "search",
  ].map((path) =>
    createRoute({
      getParentRoute: () => projectRoute,
      path,
      component: Shell,
      ...(path === "search"
        ? { validateSearch: (s: Record<string, unknown>) => s }
        : {}),
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute.addChildren(children)]),
    history: createMemoryHistory({ initialEntries: ["/projects/todou"] }),
  });
  return render(<RouterProvider router={router} />);
}

const boxes = (root: ParentNode) => root.querySelectorAll("input[name='q']");
const toggle = (root: ParentNode) =>
  root.querySelector('button[aria-label="Search"]');

afterEach(() => happyDom.happyDOM.setViewport({ width: 1024 }));

describe("the header's search, wide", () => {
  it("seats the box between the two clusters, and folds nothing", async () => {
    const view = renderShellAt(1280);
    await view.findByLabelText("Search this project");

    const row = view.container.querySelector("header > div") as Element;
    const search = row.querySelector("search") as Element;
    expect(search.parentElement).toBe(row);
    const name = row.querySelector('a[href="/projects/todou"]') as Element;
    const inbox = row.querySelector('a[href="/inbox"]') as Element;
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(name, search)).toBe(true);
    expect(follows(search, inbox)).toBe(true);

    expect(toggle(view.container)).toBeNull();
    expect(boxes(view.container)).toHaveLength(1);
  });
});

describe("the header's search, narrow", () => {
  it("offers an icon and no box until it is asked for", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });

    const button = toggle(view.container) as Element;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(boxes(view.container)).toHaveLength(0);
  });

  it("expands into a focused box, with a way back out", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });

    fireEvent.click(toggle(view.container) as Element);
    const input = await view.findByLabelText("Search this project");
    expect(boxes(view.container)).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    expect(
      view.container.querySelector('button[aria-label="Close search"]'),
    ).not.toBeNull();
  });

  it("expands on `/` without going through the icon first", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });

    fireEvent.keyDown(window, { key: "/" });
    const input = await view.findByLabelText("Search this project");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("steps out of the offer first and the overlay second", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });
    fireEvent.click(toggle(view.container) as Element);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "T-141" } });
    await waitFor(() =>
      expect(view.container.querySelector('[role="listbox"]')).not.toBeNull(),
    );

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(view.container.querySelector('[role="listbox"]')).toBeNull(),
    );
    expect(boxes(view.container)).toHaveLength(1);

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(boxes(view.container)).toHaveLength(0));
    expect(toggle(view.container)).not.toBeNull();
  });
});

describe("the header's project row", () => {
  it("carries the tabs and the create button, and no search", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });

    const header = view.container.querySelector("header") as Element;
    const row = header.children[1] as Element;
    const labels = [...row.querySelectorAll("nav a")].map((a) =>
      a.textContent?.trim(),
    );
    expect(labels).toEqual(["List", "Board", "Settings"]);
    expect(row.querySelector('a[aria-label="New issue"]')).not.toBeNull();
    expect(boxes(row)).toHaveLength(0);
  });
});
