import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type { IssueListItem, Member } from "@todou/shared";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { membersQuery } from "../src/api/queries.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";

/**
 * Two members, one of whom has renamed since the stored text was written:
 * whatever the chip shows for `/users/7` is the CURRENT login, not the link
 * text's spelling.
 */
const members: Member[] = [
  {
    user: {
      id: 7,
      login: "alicia",
      display_name: "Alicia Recent",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
    owner_role: null,
  },
  {
    user: {
      id: 8,
      login: "bot-one",
      display_name: "A Bot",
      kind: "machine",
      avatar_url: null,
      owner: { id: 7, login: "alicia" },
    },
    role: "writer",
    created_at: "2026-01-01T00:00:00Z",
    owner_role: "admin",
  },
];

function seededClient(known: Member[] = members): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(membersQuery("a").queryKey, known);
  return client;
}

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
  const userRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/users/$ref",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      projectRoute.addChildren([issueRoute]),
      userRoute,
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const refItem = (number: number): IssueListItem => ({
  id: number,
  number,
  title: `issue ${number}`,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
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
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
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
  moves: [],
});
void refItem;

describe("stored mentions render (T-373)", () => {
  it("shows the member's current login, linked to their page", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="a">{"see [@alice](/users/7)"}</MarkdownView>,
      seededClient(),
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-mention-link='7']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    // Current login, not the author's stored spelling.
    expect(link.textContent).toContain("@alicia");
    expect(link.getAttribute("href")).toBe("/users/alicia");
  });

  it("falls back to the typed spelling for an unknown member", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="a">{"see [@alice](/users/9)"}</MarkdownView>,
      seededClient(),
    );
    await waitFor(() =>
      expect(view.container.textContent).toContain("see @alice"),
    );
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("leaves a bare @ in stored text as text (T-266's rule)", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="a">{"see @alicia"}</MarkdownView>,
      seededClient(),
    );
    await waitFor(() =>
      expect(view.container.textContent).toContain("see @alicia"),
    );
    expect(view.container.querySelectorAll("a")).toHaveLength(0);
  });

  it("renders a draft's bare @ as a chip in preview mode", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="a" preview>
        {"see @alicia"}
      </MarkdownView>,
      seededClient(),
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a[data-mention-link='7']");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/users/alicia");
  });

  it("marks a machine account with the bot badge", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="a">{"see [@bot-one](/users/8)"}</MarkdownView>,
      seededClient(),
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-mention-link='8']"),
      ).not.toBeNull();
    });
    // UserAvatar's badge renders an icon with the aria-label "agent".
    expect(view.container.querySelector("[aria-label='agent']")).not.toBeNull();
  });
});
