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
  Label,
  Me,
  Project,
  ReferenceDirectory,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import {
  labelsQuery,
  meQuery,
  projectQuery,
  projectsQuery,
} from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { AppShell } from "../src/components/shell.tsx";
import { historyKey, readHistory } from "../src/lib/search-history.ts";
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
  moves: [],
});

/** Everything the header reads before it can render, plus one card to jump to. */
function seeded(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(["auth-mode"], { mode: "single" });
  client.setQueryData(meQuery.queryKey, me);
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
  return { ...render(<RouterProvider router={router} />), client, router };
}

const boxes = (root: ParentNode) => root.querySelectorAll("input[name='q']");
const toggle = (root: ParentNode) =>
  root.querySelector('button[aria-label="Search"]');

/** Both rows are always in the DOM; which one is shown is CSS, and there is none here. */
function rows(view: { container: HTMLElement }) {
  const header = view.container.querySelector("header") as Element;
  return { first: header.children[0], project: header.children[1] };
}

afterEach(() => {
  happyDom.happyDOM.setViewport({ width: 1024 });
  localStorage.clear();
});

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
    // Where the icon was, not the row above it: the box has to open in place.
    expect(boxes(rows(view).project)).toHaveLength(1);
    expect(boxes(rows(view).first)).toHaveLength(0);
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

/**
 * T-215's jump row meeting T-231's tombstones. `useJumpRows` resolves a card
 * through the same `issueRefQuery` batcher <IssueLink> uses, so the probe that
 * turns a moved card's ref into a live one is inherited rather than repeated —
 * this pins that it is still shared. The row keeps the address the reader
 * typed, which is the tombstone, and the tombstone is what redirects; only the
 * title comes from where the card actually lives now.
 */
describe("the header's search, a card that moved away", () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("offers the card at its old address, titled from the new one", async () => {
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      // The list excludes tombstones, so 123 comes back a miss.
      if (url.includes("numbers=")) {
        return json({ items: [], next_cursor: null });
      }
      if (url.includes("/projects/todou/issues/123")) {
        return json({ moved_to: { slug: "b", number: 45 } }, 301);
      }
      if (url.includes("/projects/b/issues/45")) {
        return json({ ...refItem(45, "Landed in B"), body: "" });
      }
      return json({ error: { code: "not_found", message: "no" } }, 404);
    }) as typeof fetch);

    const view = renderShellAt(1280);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "T-123" } });

    const row = await waitFor(() => {
      const found = view.container.querySelector(
        '[role="listbox"] a[href="/projects/todou/issues/123"]',
      );
      if (found === null) throw new Error("no jump row yet");
      return found;
    });
    expect(row.textContent).toContain("Landed in B");
  });
});

