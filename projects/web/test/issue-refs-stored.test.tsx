import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  Project,
  ReferenceConfig,
  ReferenceDirectory,
} from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { projectsQuery } from "../src/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";

const config: ReferenceConfig = {
  format: { prefix: null, history: [] },
  autolinks: [],
};

const DIRECTORY: ReferenceDirectory = { entries: [], contested: [] };
afterEach(() => vi.unstubAllGlobals());

const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
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
  blocked_by: [],
  blocks: [],
  moves: [],
});

/** Projects 1 and 2 are readable; 9 is not in the viewer's directory. */
function seed(queries: QueryClient): QueryClient {
  queries.setQueryData<ReferenceDirectory>(
    referenceDirectoryQuery.queryKey,
    DIRECTORY,
  );
  queries.setQueryData(
    projectsQuery.queryKey,
    ["a", "b"].map(
      (slug, index): Project => ({
        id: index + 1,
        slug,
        name: slug,
        description: "",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ),
  );
  queries.setQueryData(referenceConfigQuery("a").queryKey, config);
  queries.setQueryData(referenceConfigQuery("b").queryKey, config);
  return queries;
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

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const anchor = async (
  view: ReturnType<typeof render>,
  number: number,
): Promise<HTMLAnchorElement> =>
  waitFor(() => {
    const el = view.container.querySelector(`a[data-issue-link='${number}']`);
    expect(el).not.toBeNull();
    return el as HTMLAnchorElement;
  });

/**
 * How a stored reference renders (T-266). The document holds an explicit
 * link onto a project id; the reader turns that id back into the slug it
 * answers to today and decorates the link with the card behind it.
 */
describe("stored id-anchored references", () => {
  it("decorates an id link and points it at the project's current slug", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/1/issues/12)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12");
    expect(link.textContent).toContain("A's");
  });

  it("spells a link into another project self-containedly", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("b", 12).queryKey, refItem(12, "B's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [b#12](/projects/2/issues/12)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/b/issues/12");
    expect(link.getAttribute("data-issue-project")).toBe("b");
  });

  it("leaves a link into a project the reader cannot name alone", async () => {
    const queries = seed(client());

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/9/issues/12)"}
      </MarkdownView>,
      queries,
    );

    await waitFor(() => expect(view.container.textContent).toContain("#12"));
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/projects/9/issues/12");
    expect(link?.getAttribute("data-issue-link")).toBeNull();
  });

  it("points at the card's current address, so a click spends no redirect", async () => {
    const queries = seed(client());
    const moved: ResolvedIssueRef = {
      ...refItem(45, "Landed"),
      at: { slug: "b", number: 45 },
    };
    queries.setQueryData(issueRefQuery("a", 12).queryKey, moved);

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12](/projects/1/issues/12)"}
      </MarkdownView>,
      queries,
    );

    // The attributes sit next to the href and describe the link that was
    // rendered, so after a move they name the new address too (T-274).
    const link = await anchor(view, 45);
    expect(link.getAttribute("href")).toBe("/projects/b/issues/45");
    expect(link.getAttribute("data-issue-project")).toBe("b");
  });

  it("carries a confirmed comment anchor into the link", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));
    queries.setQueryData<ResolvedCommentRef | null>(
      commentRefQuery("a", 12, 7).queryKey,
      () => ({
        type: "comment",
        id: 7,
        author: user,
        body: "hello",
        created_at: "2026-01-01T00:00:00.000Z",
        edited_at: null,
        resolved_at: null,
        hidden_at: null,
        component: null,
        agent_context: null,
        at: { slug: "a", number: 12, commentId: 7 },
      }),
    );

    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"see [#12#comment-7](/projects/1/issues/12#comment-7)"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12#comment-7");
    expect(link.getAttribute("data-comment-link")).toBe("7");
    expect(link.querySelector("[data-comment-ref]")?.textContent).toBe(
      "#12#comment-7",
    );
    expect(link.querySelector("[data-comment-author]")?.textContent).toBe(
      " · by User",
    );
  });
});

