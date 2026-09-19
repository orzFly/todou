import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type {
  TimelineComment,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { ProjectLayout } from "../src/pages/project-layout.tsx";
import { cmCount, cmSetValue } from "./cm.ts";
import {
  expectHeaderMeta,
  expectSplitHeader,
  headerRowOf,
} from "./header-meta.ts";
import { testQueryClient } from "./render.tsx";

/**
 * What a comment's header shows before the server has given it an id
 * (T-435), driven through the real page so the `!failed`/`failed` split in
 * issue-detail decides which surface each optimistic comment lands on. A
 * hand-built `CommentItem pending` would assert the same text while proving
 * nothing about that split.
 */

const CREATED = "2026-09-08T10:00:00Z";

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (id: number, body: string): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body,
  component: null,
  created_at: CREATED,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const page = (list: TimelineItem[]): TimelinePage => ({
  items: list,
  prev_cursor: null,
  next_cursor: "c1",
  total_count: list.length,
});

const issue = (number: number) => ({
  id: number,
  number,
  title: `Card ${number}`,
  body: "",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: user,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * The page's replies, with the comment POST under the case's control: a
 * promise it releases by hand is the only way to stand inside the window
 * where a comment is optimistic and nothing has come back yet.
 */
function stubPage() {
  const posts: Array<{
    body: string;
    settle: (outcome: "ok" | "fail") => void;
  }> = [];
  /** Server-side comments, appended when a POST is allowed to succeed. */
  let landed: TimelineComment[] = [];
  let nextId = 900;
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/issues\/\d+\/comments$/.test(url)) {
      const body = String(JSON.parse(String(init?.body ?? "{}")).body ?? "");
      return await new Promise<Response>((resolve) => {
        posts.push({
          body,
          settle: (outcome) => {
            if (outcome === "fail") {
              resolve(new Response("nope", { status: 500 }));
              return;
            }
            const created = comment(nextId++, body);
            landed = [...landed, created];
            resolve(json(created));
          },
        });
      });
    }
    if (method !== "GET") return json(null);
    if (url.endsWith("/api/me")) return json(user);
    if (url.endsWith("/api/projects")) {
      return json([{ id: 1, slug: "p", name: "p" }]);
    }
    if (url.includes("/attachments")) return json([]);
    if (url.includes("/metadata")) return json({ namespaces: {} });
    if (url.includes("/prefs")) return json({});
    if (url.includes("/references/config")) {
      return json({ format: { prefix: "T", history: [] }, autolinks: [] });
    }
    if (url.includes("/reference-directory")) {
      return json({ entries: [], contested: [], slug_entries: [] });
    }
    if (url.includes("/timeline")) return json(page(landed));
    if (/\/issues\/\d+$/.test(url)) {
      return json(issue(Number(/issues\/(\d+)$/.exec(url)?.[1])));
    }
    if (url.endsWith("/labels") || url.endsWith("/statuses")) return json([]);
    if (url.endsWith("/members")) {
      return json([
        { user, role: "writer", created_at: "2026-01-01T00:00:00Z" },
      ]);
    }
    if (/\/projects\/\w+\/read$/.test(url)) return json(null);
    if (url.includes("/projects/p")) {
      return json({ id: 1, slug: "p", name: "p", viewer_role: "writer" });
    }
    return json([]);
  }) as unknown as typeof fetch);
  return posts;
}

function renderPage() {
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
    component: ProjectLayout,
  });
  const issuesRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/$number",
    component: () => (
      <Suspense fallback={<div>loading</div>}>
        <IssueDetailPage />
      </Suspense>
    ),
    staticData: { resolvesProjectMiss: true },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([issuesRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/projects/p/issues/7"] }),
  });
  return {
    ...render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type View = ReturnType<typeof renderPage>;

async function send(view: View, body: string) {
  await waitFor(() => expect(cmCount(view.container)).toBeGreaterThan(0));
  cmSetValue(view.container, body);
  const submit = await waitFor(() => {
    const el = view.container.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    );
    expect(el).not.toBeNull();
    return el as HTMLButtonElement;
  });
  fireEvent.click(submit);
}

/** The rows the timeline is drawing, optimistic ones included. */
const rows = (view: View) => [
  ...view.container.querySelectorAll<HTMLElement>("[data-comment-id]"),
];

const rowFor = (view: View, body: string) =>
  rows(view).find((row) => row.textContent?.includes(body));

