import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { IssueListItem, TimelineEvent } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { EventRow } from "../src/components/timeline/event-row.tsx";
import { splitIssueRefs } from "../src/lib/issue-refs.ts";

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
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
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
});

/**
 * IssueLink needs a live router for <Link>; a shim tree with just the
 * issue-detail path keeps these component tests off the full app router.
 */
function renderWithProviders(ui: ReactElement, client: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
  });
  const issueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute]),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function seededClient(slug: string, items: IssueListItem[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const item of items) {
    client.setQueryData(issueRefQuery(slug, item.number).queryKey, item);
  }
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitIssueRefs", () => {
  it("splits text around #N tokens", () => {
    expect(splitIssueRefs("see #12 and #3.")).toEqual([
      { type: "text", value: "see " },
      { type: "ref", number: 12, text: "#12" },
      { type: "text", value: " and " },
      { type: "ref", number: 3, text: "#3" },
      { type: "text", value: "." },
    ]);
  });
  it("mirrors the server rule: no refs inside words", () => {
    expect(splitIssueRefs("channel#4chat")).toEqual([
      { type: "text", value: "channel#4chat" },
    ]);
  });
  it("matches at the start of text", () => {
    expect(splitIssueRefs("#7 first")).toEqual([
      { type: "ref", number: 7, text: "#7" },
      { type: "text", value: " first" },
    ]);
  });
});

describe("MarkdownView issue refs", () => {
  it("links #N in prose but not in code blocks or inline code", async () => {
    const client = seededClient("todou", [refItem(5, "Ref target")]);
    const body = "Fixes #5 via `#6` and:\n\n```\nignore #7\n```\n";
    const view = renderWithProviders(
      <MarkdownView slug="todou">{body}</MarkdownView>,
      client,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='5']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/5");
    expect(link.textContent).toContain("Ref target");
    expect(link.textContent).toContain("#5");

    // The exemptions: #6 and #7 stay literal text inside code elements.
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
    const codes = [...view.container.querySelectorAll("code")];
    expect(codes.some((c) => c.textContent?.includes("#6"))).toBe(true);
    expect(codes.some((c) => c.textContent?.includes("#7"))).toBe(true);
  });

  it("renders no links without a slug", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MarkdownView>{"see #5"}</MarkdownView>
      </QueryClientProvider>,
    );
    expect(view.container.querySelector("a")).toBeNull();
  });
});

describe("EventRow issue refs", () => {
  const event: TimelineEvent = {
    type: "event",
    id: 1,
    event_type: "referenced",
    actor: {
      id: 1,
      login: "user",
      display_name: "User",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    agent_context: null,
    payload: { by_issue: 3 },
    created_at: "2026-08-12T00:00:00Z",
  };

  it("links #N in the action text when a slug is given", async () => {
    const client = seededClient("todou", [refItem(3, "Source issue")]);
    const view = renderWithProviders(
      <EventRow event={event} slug="todou" />,
      client,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='3']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/todou/issues/3");
    expect(link.textContent).toContain("Source issue");
  });

  it("stays plain text without a slug", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <EventRow event={event} />
      </QueryClientProvider>,
    );
    expect(view.container.querySelector("a")).toBeNull();
    expect(view.container.textContent).toContain("referenced by #3");
  });
});

describe("issue ref batching", () => {
  it("coalesces refs requested in the same tick into one request", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (input: unknown) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          items: [refItem(5, "Five"), refItem(9, "Nine")],
          next_cursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const [five, nine, missing] = await Promise.all([
      client.fetchQuery(issueRefQuery("todou", 5)),
      client.fetchQuery(issueRefQuery("todou", 9)),
      client.fetchQuery(issueRefQuery("todou", 999)),
    ]);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("numbers=5%2C9%2C999");
    expect(five?.title).toBe("Five");
    expect(nine?.title).toBe("Nine");
    expect(missing).toBeNull();
  });
});