describe("unconfirmed stored references", () => {
  const source = "/projects/1/issues/12#comment-7";
  const markdown = `[**careful** and \`literal\` comment by Alice](${source})`;

  it("keeps exact href and complex children when the comment is missing or belongs to another issue", async () => {
    for (const target of [
      null,
      {
        type: "comment" as const,
        id: 7,
        author: user,
        body: "other",
        created_at: "2026-01-01T00:00:00.000Z",
        edited_at: null,
        resolved_at: null,
        hidden_at: null,
        component: null,
        agent_context: null,
        at: { slug: "b", number: 44, commentId: 7 },
      },
    ]) {
      const queries = seed(client());
      queries.setQueryData(
        issueRefQuery("a", 12).queryKey,
        refItem(12, "Title must not leak"),
      );
      queries.setQueryData<ResolvedCommentRef | null>(
        commentRefQuery("a", 12, 7).queryKey,
        target,
      );
      const view = renderWithProviders(
        <MarkdownView slug="a">{markdown}</MarkdownView>,
        queries,
      );
      const link = await waitFor(() => {
        const el = view.container.querySelector("a[href]");
        expect(el).not.toBeNull();
        return el as HTMLAnchorElement;
      });
      expect(link.getAttribute("href")).toBe(source);
      expect(link.querySelector("strong")?.textContent).toBe("careful");
      expect(link.querySelector("code")?.textContent).toBe("literal");
      expect(link.textContent).toBe("careful and literal comment by Alice");
      expect(link.querySelector("[data-comment-ref]")).toBeNull();
      expect(link.querySelector("[data-comment-author]")).toBeNull();
      expect(link.getAttribute("data-issue-link")).toBeNull();
      expect(link.getAttribute("title")).toBeNull();
      expect(link.querySelector("svg")).toBeNull();
      expect(link.textContent).not.toContain("Title must not leak");
      view.unmount();
    }
  });

  it("keeps the original anchor during a delayed comment request, then enriches it", async () => {
    const queries = seed(client());
    queries.setQueryData(
      issueRefQuery("a", 12).queryKey,
      refItem(12, "Confirmed title"),
    );
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/comments/7")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    const view = renderWithProviders(
      <MarkdownView slug="a">{markdown}</MarkdownView>,
      queries,
    );
    await waitFor(() => expect(release).toBeDefined());
    const pending = view.container.querySelector(
      "a[href]",
    ) as HTMLAnchorElement;
    expect(pending.getAttribute("href")).toBe(source);
    expect(pending.getAttribute("data-issue-link")).toBeNull();
    expect(pending.textContent).toBe("careful and literal comment by Alice");
    expect(pending.querySelector("strong")?.textContent).toBe("careful");
    expect(pending.querySelector("code")?.textContent).toBe("literal");
    expect(pending.querySelector("[data-comment-ref]")).toBeNull();
    release?.(
      new Response(
        JSON.stringify({
          type: "comment",
          id: 7,
          author: user,
          body: "confirmed",
          created_at: "2026-01-01T00:00:00.000Z",
          edited_at: null,
          resolved_at: null,
          hidden_at: null,
          component: null,
          agent_context: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const rich = await anchor(view, 12);
    expect(rich.textContent).toContain("Confirmed title");
    const token = rich.querySelector("[data-comment-ref]");
    const author = rich.querySelector("[data-comment-author]");
    expect(token?.textContent).toBe("#12#comment-7");
    expect(author?.textContent).toBe(" · by User");
    expect(token?.contains(author)).toBe(false);
    expect(rich.getAttribute("href")).toBe("/projects/a/issues/12#comment-7");
    expect(rich.getAttribute("data-comment-link")).toBe("7");
  });

  it("preserves an explicit invalid link even after its issue lookup fails", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 999).queryKey, null);
    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"[**exact** and `code`](/projects/1/issues/999)"}
      </MarkdownView>,
      queries,
    );
    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("/projects/1/issues/999");
    expect(link.querySelector("strong")?.textContent).toBe("exact");
    expect(link.querySelector("code")?.textContent).toBe("code");
    expect(link.getAttribute("data-issue-link")).toBeNull();
    expect(link.getAttribute("title")).toBeNull();
    expect(link.querySelector("svg")).toBeNull();
  });

  it("never enriches an issue during a pending or failed lookup", async () => {
    const queries = seed(client());
    let releaseList: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", (async (input: unknown) => {
      if (String(input).includes("numbers=")) {
        return new Promise<Response>((resolve) => {
          releaseList = resolve;
        });
      }
      return new Response(JSON.stringify({ error: { code: "failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    const view = renderWithProviders(
      <MarkdownView slug="a">
        {"[**written**](/projects/1/issues/12)"}
      </MarkdownView>,
      queries,
    );
    await waitFor(() => expect(releaseList).toBeDefined());
    const assertOrdinary = () => {
      const link = view.container.querySelector(
        "a[href='/projects/1/issues/12']",
      );
      expect(link?.querySelector("strong")?.textContent).toBe("written");
      expect(link?.getAttribute("data-issue-link")).toBeNull();
      expect(link?.getAttribute("title")).toBeNull();
      expect(link?.querySelector("svg")).toBeNull();
    };
    assertOrdinary();
    releaseList?.(
      new Response(JSON.stringify({ error: { code: "failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() =>
      expect(
        queries.getQueryState(issueRefQuery("a", 12).queryKey)?.status,
      ).toBe("error"),
    );
    assertOrdinary();
  });

  it("never partially enriches an issue while its comment lookup errors", async () => {
    const queries = seed(client());
    queries.setQueryData(
      issueRefQuery("a", 12).queryKey,
      refItem(12, "Parent title"),
    );
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ error: { code: "failed" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    const view = renderWithProviders(
      <MarkdownView slug="a">{markdown}</MarkdownView>,
      queries,
    );
    await waitFor(() =>
      expect(
        queries.getQueryState(commentRefQuery("a", 12, 7).queryKey)?.status,
      ).toBe("error"),
    );
    const link = view.container.querySelector("a[href]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(source);
    expect(link.querySelector("strong")?.textContent).toBe("careful");
    expect(link.querySelector("code")?.textContent).toBe("literal");
    expect(link.textContent).toBe("careful and literal comment by Alice");
    expect(link.querySelector("[data-comment-ref]")).toBeNull();
    expect(link.getAttribute("data-issue-link")).toBeNull();
    expect(link.textContent).not.toContain("Parent title");
  });

  it("probes an unknown numeric project id and uses only a confirmed moved destination", async () => {
    const queries = seed(client());
    queries.setQueryData(projectsQuery.queryKey, []);
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      if (url.includes("numbers=")) {
        return new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/projects/9/issues/12")) {
        return new Response(
          JSON.stringify({ moved_to: { slug: "b", number: 45 } }),
          {
            status: 301,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/projects/b/issues/45")) {
        return new Response(
          JSON.stringify({ ...refItem(45, "Final card"), body: "" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
    const view = renderWithProviders(
      <MarkdownView slug="a">{"[#12](/projects/9/issues/12)"}</MarkdownView>,
      queries,
    );
    const link = await anchor(view, 45);
    expect(link.getAttribute("href")).toBe("/projects/b/issues/45");
    expect(link.textContent).toContain("Final card");
  });
});

/**
 * What reading mode does with a bare token. Nothing: a token still sitting
 * in stored text is one the resolve pass could not place, and drawing it as
 * a link would put the guess back that T-266 removes.
 */
describe("bare tokens in stored text", () => {
  it("renders a bare ref as plain text", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a">{"see #12"}</MarkdownView>,
      queries,
    );

    await waitFor(() =>
      expect(view.container.textContent).toContain("see #12"),
    );
    expect(view.container.querySelectorAll("a")).toHaveLength(0);
  });

  it("still expands an external autolink", async () => {
    const queries = seed(client());
    queries.setQueryData(referenceConfigQuery("a").queryKey, {
      format: { prefix: null, history: [] },
      autolinks: [
        {
          id: 1,
          prefix: "JIRA-",
          url_template: "https://tracker.example/<num>",
        },
      ],
    } satisfies ReferenceConfig);

    const view = renderWithProviders(
      <MarkdownView slug="a">{"fixes JIRA-42"}</MarkdownView>,
      queries,
    );

    const link = await waitFor(() => {
      const el = view.container.querySelector("a");
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    expect(link.getAttribute("href")).toBe("https://tracker.example/42");
    expect(link.textContent).toBe("JIRA-42");
  });

  it("highlights a bare ref in an editor preview", async () => {
    const queries = seed(client());
    queries.setQueryData(issueRefQuery("a", 12).queryKey, refItem(12, "A's"));

    const view = renderWithProviders(
      <MarkdownView slug="a" preview>
        {"see #12"}
      </MarkdownView>,
      queries,
    );

    const link = await anchor(view, 12);
    expect(link.getAttribute("href")).toBe("/projects/a/issues/12");
  });
});