describe("an optimistic comment's header (T-435)", () => {
  it("shows the time but no id while two sends are still in flight", async () => {
    const posts = stubPage();
    const view = renderPage();

    await send(view, "first unsent");
    await waitFor(() => expect(posts).toHaveLength(1));
    await send(view, "second unsent");
    await waitFor(() => expect(posts).toHaveLength(2));

    const pending = await waitFor(() => {
      const found = rows(view).filter((row) =>
        row.textContent?.includes("unsent"),
      );
      expect(found).toHaveLength(2);
      return found;
    });

    // The composer mints `-1 - key`, so the second temporary id is not -1.
    // A pending check written as `id === -1` would give this row a permalink
    // to `#comment--2`.
    const ids = pending.map((row) => Number(row.dataset.commentId));
    expect(ids.every((id) => id < 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(Math.min(...ids)).toBeLessThan(-1);

    for (const row of pending) {
      expect(row.textContent).toContain("sending…");
      // The creation time is there, absolute and machine-readable…
      const time = row.querySelector("time");
      expect(time?.getAttribute("datetime")).toBeTruthy();
      expect(time?.textContent).toBe(
        new Date(time?.getAttribute("datetime") as string).toLocaleString(),
      );
      // …and nothing that would pretend the comment already has an address.
      expect(row.textContent).not.toContain("#comment-");
      expect(row.querySelector("a[href*='#comment-']")).toBeNull();
      expect(row.id).toBe("");
      expect(row.querySelector(".select-all")).toBeNull();
    }
  });

  it("hands a failed send to the composer without a header of its own", async () => {
    const posts = stubPage();
    const view = renderPage();

    await send(view, "doomed send");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(rowFor(view, "doomed send")).toBeDefined();

    posts[0]?.settle("fail");

    const failure = await waitFor(() => {
      const el = view.getByText(/Failed to send: doomed send/);
      return el.closest("div") as HTMLElement;
    });
    // It left the timeline: `issue-detail` sends only `!failed` there.
    expect(rowFor(view, "doomed send")).toBeUndefined();
    // And the row it landed on is the composer's own, not a comment header.
    expect(within(failure).getByText("Retry")).toBeTruthy();
    expect(failure.textContent).not.toContain("#comment-");
    expect(failure.querySelector("time")).toBeNull();
    expect(failure.querySelector("a[href*='#comment-']")).toBeNull();
    expect(failure.closest("[data-comment-id]")).toBeNull();
  });

  it("gives the comment a real id only once Retry has landed it", async () => {
    const posts = stubPage();
    const view = renderPage();

    await send(view, "retried send");
    await waitFor(() => expect(posts).toHaveLength(1));
    posts[0]?.settle("fail");
    const retry = await waitFor(() =>
      within(
        view
          .getByText(/Failed to send: retried send/)
          .closest("div") as HTMLElement,
      ).getByText("Retry"),
    );

    fireEvent.click(retry);

    // Back to pending: in the timeline again, still with no id of its own.
    await waitFor(() => expect(posts).toHaveLength(2));
    const again = await waitFor(() => {
      const row = rowFor(view, "retried send");
      expect(row).toBeDefined();
      return row as HTMLElement;
    });
    expect(again.textContent).toContain("sending…");
    expect(again.textContent).not.toContain("#comment-");

    posts[1]?.settle("ok");

    // The refetch replaces it with the server's comment, and only now does a
    // header carry the short id and a permalink.
    const settled = await waitFor(() => {
      const row = rowFor(view, "retried send");
      expect(row?.id).toBe("comment-900");
      return row as HTMLElement;
    });
    expectHeaderMeta(settled, "/projects/p/issues/7#comment-900", 900, CREATED);
    expect(settled.textContent).not.toContain("sending…");
    expect(view.queryByText(/Failed to send/)).toBeNull();
  });
});

/**
 * The optimistic branch draws its own `sending…` where a settled comment
 * draws the action group, so the narrow-screen split (T-445) has to reach
 * it separately — one branch of one call site, and the only one whose
 * right-hand column is a word rather than a control.
 */
describe("an optimistic comment's narrow-screen shape (T-445)", () => {
  it("puts `sending…` where the actions would be", async () => {
    const posts = stubPage();
    const view = renderPage();

    await send(view, "still unsent");
    await waitFor(() => expect(posts).toHaveLength(1));

    const pending = await waitFor(() => {
      const row = rowFor(view, "still unsent");
      expect(row?.textContent).toContain("sending…");
      return row as HTMLElement;
    });
    const row = headerRowOf(pending);
    expectSplitHeader(row, {
      identity: ["User"],
      actions: [
        [...row.children].find((child) => child.textContent === "sending…"),
      ],
    });
  });
});