describe("the header's project row", () => {
  it("carries the tabs, then the search, then the create button", async () => {
    const view = renderShellAt(390);
    await view.findAllByRole("link", { name: "List" });
    const { first, project } = rows(view);

    const labels = [...project.querySelectorAll("nav a")].map((a) =>
      a.textContent?.trim(),
    );
    expect(labels).toEqual(["List", "Board", "Settings"]);
    // The search is this project's, so it keeps the project's own company
    // rather than the account cluster's.
    const icon = toggle(project) as Element;
    expect(icon).not.toBeNull();
    expect(toggle(first)).toBeNull();
    const create = project.querySelector(
      'a[aria-label="New issue"]',
    ) as Element;
    expect(
      icon.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(boxes(project)).toHaveLength(0);
  });

  it("gives the icon back to the first row once there is no project row", async () => {
    // 640–767: one row, so the account cluster is the only place left — and
    // the icon still lands immediately before the create button there.
    const view = renderShellAt(700);
    await view.findAllByRole("link", { name: "List" });
    const { first, project } = rows(view);

    const icon = toggle(first) as Element;
    expect(icon).not.toBeNull();
    expect(toggle(project)).toBeNull();
    const create = first.querySelector('a[aria-label="New issue"]') as Element;
    expect(
      icon.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(boxes(view.container)).toHaveLength(0);
  });
});

const NOW = Date.parse("2026-09-05T12:00:00Z");

function seedHistory(entries: string[], slug = "todou") {
  localStorage.setItem(
    historyKey(me.id),
    JSON.stringify({
      [slug]: entries.map((q, i) => ({ q, t: NOW - i * 1000 })),
    }),
  );
}

const remembered = (slug = "todou") =>
  (readHistory(me.id)[slug] ?? []).map((e) => e.q);

type View = { container: HTMLElement };
const panel = (view: View) => view.container.querySelector('[role="listbox"]');
const options = (view: View) => [
  ...(panel(view)?.querySelectorAll('[role="option"]') ?? []),
];
const historyRows = (view: View) =>
  options(view).filter((o) => o.querySelector('button[aria-label^="Forget"]'));

async function openedOn(entries: string[]) {
  seedHistory(entries);
  const view = renderShellAt(1280);
  const input = (await view.findByLabelText(
    "Search this project",
  )) as HTMLInputElement;
  fireEvent.focusIn(input);
  await waitFor(() =>
    expect(historyRows(view)).toHaveLength(Math.min(entries.length, 13)),
  );
  return { view, input };
}

describe("the search box's own history", () => {
  it("fills a focused empty box with history, the search page, then the keys", async () => {
    const { view, input } = await openedOn(["label:area:web", "补全 面板"]);

    const texts = options(view).map((o) => o.textContent);
    expect(texts.slice(0, 2)).toEqual(["label:area:web", "补全 面板"]);
    expect(texts[2]).toContain("search page");
    // The full key table is the only place the syntax can be discovered, so
    // it is what history is not allowed to push out.
    expect(texts.slice(3)).toHaveLength(7);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("takes what the key list leaves and no more", async () => {
    const { view } = await openedOn(
      Array.from({ length: 20 }, (_, i) => `查询 ${i}`),
    );
    expect(historyRows(view)).toHaveLength(13);
    expect(options(view)).toHaveLength(21);
    expect(options(view).slice(14)).toHaveLength(7);
  });

  it("stands aside entirely once the completions have spent the budget", async () => {
    seedHistory(["bug"]);
    const view = renderShellAt(1280);
    const labels: Label[] = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `label-${i}`,
      color: "#3b82f6",
    }));
    view.client.setQueryData(labelsQuery("todou").queryKey, labels);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "label:" } });

    await waitFor(() => expect(options(view)).toHaveLength(21));
    expect(historyRows(view)).toHaveLength(0);
  });

  it("lifts a prefix hit above the search row and leaves a substring below", async () => {
    seedHistory(["补全 面板 排序", "搜索框 补全"]);
    const view = renderShellAt(1280);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "补全" } });

    await waitFor(() => expect(historyRows(view)).toHaveLength(2));
    const texts = options(view).map((o) => o.textContent);
    expect(texts[0]).toBe("补全 面板 排序");
    expect(texts[1]).toContain("Search for");
    expect(texts[2]).toBe("搜索框 补全");
  });

  it("runs the remembered search, and moves that entry back to the front", async () => {
    const { view } = await openedOn(["bug", "spec"]);

    const link = historyRows(view)[1]?.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/projects/todou/search?q=spec");
    fireEvent.click(link);

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/projects/todou/search",
      ),
    );
    expect(remembered()).toEqual(["spec", "bug"]);
  });

  it("loads a highlighted entry back into the box on Tab", async () => {
    const { view, input } = await openedOn(["label:area:web"]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => expect(input.value).toBe("label:area:web"));
    expect(input.selectionStart).toBe("label:area:web".length);
    expect(view.router.state.location.pathname).toBe("/projects/todou");
  });

  it("forgets the highlighted entry on Shift+Delete, panel still open", async () => {
    const { view, input } = await openedOn(["bug", "spec"]);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Delete", shiftKey: true });

    await waitFor(() => expect(historyRows(view)).toHaveLength(1));
    expect(panel(view)).not.toBeNull();
    expect(remembered()).toEqual(["spec"]);
  });

  it("forgets an entry from its own button, and goes nowhere", async () => {
    const { view } = await openedOn(["bug", "spec"]);

    const button = historyRows(view)[0]?.querySelector(
      "button",
    ) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(historyRows(view)).toHaveLength(1));
    expect(remembered()).toEqual(["spec"]);
    expect(view.router.state.location.pathname).toBe("/projects/todou");
  });

  it("remembers a query as it is submitted", async () => {
    const view = renderShellAt(1280);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "全文搜索" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(remembered()).toEqual(["全文搜索"]));
  });

  it("remembers nothing about an input that turned out to be a jump", async () => {
    // A ref is navigation, not a search: `T-141` is quicker to retype than to
    // find, and the card has better ways back.
    const view = renderShellAt(1280);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);
    fireEvent.change(input, { target: { value: "T-141" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        "/projects/todou/issues/141",
      ),
    );
    expect(readHistory(me.id)).toEqual({});
  });

  it("keeps one project's history out of another's box", async () => {
    seedHistory(["theirs"], "accel");
    const view = renderShellAt(1280);
    const input = await view.findByLabelText("Search this project");
    fireEvent.focusIn(input);

    await waitFor(() => expect(panel(view)).not.toBeNull());
    expect(historyRows(view)).toHaveLength(0);
  });
});
